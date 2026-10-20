import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_CASES, parseConfig, schemaProblem, smoke, type Case } from './smoke.js';

const fixture = [fileURLToPath(new URL('./fixture.js', import.meta.url))];
const run = (cases: Case[] = []) => smoke(process.execPath, fixture, cases);
const failed = (r: Awaited<ReturnType<typeof smoke>>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

test('schemaProblem accepts a normal tool schema and names what is wrong otherwise', () => {
  assert.equal(schemaProblem({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }), undefined);
  assert.equal(schemaProblem({ type: 'object' }), undefined);
  assert.match(schemaProblem({ properties: {} })!, /type "object"/);
  assert.match(schemaProblem({ type: 'object', properties: { q: {} }, required: ['query'] })!, /undeclared.*query/);
  assert.match(schemaProblem({ type: 'object', required: 'q' })!, /array of strings/);
  assert.match(schemaProblem({ type: 'object', properties: {}, required: ['toString'] })!, /undeclared.*toString/);
});

test('parseConfig validates cases and enforces the per-run limit', () => {
  assert.deepEqual(parseConfig('{"cases":[{"tool":"echo","args":{"text":"hi"},"expect":"hi"}]}'),
    [{ tool: 'echo', args: { text: 'hi' }, expect: 'hi' }]);
  const tooMany = JSON.stringify({ cases: Array(MAX_CASES + 1).fill({ tool: 'echo' }) });
  assert.throws(() => parseConfig(tooMany), new RegExp(String(MAX_CASES)));
  assert.throws(() => parseConfig('{"cases":[{"args":{}}]}'), /tool/);
  assert.throws(() => parseConfig('{"cases":[{"tool":"echo","expcet":"typo"}]}'), /expcet/);
  // "".includes check always passes, so an empty expect would silently assert nothing.
  assert.throws(() => parseConfig('{"cases":[{"tool":"echo","expect":""}]}'), /expect/);
  assert.throws(() => parseConfig('not json'), /JSON/);
});

test('a healthy server passes: connect, list, schemas and example calls', async () => {
  const r = await run([
    { tool: 'echo', args: { text: 'selamat pagi' }, expect: 'selamat' },
    { tool: 'boom', expectError: true },
  ]);
  assert.deepEqual(failed(r), []);
  assert.equal(r.ok, true);
  assert.equal(r.server, 'fixture 1.0.0');
  assert.deepEqual(r.tools, ['echo', 'boom']);
  assert.equal(r.checks.length, 6); // connect, tools/list, 2 schemas, 2 calls
});

test('wrong output, unexpected errors, bad args and unknown tools fail the run', async () => {
  const r = await run([
    { tool: 'echo', args: { text: 'hi' }, expect: 'bye' },
    { tool: 'boom' },
    { tool: 'echo', args: { text: 42 } },
    { tool: 'nope' },
    { tool: 'echo', args: { text: 'fine' }, expectError: true },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ['call echo #1', 'call boom #2', 'call echo #3', 'call nope #4', 'call echo #5']);
  assert.match(r.checks.find((c) => c.name === 'call echo #1')!.detail!, /"bye".*hi/s);
  assert.match(r.checks.find((c) => c.name === 'call boom #2')!.detail!, /kaboom/);
});

test('a server that cannot start is reported, not thrown', async () => {
  const r = await smoke(process.execPath, ['-e', 'process.exit(1)'], [], 3000);
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ['connect']);
});

// A raw JSON-RPC server over stdio, for misbehaviour the SDK server would never produce.
const fake = (onCall: string, list = `{ tools: [{ name: 't', inputSchema: { type: 'object' } }] }`) => ['-e', `
  const send = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\\n');
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.id === undefined) return;
    if (m.method === 'initialize') return send(m.id, { result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });
    if (m.method === 'tools/list') return send(m.id, { result: ${list} });
    if (m.method === 'tools/call') { ${onCall} }
  });`];
const expectsError: Case[] = [{ tool: 't', expectError: true }];

test('expectError does not pass when the server crashes or hangs', async () => {
  const crashed = await smoke(process.execPath, fake('process.exit(1)'), expectsError, 3000);
  assert.deepEqual(failed(crashed), ['call t #1']);
  const hung = await smoke(process.execPath, fake(''), expectsError, 500);
  assert.deepEqual(failed(hung), ['call t #1']);
});

test('expectError accepts a protocol error the server sent, and still checks expect', async () => {
  const rejects = fake(`send(m.id, { error: { code: -32602, message: 'query must not be empty' } })`);
  assert.equal((await smoke(process.execPath, rejects, [{ tool: 't', expectError: true, expect: 'must not be empty' }])).ok, true);
  assert.deepEqual(failed(await smoke(process.execPath, rejects, [{ tool: 't', expectError: true, expect: 'something else' }])), ['call t #1']);
});

test('a server that repeats its pagination cursor fails tools/list instead of looping', async () => {
  const r = await smoke(process.execPath, fake('', `{ tools: [{ name: 't', inputSchema: { type: 'object' } }], nextCursor: 'same' }`), [], 3000);
  assert.deepEqual(failed(r), ['tools/list']);
  assert.match(r.checks.at(-1)!.detail!, /cursor/);
});

test('a malformed input schema is reported against its tool, not as a failed listing', async () => {
  const list = `{ tools: [{ name: 'good', inputSchema: { type: 'object' } }, { name: 'bad', inputSchema: { properties: {} } }] }`;
  const r = await smoke(process.execPath, fake('', list));
  assert.deepEqual(failed(r), ['schema bad']);
  assert.deepEqual(r.tools, ['good', 'bad']);
});

test('the server inherits the caller environment', async () => {
  process.env.MCP_SMOKE_TEST_VAR = 'from-ci';
  const echoEnv = fake(`send(m.id, { result: { content: [{ type: 'text', text: String(process.env.MCP_SMOKE_TEST_VAR) }] } })`);
  assert.equal((await smoke(process.execPath, echoEnv, [{ tool: 't', expect: 'from-ci' }])).ok, true);
});

// stderr is ignored so an orphaned grandchild that inherited it cannot hold spawnSync open; this measures the CLI's own lifetime.
const cli = (...args: string[]) => spawnSync(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url)), ...args], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });

test('cli exits 1 promptly when the server hangs behind a wrapper process', { skip: process.platform === 'win32' }, () => {
  const started = Date.now();
  const r = cli('--timeout', '500', '--', 'sh', '-c', 'sleep 6; true');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✖ connect/);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
});

test('cli rejects a timeout that would overflow the timer', () => {
  assert.equal(cli('--timeout', '9999999999', '--', process.execPath, ...fixture).status, 2);
});
