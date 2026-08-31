#!/usr/bin/env python3
"""Create or discover the dedicated Penpot design file for the book.

Security properties:
- reads PENPOT_ACCESS_TOKEN only from the environment;
- never prints the token, account data, project IDs, or file IDs;
- does not persist Penpot identifiers to the public repository;
- is idempotent: repeated runs discover the existing exact-name file.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

BASE = "https://design.penpot.app"
BOOK_FILE_NAME = os.environ.get(
    "PENPOT_BOOK_FILE_NAME",
    "250 أقوال — نظام تصميم الكتاب",
)
TOKEN = os.environ.get("PENPOT_ACCESS_TOKEN", "").strip()

if not TOKEN:
    raise SystemExit("PENPOT_ACCESS_TOKEN is not configured")

HEADERS = {
    "Authorization": f"Token {TOKEN}",
    "Accept": "application/json",
    "User-Agent": "github-actions-penpot-book-bootstrap/1.0",
}


def _request(method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    data = None
    headers = dict(HEADERS)
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = response.read()
            if response.status != 200:
                raise RuntimeError(f"Penpot returned HTTP {response.status}")
            if not body:
                return None
            try:
                return json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise RuntimeError("Penpot response was not valid JSON") from exc
    except urllib.error.HTTPError as exc:
        # Deliberately avoid printing the response body; it may contain account data.
        raise RuntimeError(f"Penpot request failed with HTTP {exc.code}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError("Penpot request failed at the network layer") from exc


def _try_get(command: str, params: dict[str, str] | None = None) -> Any:
    query = ""
    if params:
        query = "?" + urllib.parse.urlencode(params)
    paths = (
        f"/api/main/methods/{command}{query}",
        f"/api/rpc/command/{command}{query}",
    )
    last_error: Exception | None = None
    for path in paths:
        try:
            return _request("GET", path)
        except RuntimeError as exc:
            last_error = exc
    raise RuntimeError(f"Unable to execute Penpot GET command: {command}") from last_error


def _try_post(command: str, payload: dict[str, Any]) -> Any:
    paths = (
        f"/api/main/methods/{command}",
        f"/api/rpc/command/{command}",
    )
    last_error: Exception | None = None
    for path in paths:
        try:
            return _request("POST", path, payload)
        except RuntimeError as exc:
            last_error = exc
    raise RuntimeError(f"Unable to execute Penpot POST command: {command}") from last_error


def _key(mapping: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in mapping and mapping[name] is not None:
            return mapping[name]
    return None


def _normalize_files(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        for key in ("files", "result", "data"):
            nested = value.get(key)
            if isinstance(nested, list):
                return [item for item in nested if isinstance(item, dict)]
    raise RuntimeError("Unexpected Penpot project-file response shape")


def main() -> int:
    profile = _try_get("get-profile")
    if not isinstance(profile, dict):
        raise RuntimeError("Unexpected Penpot profile response shape")

    project_id = _key(profile, "default-project-id", "defaultProjectId", "default_project_id")
    if not isinstance(project_id, str) or not project_id:
        raise RuntimeError("Penpot profile did not expose a default project")

    files = _normalize_files(_try_get("get-project-files", {"project-id": project_id}))
    matches = [item for item in files if item.get("name") == BOOK_FILE_NAME]

    if len(matches) > 1:
        raise RuntimeError("More than one Penpot file has the expected book design name")

    if matches:
        print("PENPOT_BOOK_DESIGN=EXISTS")
        return 0

    created = _try_post(
        "create-file",
        {
            "name": BOOK_FILE_NAME,
            "project-id": project_id,
            "is-shared": False,
        },
    )
    if not isinstance(created, dict) or created.get("name") != BOOK_FILE_NAME:
        raise RuntimeError("Penpot did not confirm creation of the expected book design file")

    # Read-after-write verification without logging any identifiers.
    files_after = _normalize_files(_try_get("get-project-files", {"project-id": project_id}))
    if sum(1 for item in files_after if item.get("name") == BOOK_FILE_NAME) != 1:
        raise RuntimeError("Penpot book design file failed read-after-write verification")

    print("PENPOT_BOOK_DESIGN=CREATED_AND_VERIFIED")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"PENPOT_BOOK_DESIGN=FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
