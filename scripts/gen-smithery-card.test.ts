// Tests for scripts/gen-smithery-card.ts. `buildServerCard` connects a real in-process MCP
// client to a real `createServer()` instance (see the script's own module header for why), so
// these assertions are against the server's ACTUAL live tools/prompts/resource-template, never a
// hand-typed fixture list — the same reason obsidian-tc's
// packages/server/test/smithery-server-card.test.ts asserts tool count via a shared constant
// rather than a literal.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_COUNT } from '../src/toolCount.ts';
import { buildServerCard } from './gen-smithery-card.ts';

const FIXTURE_INPUTS = {
  serverPkg: { name: '@the-40-thieves/alexandria-mcp', version: '11.0.0' },
  mcpServerJson: {
    description:
      'Search, read, and cite across 152 libraries: 11 tools, 3 prompts, and a full-text resource.',
    title: 'Alexandria',
  },
};

test('buildServerCard', async (t) => {
  const card = await buildServerCard(FIXTURE_INPUTS);

  await t.test('carries serverInfo from the fixture inputs, plus the fixed websiteUrl', () => {
    assert.deepEqual(card.serverInfo, {
      name: '@the-40-thieves/alexandria-mcp',
      version: '11.0.0',
      description: FIXTURE_INPUTS.mcpServerJson.description,
      title: 'Alexandria',
      websiteUrl: 'https://github.com/The-40-Thieves/alexandria-mcp',
    });
  });

  await t.test(
    'advertises at least TOOL_COUNT tools — README claims 11, verified against the live registry, not a hand-typed number',
    () => {
      assert.ok(
        card.tools.length >= TOOL_COUNT,
        `expected at least ${TOOL_COUNT} tools, got ${card.tools.length}`,
      );
      assert.equal(TOOL_COUNT, 11, 'sanity check: TOOL_COUNT itself should read 11 today');
    },
  );

  await t.test(
    "every tool carries a JSON-Schema object inputSchema (the registry API's own requirement)",
    () => {
      assert.ok(card.tools.length > 0);
      for (const tool of card.tools) {
        assert.ok(tool.inputSchema, `${tool.name}: no inputSchema`);
        assert.equal((tool.inputSchema as { type?: string }).type, 'object');
      }
    },
  );

  await t.test('carries the three research-workflow prompts', () => {
    assert.deepEqual(card.prompts.map((p) => p.name).sort(), [
      'fact_check_claim',
      'literature_review',
      'verify_bibliography',
    ]);
  });

  await t.test(
    "keeps resources and resourceTemplates as separate arrays — Smithery's release API 400s " +
      'a `resources` entry with no string `uri` (a template has `uriTemplate` instead), so the ' +
      'two must never be merged',
    () => {
      for (const resource of card.resources) {
        assert.equal(
          typeof resource.uri,
          'string',
          `resources[] entry ${resource.name} has no string uri`,
        );
      }
    },
  );

  await t.test(
    'carries exactly the library document resource template, and no concrete resources — ' +
      'alexandria exposes only the one template',
    () => {
      assert.equal(card.resources.length, 0);
      assert.equal(card.resourceTemplates.length, 1);
      assert.equal(card.resourceTemplates[0]?.uriTemplate, 'library://doc/{source}/{id}');
    },
  );

  await t.test('is a fresh call each time — two invocations agree on shape', async () => {
    const again = await buildServerCard(FIXTURE_INPUTS);
    assert.deepEqual(again.tools.map((t) => t.name).sort(), card.tools.map((t) => t.name).sort());
  });
});
