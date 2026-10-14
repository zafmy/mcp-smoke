#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_TIMEOUT_MS, parseConfig, smoke, type Case } from './smoke.js';

const DEFAULT_CONFIG = 'mcp-smoke.json';
const USAGE = `Usage: mcp-smoke [--config ${DEFAULT_CONFIG}] [--json] [--timeout ms] -- <command> [args...]

Exit codes: 0 all checks passed, 1 a check failed, 2 bad usage or config.`;

const die = (msg: string): never => {
  process.stderr.write(`mcp-smoke: ${msg}\n\n${USAGE}\n`);
  process.exit(2);
};

function readArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c' },
        json: { type: 'boolean', default: false },
        timeout: { type: 'string', default: String(DEFAULT_TIMEOUT_MS) },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    return die(e instanceof Error ? e.message : String(e));
  }
}

function readCases(path: string | undefined): Case[] {
  const file = path ?? (existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : undefined);
  if (!file) return [];
  try {
    return parseConfig(readFileSync(file, 'utf8'));
  } catch (e) {
    return die(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const { values, positionals } = readArgs();
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const [command, ...args] = positionals;
if (!command) die('no server command given');
const timeout = Number(values.timeout);
// setTimeout silently turns anything above 2^31-1 into 1 ms.
if (!(timeout > 0 && timeout <= 2 ** 31 - 1)) die(`--timeout must be between 1 and ${2 ** 31 - 1} milliseconds, got "${values.timeout}"`);

const report = await smoke(command, args, readCases(values.config), timeout);

const passed = report.checks.filter((c) => c.ok).length;
const lines = report.checks.map((c) => `${c.ok ? '✔' : '✖'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
const header = report.server ? `${report.server}, ${report.tools.length} tool(s)` : 'server did not start';
const out = values.json
  ? JSON.stringify(report, null, 2)
  : [header, ...lines, `${passed} passed, ${report.checks.length - passed} failed`].join('\n');

// Exit explicitly once the report is flushed: a server behind a wrapper (sh -c, npm run) can outlive
// the wrapper and keep our stdio pipes open, which would otherwise hang the CI step.
process.stdout.write(`${out}\n`, () => process.exit(report.ok ? 0 : 1));
