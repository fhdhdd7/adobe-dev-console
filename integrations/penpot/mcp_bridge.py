#!/usr/bin/env python3
"""Small GitHub-Actions bridge from ChatGPT/GitHub to the hosted Penpot MCP server.

Security properties:
- reads credentials only from GitHub Actions secrets;
- never prints the credential, endpoint, session id, or Penpot object ids by default;
- defaults to status-only output;
- raw/safe result output must be explicitly requested by the request file.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ENDPOINT_BASE = "https://design.penpot.app/mcp/stream"
REQUEST_PATH = Path(os.environ.get("PENPOT_BRIDGE_REQUEST", "integrations/penpot/bridge_request.json"))
ALLOWED_TOOLS = {"execute_code", "high_level_overview", "penpot_api_info", "export_shape"}


def fail(message: str) -> "NoReturn":
    print(f"PENPOT_BRIDGE=FAILED: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_message(raw: bytes) -> dict[str, Any]:
    text = raw.decode("utf-8", errors="strict").strip()
    if not text:
        return {}
    if text.startswith("{"):
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
        raise ValueError("JSON-RPC response is not an object")
    for line in text.splitlines():
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload and payload != "[DONE]":
                obj = json.loads(payload)
                if isinstance(obj, dict):
                    return obj
    raise ValueError("could not parse MCP response")


def post(token: str, payload: dict[str, Any], session_id: str | None = None) -> tuple[dict[str, Any], str | None]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "chatgpt-github-penpot-bridge/1.0",
    }
    if session_id:
        headers["mcp-session-id"] = session_id
    url = f"{ENDPOINT_BASE}?userToken={token}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            returned_session = response.headers.get("mcp-session-id")
            if response.status not in (200, 202, 204):
                raise RuntimeError(f"HTTP {response.status}")
            return ({} if not raw else parse_message(raw), returned_session)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError("network error") from exc


def main() -> int:
    token = (os.environ.get("PENPOT_MCP_KEY") or os.environ.get("PENPOT_ACCESS_TOKEN") or "").strip()
    if not token:
        fail("no Penpot credential configured")

    try:
        request = json.loads(REQUEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"invalid request file: {type(exc).__name__}")

    if not isinstance(request, dict) or request.get("version") != 1:
        fail("unsupported request format")

    request_id = request.get("request_id")
    tool = request.get("tool")
    arguments = request.get("arguments", {})
    output_policy = request.get("output_policy", "status_only")

    if not isinstance(request_id, str) or not request_id or len(request_id) > 120:
        fail("invalid request_id")
    if tool not in ALLOWED_TOOLS:
        fail("tool is not allowlisted")
    if not isinstance(arguments, dict):
        fail("arguments must be an object")
    if output_policy not in {"status_only", "safe_json"}:
        fail("unsupported output_policy")

    init, session_id = post(
        token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "chatgpt-github-penpot-bridge", "version": "1.0.0"},
            },
        },
    )
    if not session_id or "error" in init:
        fail("MCP initialize failed")

    post(token, {"jsonrpc": "2.0", "method": "notifications/initialized"}, session_id)

    tools, _ = post(token, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, session_id)
    exposed = {
        item.get("name")
        for item in (tools.get("result", {}).get("tools", []) if isinstance(tools.get("result"), dict) else [])
        if isinstance(item, dict)
    }
    if tool not in exposed:
        fail("requested tool is not exposed by Penpot MCP")

    result, _ = post(
        token,
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": tool, "arguments": arguments}},
        session_id,
    )
    if "error" in result:
        fail("MCP tool returned a JSON-RPC error")
    rpc_result = result.get("result")
    if isinstance(rpc_result, dict) and rpc_result.get("isError") is True:
        fail("Penpot tool execution returned isError=true")

    canonical = json.dumps(rpc_result, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    print(f"PENPOT_BRIDGE=PASS request_id={request_id} tool={tool} result_sha256={digest}")
    if output_policy == "safe_json":
        print("PENPOT_SAFE_RESULT=" + canonical)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(str(exc))
