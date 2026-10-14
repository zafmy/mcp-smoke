import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const MAX_CASES = 20;
export const DEFAULT_TIMEOUT_MS = 10_000;

const Config = z.strictObject({
  cases: z.array(z.strictObject({
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
    expect: z.string().optional(),
    expectError: z.boolean().optional(),
  })).max(MAX_CASES, `at most ${MAX_CASES} cases per run`),
});

// Looser than the SDK's own tools/list schema on purpose: a malformed inputSchema should be reported
// against its tool by schemaProblem, not reject the whole listing.
const ToolPage = z.object({
  tools: z.array(z.looseObject({ name: z.string(), inputSchema: z.unknown() })),
  nextCursor: z.string().optional(),
});

export type Case = z.infer<typeof Config>['cases'][number];
export type Check = { name: string; ok: boolean; detail?: string };
export type Report = { ok: boolean; server: string; tools: string[]; checks: Check[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);
const fail = (detail: string) => ({ ok: false, detail });

export function parseConfig(text: string): Case[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`config is not valid JSON: ${message(e)}`);
  }
  const parsed = Config.safeParse(data);
  if (!parsed.success) throw new Error(`invalid config:\n${z.prettifyError(parsed.error)}`);
  return parsed.data.cases;
}

// ponytail: structural checks only (the mistakes that break tool calls in practice), not full JSON Schema
// validation. Swap in ajv if nested-schema errors start slipping through.
export function schemaProblem(schema: unknown): string | undefined {
  if (!isObject(schema) || schema.type !== 'object') return 'inputSchema must be a JSON Schema with type "object"';
  const { properties = {}, required = [] } = schema;
  if (!isObject(properties)) return '"properties" must be an object';
  if (!Array.isArray(required) || required.some((r) => typeof r !== 'string')) return '"required" must be an array of strings';
  const missing = required.filter((r) => !Object.hasOwn(properties, r));
  return missing.length ? `"required" names undeclared properties: ${missing.join(', ')}` : undefined;
}

async function runCase(client: Client, c: Case, names: Set<string>, timeout: number): Promise<Omit<Check, 'name'>> {
  if (!names.has(c.tool)) return fail(`no such tool; server has: ${[...names].join(', ')}`);
  let isError: boolean;
  let text: string;
  try {
    const res = await client.callTool({ name: c.tool, arguments: c.args ?? {} }, undefined, { timeout });
    const parts = Array.isArray(res.content) ? (res.content as { type: string; text?: string }[]) : [];
    isError = Boolean(res.isError);
    text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  } catch (e) {
    // Only an error the server actually sent counts as "the tool failed". A timeout or a dead
    // connection means the server is broken, which expectError must never excuse.
    const sentByServer = e instanceof McpError && e.code !== ErrorCode.RequestTimeout && e.code !== ErrorCode.ConnectionClosed;
    if (!sentByServer) return fail(message(e));
    isError = true;
    text = message(e);
  }
  if (isError !== Boolean(c.expectError)) {
    return fail(c.expectError ? `expected an error, got: ${clip(text)}` : `tool returned an error: ${clip(text)}`);
  }
  if (c.expect !== undefined && !text.includes(c.expect)) {
    return fail(`expected text to include ${JSON.stringify(c.expect)}, got: ${clip(text)}`);
  }
  return { ok: true };
}

// Boots the server over stdio, lists its tools, checks every input schema, then runs the example calls.
// Never throws for a broken server: every failure becomes a failed check in the report.
export async function smoke(command: string, args: string[], cases: Case[] = [], timeout = DEFAULT_TIMEOUT_MS): Promise<Report> {
  const checks: Check[] = [];
  const client = new Client({ name: 'mcp-smoke', version: '0.1.0' });
  const report = (server = '', tools: string[] = []): Report => ({ ok: checks.every((c) => c.ok), server, tools, checks });
  try {
    try {
      // The SDK's default passes only HOME, PATH and a few others; a server under test in CI needs its real env.
      const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
      await client.connect(new StdioClientTransport({ command, args, env, stderr: 'inherit' }), { timeout });
      checks.push({ name: 'connect', ok: true });
    } catch (e) {
      checks.push({ name: 'connect', ...fail(message(e)) });
      return report();
    }
    const info = client.getServerVersion();
    const server = info ? `${info.name} ${info.version}` : 'unknown';

    const tools: z.infer<typeof ToolPage>['tools'] = [];
    try {
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.request({ method: 'tools/list', params: { cursor } }, ToolPage, { timeout });
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error(`server repeated pagination cursor ${JSON.stringify(cursor)}`);
        if (cursor) seen.add(cursor);
      } while (cursor);
    } catch (e) {
      checks.push({ name: 'tools/list', ...fail(message(e)) });
      return report(server);
    }
    checks.push({ name: 'tools/list', ...(tools.length ? { ok: true } : fail('server exposes no tools')) });

    for (const t of tools) {
      const problem = schemaProblem(t.inputSchema);
      checks.push({ name: `schema ${t.name}`, ...(problem ? fail(problem) : { ok: true }) });
    }
    const names = new Set(tools.map((t) => t.name));
    for (const [i, c] of cases.entries()) {
      checks.push({ name: `call ${c.tool} #${i + 1}`, ...(await runCase(client, c, names, timeout)) });
    }
    return report(server, [...names]);
  } finally {
    await client.close().catch(() => undefined);
  }
}
