# mcp-smoke

[![CI](https://github.com/zafmy/mcp-smoke/actions/workflows/ci.yml/badge.svg)](https://github.com/zafmy/mcp-smoke/actions/workflows/ci.yml)

One command to smoke-test any stdio MCP server, built for CI. It boots your server the way an agent would, lists the tools, checks every input schema, runs a few example calls, and exits non-zero if anything is off.

It runs locally, makes no network calls of its own, and needs no API key or model.

```text
$ npx -y github:zafmy/mcp-smoke -- node dist/index.js
mql5-docs-mcp 0.1.0, 3 tool(s)
✔ connect
✔ tools/list
✔ schema search_reference
✔ schema get_signature
✔ schema explain_code
✔ call get_signature #1
✔ call explain_code #2
✔ call search_reference #3
8 passed, 0 failed
```

## Use

```bash
npx -y github:zafmy/mcp-smoke -- <command that starts your server> [args...]
```

Install it with the `github:` prefix as shown. The `mcp-smoke` name on the npm registry belongs to a different project. In CI, pin a full commit SHA (`github:zafmy/mcp-smoke#<sha>`) so a change on main cannot change your build.

| Option | What it does |
|---|---|
| `-c, --config <file>` | Example calls to run. Defaults to `mcp-smoke.json` in the current folder if it exists |
| `--json` | Print the report as JSON, for agents and scripts |
| `--timeout <ms>` | Limit for each request to the server. Default `10000` |

Exit codes: `0` every check passed, `1` a check failed, `2` bad usage or config.

## What it checks

1. **connect**: the process starts and completes the MCP handshake.
2. **tools/list**: the server lists at least one tool.
3. **schema `<tool>`**: each `inputSchema` has `type: "object"`, `properties` is an object, and every name in `required` is a declared property.
4. **call `<tool>` #n**: each example call from the config returns what you expect.

## Example calls

`mcp-smoke.json`:

```json
{
  "cases": [
    { "tool": "get_signature", "args": { "name": "CopyBuffer" }, "expect": "int CopyBuffer(" },
    { "tool": "explain_code", "args": { "code": 10016 }, "expect": "TRADE_RETCODE_INVALID_STOPS" },
    { "tool": "search_reference", "args": { "query": "" }, "expectError": true }
  ]
}
```

| Field | Meaning |
|---|---|
| `tool` | Tool name. Required |
| `args` | Arguments object. Defaults to `{}` |
| `expect` | Text that the result's text content must contain |
| `expectError` | `true` if the call should fail: an `isError` result, or an error the server sends back. A crash or a timeout never counts |

A call with neither `expect` nor `expectError` passes if the tool returns without an error. Unknown fields are rejected, so a typo like `expcet` fails loudly instead of being ignored.

A full example lives in [examples/mql5-docs-mcp.json](examples/mql5-docs-mcp.json).

The server is started with the same environment variables as `mcp-smoke` itself, so secrets set on the CI step reach it. Everything mcp-smoke installs from npm runs in that step too, so give secrets only to that step and keep the job at `permissions: contents: read`.

## In GitHub Actions

```yaml
# after your own checkout, setup-node and build steps
- run: npx -y github:zafmy/mcp-smoke -- node dist/index.js
```

## Scope

Covered: MCP servers started as a local process over stdio, tools only, up to **20 example calls per run**.

Not covered: HTTP/SSE servers, authentication, resources and prompts, full JSON Schema validation, and judging whether a tool description is good. This is a smoke test: it tells you the server starts and its tools answer, not that the answers are right in every case.

## Develop

```bash
npm install
npm test   # builds, then runs the tests against a small fixture server
```

## License

MIT
