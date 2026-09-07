#!/usr/bin/env node
// publish-smithery — a TypeScript port of obsidian-tc's scripts/publish-smithery.mjs (THE-956,
// rewritten THE-966), adapted for this repo. The registry API contract, redaction rules, abort
// deadlines, and injectable-signal-factory shape below are copied as-is; ported changes are:
//   - SMITHERY_NAME: this repo's own Smithery namespace, "the-40-thieves/alexandria-mcp"
//     (following the same `<org>/<repo-name>` convention as obsidian-tc's listing).
//   - DEFAULT_MANIFEST_PATH: this repo's manifest.json lives at the repo root (obsidian-tc's
//     lives under mcpb/).
//   - Written in TypeScript, since this repo's scripts/ run natively via `node scripts/x.ts`
//     rather than as .mjs.
//
// API CONTRACT (read from `@smithery/api` 0.68.0's generated client, since the public docs page
// under-specifies the exact paths/fields — `resources/servers/releases.d.ts` and `.js`):
//   PUT  https://api.smithery.ai/servers/{qualifiedName}/releases   multipart: payload, bundle
//   GET  https://api.smithery.ai/servers/{qualifiedName}/releases/{id}   (poll for status + logs)
// `payload` is `JSON.stringify({ type: "stdio", runtime, configSchema?, serverCard })` — the same
// shape `arcadeai-labs/smithery-cli`'s own `getBundleDeployPayload` (src/lib/mcpb.ts) builds from a
// bundle's manifest.json, so this script's payload is a SUPERSET of the CLI's, not a different
// shape: `runtime` from `detectRuntime` below mirrors `detectBundleRuntime`'s `manifest.server.type
// === "node"` branch (this repo's manifest.json always declares "node" — the archive `bin/`
// fallback the CLI also checks for a `"binary"` server type is not reproduced here since it would
// require unzipping the bundle just to read a field this repo's manifest never varies);
// `configSchema` from `buildConfigSchema` below mirrors `convertMCPBUserConfigToJSONSchema`, over
// the SAME manifest.json `user_config` block the CLI reads (not the packed bundle's copy — reading
// the checked-in manifest directly means this script never needs to unzip the .mcpb file at all).
// Auth is `Authorization: Bearer $SMITHERY_API_KEY` (client.js's `buildHeaders`).
//
// No new dependency: Node 24's built-in `fetch`/`FormData`/`Blob` do the multipart upload.
//
// Never logs a secret: SMITHERY_API_KEY is read only to check it's non-empty and to build the
// Authorization header actually sent — it is never interpolated into a string this script builds
// or included in argv. It COULD still reach stdout/stderr indirectly, though: a failed deploy's
// response body, a poll log line, or a release's error log all come from Smithery itself, and
// nothing stops a 4xx handler from echoing the request's own Authorization header back in its
// error text. `redact()` below is applied to every such server-derived string before it is logged
// or put in an Error, so even that reflection case can't leak the key.
//
// Every network call also carries `signal: AbortSignal.timeout(...)`, bounded by the operation's
// remaining `pollTimeoutMs` budget and capped per-request at `DEFAULT_REQUEST_TIMEOUT_MS` — a
// trickling or hung response otherwise held the job open indefinitely, since the poll loop's own
// deadline check only ran BETWEEN requests, never around one already in flight.
//
// Prereleases (a version containing "-", e.g. 11.1.0-rc.1) are skipped outright: the live
// Smithery listing (`mcpUrl`) is what users actually hit, so an RC must never be deployed there.
// This is a TRUE no-op, checked before even the SMITHERY_API_KEY presence check.
//
// Dry-run reads the local bundle/manifest/server-card (to prove the payload actually builds) but
// makes no network call at all — it prints the request it would send and returns.
//
// No idempotency preflight, per obsidian-tc's own probe against the live registry (see its
// docs/superpowers/plans/2026-09-03-listings/smithery.md): a repeat publish of an already-listed
// version is not an error — Smithery accepts it as a new release (`status: SUCCESS`, a fresh
// `deploymentId`) and redeploys the hosted `mcpUrl`. So a re-run of this job is safe by
// construction.
//
// OPEN QUESTION carried over from obsidian-tc, unresolved for THIS repo too: it is not confirmed
// whether the PUT .../releases endpoint can CREATE a server that does not exist yet under
// SMITHERY_NAME, or only add a release to one that already does — obsidian-tc's own listing was
// first created by `smithery mcp publish` (the CLI) and only later updated via this API. See this
// PR's description for what that means for the first live run here.
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** This repo's Smithery namespace — an org-controlled slug on Smithery's own side, unrelated to
 *  this repo's own package/server names. */
export const SMITHERY_NAME = 'the-40-thieves/alexandria-mcp';

export const SMITHERY_API_BASE = 'https://api.smithery.ai';

/** The default MCPB manifest this script reads `server.type` and `user_config` from — the
 *  checked-in source at the repo root, not the packed bundle's copy, so no unzip step is needed
 *  (see the module header). */
const DEFAULT_MANIFEST_PATH = join(ROOT, 'manifest.json');

/** These are the release statuses that mean "stop polling, this failed" (`@smithery/api`'s
 *  `ReleaseGetResponse.status` doc comment lists the full enum); a release the deploy PUT itself
 *  reported immediately as SUCCESS never needed polling. */
const TERMINAL_FAILURE_STATUSES = new Set([
  'FAILURE',
  'FAILURE_SCAN',
  'AUTH_REQUIRED',
  'AUTH_TIMEOUT',
  'INTERNAL_ERROR',
  'CANCELLED',
]);

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1_000;

/** Per-request abort ceiling: no single fetch — the PUT, or any poll GET — may block longer than
 *  this, regardless of how much of the overall `pollTimeoutMs` budget remains. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<FetchResponseLike>;

/** `fetch` wrapper — the injection point tests replace with a fake (no network, no real key). */
export function defaultFetch(url: string, init: RequestInit): Promise<FetchResponseLike> {
  return fetch(url, init);
}

/** Injectable so tests never wait on a real timer. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Injectable so a test can abort deterministically (no real timer, no CI-timing flakiness) instead
 * of waiting out a real `AbortSignal.timeout`. Production code always gets the real thing.
 */
function defaultCreateTimeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * The per-request abort budget: whatever is left until `deadline`, floored at 1ms (never zero or
 * negative — `AbortSignal.timeout` requires a positive duration) and capped at
 * `DEFAULT_REQUEST_TIMEOUT_MS` so one request can never claim the whole remaining budget for
 * itself.
 */
function requestTimeoutMs(deadline: number, now: () => number): number {
  return Math.max(1, Math.min(deadline - now(), DEFAULT_REQUEST_TIMEOUT_MS));
}

/** True for the error `fetch` rejects with when its `AbortSignal` fires (abort or timeout). */
function isAbortOrTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Replaces every occurrence of the real `SMITHERY_API_KEY` with `[redacted]`. Applied to every
 * string built from a server RESPONSE (a failed request's body, a poll log line, a release's error
 * log) before it is logged or put in an Error — see the module header for why a response, not just
 * this script's own output, needs this. A no-op when the key is unset/empty (dry-run, or a test
 * with no key), and safe on non-string input (returned unchanged).
 */
export function redact<T>(text: T): T {
  const key = process.env.SMITHERY_API_KEY;
  if (!key || typeof text !== 'string') return text;
  return text.split(key).join('[redacted]') as unknown as T;
}

export interface ParsedArgs {
  bundle: string;
  version: string;
  serverCard: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: Partial<ParsedArgs> & { dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle') args.bundle = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--server-card') args.serverCard = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`publish-smithery: unrecognized argument: ${a}`);
  }
  for (const [key, flag] of Object.entries({
    bundle: '--bundle',
    version: '--version',
    serverCard: '--server-card',
  })) {
    if (!args[key as keyof ParsedArgs]) throw new Error(`publish-smithery: ${flag} is required`);
  }
  return args as ParsedArgs;
}

/** A prerelease version (e.g. "11.1.0-rc.1") contains a "-" per semver; a stable one never does. */
export function isPrerelease(version: string): boolean {
  return version.includes('-');
}

export interface Manifest {
  server?: { type?: string; mcp_config?: { command?: string } };
  user_config?: Record<string, UserConfigOption>;
}

export interface UserConfigOption {
  type: string;
  title?: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  multiple?: boolean;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  title?: string;
  description?: string;
  default?: unknown;
}

/**
 * Mirrors `arcadeai-labs/smithery-cli`'s `detectBundleRuntime` (src/lib/mcpb.ts), minus the
 * archive `bin/` fallback for an implicit `"binary"` server type: that branch exists only for a
 * bundle whose manifest omits `server.type` altogether, and this repo's manifest.json always
 * declares one ("node") — so reproducing it here would add an unzip step for a case that cannot
 * occur against this repo's own manifest.
 */
export function detectRuntime(manifest: Manifest): string {
  const command = basename(manifest.server?.mcp_config?.command ?? '');
  if (command === 'bun') return 'bun';
  if (manifest.server?.type === 'python') return 'python';
  if (manifest.server?.type === 'node') return 'node';
  if (manifest.server?.type === 'binary') return 'binary';
  throw new Error(
    `publish-smithery: could not determine bundle runtime from manifest.server.type: ${JSON.stringify(manifest.server?.type)}`,
  );
}

/**
 * Mirrors `arcadeai-labs/smithery-cli`'s `convertMCPBUserConfigToJSONSchema` (src/lib/mcpb.ts):
 * flat dot-path MCPB `user_config` keys (`"auth.apiKey": {...}`) become a nested JSON Schema
 * (`{auth: {apiKey: {...}}}`); a top-level key with no dot stays top-level. Returns `undefined`
 * for an empty/missing `user_config` (no `configSchema` key at all, matching the CLI's own
 * `configSchema ? {configSchema} : {}` spread) rather than an empty schema object.
 */
export function buildConfigSchema(
  userConfig: Record<string, UserConfigOption> | undefined,
): JsonSchema | undefined {
  if (!userConfig || Object.keys(userConfig).length === 0) return undefined;
  const schema: JsonSchema = { type: 'object', properties: {} };
  const topLevelRequired: string[] = [];
  for (const [dotKey, option] of Object.entries(userConfig)) {
    const parts = dotKey.split('.');
    let current = schema;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      current.properties ??= {};
      current.properties[part] ??= { type: 'object', properties: {} };
      current = current.properties[part];
    }
    const leafKey = parts[parts.length - 1];
    const propertyType =
      option.type === 'directory' || option.type === 'file' ? 'string' : option.type;
    current.properties ??= {};
    current.properties[leafKey] = {
      type: option.multiple ? 'array' : propertyType,
      ...(option.multiple ? { items: { type: propertyType } } : {}),
      ...(option.title ? { title: option.title } : {}),
      ...(option.description ? { description: option.description } : {}),
      ...(option.default !== undefined ? { default: option.default } : {}),
    };
    if (option.required) {
      if (parts.length === 1) topLevelRequired.push(leafKey);
      else {
        const parentKey = parts[0];
        schema.required ??= [];
        if (!schema.required.includes(parentKey)) schema.required.push(parentKey);
        let parent = schema.properties?.[parentKey] as JsonSchema;
        for (let i = 1; i < parts.length - 1; i++) {
          parent = parent.properties?.[parts[i]] as JsonSchema;
        }
        parent.required ??= [];
        if (!parent.required.includes(leafKey)) parent.required.push(leafKey);
      }
    }
  }
  if (topLevelRequired.length > 0) schema.required = topLevelRequired;
  return schema;
}

export interface DeployPayload {
  type: 'stdio';
  runtime: string;
  configSchema?: JsonSchema;
  serverCard: unknown;
}

/** Builds the API deploy payload (the JSON string that becomes the `payload` multipart field). */
export function buildPayload(manifest: Manifest, serverCard: unknown): DeployPayload {
  const configSchema = buildConfigSchema(manifest.user_config);
  return {
    type: 'stdio',
    runtime: detectRuntime(manifest),
    ...(configSchema ? { configSchema } : {}),
    serverCard,
  };
}

export interface ReleaseLogLine {
  stage?: unknown;
  message?: unknown;
  level?: string;
  error?: { message?: string };
}

export interface ClassifyReleaseStatusInput {
  name: string;
  deploymentId: string;
  status?: string;
  mcpUrl?: string;
  logs?: ReleaseLogLine[];
  version: string;
}

export interface ClassifyResult {
  ok: boolean;
  message: string;
}

/**
 * Classifies one release response — the deploy call's own immediate result, or a later poll —
 * pure and injectable so it's testable with no network. Returns `{ ok, message }` when the status
 * is terminal (SUCCESS or a failure status); returns `null` when the status is still in progress
 * and the caller should keep polling.
 */
export function classifyReleaseStatus({
  name,
  deploymentId,
  status,
  mcpUrl,
  logs,
  version,
}: ClassifyReleaseStatusInput): ClassifyResult | null {
  if (status === 'SUCCESS') {
    return {
      ok: true,
      message: redact(
        `published ${name} — deployment ${deploymentId} (${mcpUrl}) (release ${version}).`,
      ),
    };
  }
  if (status && TERMINAL_FAILURE_STATUSES.has(status)) {
    const errorLog = logs?.find((l) => l.level === 'failure' || l.error?.message);
    const detail = errorLog ? `: ${errorLog.error?.message ?? errorLog.message}` : '';
    return {
      ok: false,
      message: redact(`release ${deploymentId} ended with status "${status}"${detail}`),
    };
  }
  return null;
}

interface ReleaseResponse {
  status?: string;
  mcpUrl?: string;
  logs?: ReleaseLogLine[];
  deploymentId?: string;
}

/**
 * GET the release's current status + logs, aborting after `timeoutMs` so a stalled response can't
 * hold the poll loop open past its own deadline (see `requestTimeoutMs`, the caller's budget).
 */
async function getRelease(
  fetchImpl: FetchImpl,
  name: string,
  id: string,
  timeoutMs: number,
  createTimeoutSignal: (ms: number) => AbortSignal,
): Promise<ReleaseResponse> {
  const path = `/servers/${name}/releases/${id}`;
  let res: FetchResponseLike;
  try {
    res = await fetchImpl(
      `${SMITHERY_API_BASE}/servers/${encodeURIComponent(name)}/releases/${encodeURIComponent(id)}`,
      {
        headers: { Authorization: `Bearer ${process.env.SMITHERY_API_KEY}` },
        signal: createTimeoutSignal(timeoutMs),
      },
    );
  } catch (err) {
    if (isAbortOrTimeout(err)) {
      throw new Error(`publish-smithery: request to ${path} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(
      redact(`publish-smithery: status poll failed: ${res.status} ${res.statusText}`),
    );
  }
  return (await res.json()) as ReleaseResponse;
}

export interface PollOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  createTimeoutSignal?: (ms: number) => AbortSignal;
  deadline?: number;
}

/**
 * Polls a release until it reaches a terminal status, printing each new log line as it appears.
 * Throws on a failure status or on exceeding `pollTimeoutMs` — both are treated as a failed job,
 * same as the immediate-response path in `publishToSmithery`.
 */
export async function pollUntilTerminal(
  fetchImpl: FetchImpl,
  name: string,
  deploymentId: string,
  version: string,
  {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    sleep = defaultSleep,
    now = Date.now,
    createTimeoutSignal = defaultCreateTimeoutSignal,
    // Shares one overall deadline with the deploy PUT that preceded this poll
    // (`publishToSmithery` passes its own already-computed deadline through here) rather than
    // starting a fresh `pollTimeoutMs` clock at the first poll — a caller that exercises
    // `pollUntilTerminal` directly (as this file's own tests do) gets one computed from
    // `pollTimeoutMs` instead.
    deadline = now() + pollTimeoutMs,
  }: PollOptions = {},
): Promise<ClassifyResult> {
  let loggedCount = 0;
  while (true) {
    const release = await getRelease(
      fetchImpl,
      name,
      deploymentId,
      requestTimeoutMs(deadline, now),
      createTimeoutSignal,
    );
    for (const line of (release.logs ?? []).slice(loggedCount)) {
      console.log(
        `publish-smithery: [${redact(String(line.stage))}] ${redact(String(line.message))}`,
      );
    }
    loggedCount = release.logs?.length ?? loggedCount;
    const result = classifyReleaseStatus({
      name,
      deploymentId,
      status: release.status,
      mcpUrl: release.mcpUrl,
      logs: release.logs,
      version,
    });
    if (result) {
      if (!result.ok) throw new Error(`publish-smithery: ${result.message}`);
      return result;
    }
    if (now() >= deadline) {
      throw new Error(
        `publish-smithery: release ${deploymentId} did not reach a terminal status within ${pollTimeoutMs}ms (last status "${release.status}")`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

export interface PublishOptions extends PollOptions {
  bundle: string;
  version: string;
  serverCard: string;
  dryRun?: boolean;
  fetchImpl?: FetchImpl;
  name?: string;
  manifestPath?: string;
}

export type PublishResult =
  | { action: 'skipped-prerelease' }
  | { action: 'dry-run' }
  | { action: 'published'; deploymentId?: string; mcpUrl?: string };

/**
 * Orchestrates the publish. `fetchImpl` is injected (defaults to `defaultFetch`) so every branch
 * is testable without real network access or a real key.
 */
export async function publishToSmithery({
  bundle,
  version,
  serverCard: serverCardPath,
  dryRun = false,
  fetchImpl = defaultFetch,
  name = SMITHERY_NAME,
  manifestPath = DEFAULT_MANIFEST_PATH,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  sleep = defaultSleep,
  now = Date.now,
  createTimeoutSignal = defaultCreateTimeoutSignal,
}: PublishOptions): Promise<PublishResult> {
  if (isPrerelease(version)) {
    console.log(
      `publish-smithery: ${version} is a prerelease (contains "-") — Smithery publish is ` +
        'reserved for stable releases only. Skipping; nothing read or written.',
    );
    return { action: 'skipped-prerelease' };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const serverCard = JSON.parse(readFileSync(serverCardPath, 'utf8')) as {
    tools?: unknown[];
  };
  const payload = buildPayload(manifest, serverCard);

  if (dryRun) {
    // Proves the artifact this run would actually upload exists — a real publish only discovers a
    // missing bundle when `readFileSync(bundle)` below runs, which a dry run never reaches.
    statSync(bundle);
    console.log(
      `publish-smithery: [dry-run] would PUT ${SMITHERY_API_BASE}/servers/${name}/releases — ` +
        `runtime ${payload.runtime}, ${serverCard.tools?.length ?? 0} tools, bundle ${bundle} (release ${version})`,
    );
    return { action: 'dry-run' };
  }

  if (!process.env.SMITHERY_API_KEY) {
    throw new Error(
      'SMITHERY_API_KEY is empty — set the repo secret before this job can publish (this repo ' +
        'owns the Smithery listing; a silent skip would hide a broken release).',
    );
  }

  // One overall deadline for the whole publish attempt (the PUT, plus every poll GET after it) —
  // pollUntilTerminal below reuses this exact value rather than starting a fresh pollTimeoutMs
  // clock once the PUT returns, so a slow PUT eats into the same budget a slow poll would.
  const deadline = now() + pollTimeoutMs;

  const form = new FormData();
  form.set('payload', JSON.stringify(payload));
  form.set('bundle', new Blob([readFileSync(bundle)]), basename(bundle));

  const deployPath = `/servers/${name}/releases`;
  const putTimeoutMs = requestTimeoutMs(deadline, now);
  let deployRes: FetchResponseLike;
  try {
    deployRes = await fetchImpl(
      `${SMITHERY_API_BASE}/servers/${encodeURIComponent(name)}/releases`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${process.env.SMITHERY_API_KEY}` },
        body: form,
        signal: createTimeoutSignal(putTimeoutMs),
      },
    );
  } catch (err) {
    if (isAbortOrTimeout(err)) {
      throw new Error(
        `publish-smithery: request to ${deployPath} timed out after ${putTimeoutMs}ms`,
      );
    }
    throw err;
  }
  if (!deployRes.ok) {
    const body = deployRes.text ? await deployRes.text().catch(() => '') : '';
    throw new Error(
      redact(
        `publish-smithery: deploy request failed: ${deployRes.status} ${deployRes.statusText}${body ? ` — ${body}` : ''}`,
      ),
    );
  }
  const deployed = (await deployRes.json()) as ReleaseResponse;
  // Every field of a server response is server-controlled, the id included — redact it too.
  console.log(
    `publish-smithery: release ${redact(String(deployed.deploymentId))} accepted, polling status...`,
  );

  const immediate = classifyReleaseStatus({
    name,
    deploymentId: deployed.deploymentId ?? '',
    status: deployed.status,
    mcpUrl: deployed.mcpUrl,
    version,
  });
  let result = immediate;
  if (!result) {
    result = await pollUntilTerminal(fetchImpl, name, deployed.deploymentId ?? '', version, {
      pollIntervalMs,
      pollTimeoutMs,
      sleep,
      now,
      createTimeoutSignal,
      deadline,
    });
  } else if (!result.ok) {
    throw new Error(`publish-smithery: ${result.message}`);
  }

  console.log(`publish-smithery: ${result.message}`);
  return { action: 'published', deploymentId: deployed.deploymentId, mcpUrl: deployed.mcpUrl };
}

function main(): Promise<PublishResult> {
  const args = parseArgs(process.argv.slice(2));
  return publishToSmithery(args);
}

// Importing this module (as its test file does) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    // Defense in depth: every throw site above already redacts its own message, but this is the
    // last point before anything reaches stdout/stderr, so it redacts too rather than trusting
    // that no future call site (or an error thrown by something other than this script) forgets to.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`publish-smithery: FAIL — ${redact(message)}`);
    process.exit(1);
  }
}
