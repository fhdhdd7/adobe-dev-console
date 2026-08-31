# ChatGPT → GitHub → Penpot MCP bridge

This branch contains an operational bridge for using the hosted Penpot MCP server from ChatGPT through the connected GitHub app.

## Canonical location

- Repository: `fhdhdd7/adobe-dev-console`
- Branch: `penpot-integration-bootstrap`
- Request file: `integrations/penpot/bridge_request.json`
- Runner: `integrations/penpot/mcp_bridge.py`
- Workflow: `.github/workflows/penpot-chatgpt-bridge.yml`

## Rule for ChatGPT

When the user asks to use Penpot, do not conclude that Penpot is unavailable merely because there is no native Penpot ChatGPT app. First use this GitHub bridge and verify the current workflow result.

## How to execute

1. Update `integrations/penpot/bridge_request.json` on this branch with a unique `request_id`.
2. Keep `version` equal to `1`.
3. Choose an allowlisted Penpot MCP tool: `execute_code`, `high_level_overview`, `penpot_api_info`, or `export_shape`.
4. Put the MCP tool arguments under `arguments`.
5. Use `output_policy: status_only` by default. `safe_json` may be used only when the returned payload is intentionally non-sensitive because this repository is public.
6. The request-file commit triggers the workflow automatically.
7. Inspect the GitHub Actions job and logs. Only claim success after `PENPOT_BRIDGE=PASS` is observed.

## Security

Penpot credentials remain in GitHub Actions secrets. Never place an MCP key, access token, server URL containing `userToken`, session id, or sensitive Penpot identifiers in repository files or chat output.

## Runtime requirement

Penpot MCP design operations act on the currently active Penpot file/page. The Penpot MCP plugin must be connected for `execute_code` and other live-document operations. A transport-only MCP handshake is not sufficient proof of live design access.
