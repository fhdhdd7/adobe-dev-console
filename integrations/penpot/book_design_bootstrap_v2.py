#!/usr/bin/env python3
"""Idempotently create/discover the Penpot book design file.

Uses only the existing PENPOT_ACCESS_TOKEN GitHub secret. It never prints
credentials, account data, or Penpot object identifiers.
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
BOOK_FILE_NAME = os.environ.get("PENPOT_BOOK_FILE_NAME", "250 أقوال — نظام تصميم الكتاب")
TOKEN = os.environ.get("PENPOT_ACCESS_TOKEN", "").strip()
if not TOKEN:
    raise SystemExit("PENPOT_ACCESS_TOKEN is not configured")

HEADERS = {
    "Authorization": f"Token {TOKEN}",
    "Accept": "application/json",
    "User-Agent": "github-actions-penpot-book-bootstrap/2.0",
}


def request(method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    headers = dict(HEADERS)
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + path, headers=headers, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}")
            return None if not raw else json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError("network error") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("invalid JSON response") from exc


def get(command: str, params: dict[str, str] | None = None) -> Any:
    query = "" if not params else "?" + urllib.parse.urlencode(params)
    errors: list[str] = []
    for prefix in ("/api/main/methods/", "/api/rpc/command/"):
        try:
            return request("GET", prefix + command + query)
        except RuntimeError as exc:
            errors.append(str(exc))
    raise RuntimeError(f"GET {command} failed ({', '.join(errors)})")


def post(command: str, payload: dict[str, Any]) -> Any:
    errors: list[str] = []
    for prefix in ("/api/main/methods/", "/api/rpc/command/"):
        try:
            return request("POST", prefix + command, payload)
        except RuntimeError as exc:
            errors.append(str(exc))
    raise RuntimeError(f"POST {command} failed ({', '.join(errors)})")


def as_list(value: Any, kind: str) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [x for x in value if isinstance(x, dict)]
    if isinstance(value, dict):
        for key in (kind, "result", "data"):
            nested = value.get(key)
            if isinstance(nested, list):
                return [x for x in nested if isinstance(x, dict)]
    raise RuntimeError(f"unexpected {kind} response")


def pick_project(profile: dict[str, Any]) -> str:
    for key in ("default-project-id", "defaultProjectId", "default_project_id"):
        value = profile.get(key)
        if isinstance(value, str) and value:
            return value

    projects = as_list(get("get-all-projects"), "projects")
    if not projects:
        raise RuntimeError("no editable Penpot project is available")

    preferred = [
        p for p in projects
        if p.get("is-default-team") is True
        or p.get("isDefaultTeam") is True
        or p.get("is_default_team") is True
    ]
    candidates = preferred or projects
    for project in candidates:
        value = project.get("id")
        if isinstance(value, str) and value:
            return value
    raise RuntimeError("Penpot project list did not include a usable project id")


def main() -> int:
    profile = get("get-profile")
    if not isinstance(profile, dict):
        raise RuntimeError("unexpected profile response")

    project_id = pick_project(profile)
    files = as_list(get("get-project-files", {"project-id": project_id}), "files")
    matches = [f for f in files if f.get("name") == BOOK_FILE_NAME]
    if len(matches) > 1:
        raise RuntimeError("duplicate book design files already exist")
    if matches:
        print("PENPOT_BOOK_DESIGN=EXISTS")
        return 0

    created = post(
        "create-file",
        {"name": BOOK_FILE_NAME, "project-id": project_id, "is-shared": False},
    )
    if not isinstance(created, dict) or created.get("name") != BOOK_FILE_NAME:
        raise RuntimeError("create-file returned an unexpected response")

    files_after = as_list(get("get-project-files", {"project-id": project_id}), "files")
    if sum(1 for f in files_after if f.get("name") == BOOK_FILE_NAME) != 1:
        raise RuntimeError("read-after-write verification failed")

    print("PENPOT_BOOK_DESIGN=CREATED_AND_VERIFIED")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"PENPOT_BOOK_DESIGN=FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
