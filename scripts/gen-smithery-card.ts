#!/usr/bin/env node
// Generates the Smithery server card at dist/smithery-server-card.json, mirroring
// obsidian-tc's packages/server/scripts/gen-smithery-server-card.ts (THE-966).
//
// WHY THIS EXISTS. `smithery mcp publish <bundle>.mcpb` only forwards the MCPB manifest's `tools`
// array into the registry, and that array cannot carry `inputSchema` (upstream
// smithery-cli#787, open since July 2026) - a listing built through the CLI alone shows
// "No capabilities found" and scores 0 on Smithery's Capability Quality metric (see
// docs/superpowers/plans/2026-09-03-listings/smithery.md in obsidian-tc for the full thread).
// The registry API's deploy payload instead accepts a `serverCard` with full MCP-shaped tools
// (`inputSchema` included), so scripts/publish-smithery.ts sends one directly.
//
// UNLIKE obsidian-tc: that server exposes only three facade tools (find_capability,
// describe_capability, call_capability) built by a pure `triadTools()` function with no runtime
// wiring, so its generator calls that function directly. Alexandria has no such facade - its
// eleven tools, three prompts, and one resource template are registered inline on a real
// `McpServer` inside `createServer()` (src/index.ts), built from live source-registry state
// (`listSources().length` appears in several tool descriptions). Rather than hand-copy those
// schemas into a second, driftable source of truth, this script connects an in-process MCP
// `Client` to a real `createServer()` instance over `InMemoryTransport` - the exact pattern
// src/prompts.test.ts and src/resources.test.ts already use - and calls `listTools()` /
// `listPrompts()` / `listResourceTemplates()`, so the card can never advertise a schema the live
// server does not.
//
// `buildServerCard` is exported and side-effect-free aside from the in-memory client/server pair
// it creates and tears down, so scripts/gen-smithery-card.test.ts can assert on its output shape.
//
// usage:
//   node scripts/gen-smithery-card.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../src/index.ts';

export interface ServerCardInputs {
  /** This repo's own package.json `name` + `version`. */
  serverPkg: { name: string; version: string };
  /** The repo-root MCP registry manifest (server.json) - `description` + `title`. */
  mcpServerJson: { description: string; title?: string };
}

/**
 * Builds the Smithery server card from the server's real, live tool/prompt/resource-template
 * definitions - see the module header for why this connects a real MCP client/server pair rather
 * than hand-copying schemas.
 */
export async function buildServerCard({ serverPkg, mcpServerJson }: ServerCardInputs) {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'gen-smithery-card', version: '1.0.0' });
  await server.server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const [{ tools }, { prompts }, { resourceTemplates }] = await Promise.all([
      client.listTools(),
      client.listPrompts(),
      client.listResourceTemplates(),
    ]);
    return {
      serverInfo: {
        name: serverPkg.name,
        version: serverPkg.version,
        description: mcpServerJson.description,
        title: mcpServerJson.title,
        websiteUrl: 'https://github.com/The-40-Thieves/alexandria-mcp',
      },
      tools,
      prompts,
      resources: resourceTemplates,
    };
  } finally {
    await client.close();
  }
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO_ROOT, 'dist', 'smithery-server-card.json');

async function main(): Promise<void> {
  const serverPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const mcpServerJson = JSON.parse(readFileSync(join(REPO_ROOT, 'server.json'), 'utf8'));
  const serverCard = await buildServerCard({ serverPkg, mcpServerJson });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(serverCard, null, 2)}\n`);
  console.log(
    `\n✓ wrote ${OUT} (${serverCard.tools.length} tools, ${serverCard.prompts.length} prompts, ${serverCard.resources.length} resources)`,
  );
}

// Importing this module (as its test file does) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
