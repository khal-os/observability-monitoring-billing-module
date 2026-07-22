#!/usr/bin/env python3
"""Connector register (v1 mock) — the discovery service between agents and
the observability platform.

Agents hold ONE static config: CONNECTOR_REGISTER_URL. They GET it verbatim
and receive this register's hypermedia document — named capability links
(`traces`, `events`) carrying href + opaque auth headers + a TTL. All vendor
knowledge (LangWatch's address, API key, paths) lives HERE; swapping vendor,
moving hosts or rotating keys is an answer change, never an agent change.
Agents re-fetch on TTL expiry or link failure, so changes propagate within
the TTL with no restarts.

Single-tenant, like everything in this repo: one register instance = one
client, chosen at startup.

Usage:
    python3 packages/register/register.py <client-name>     # or: make register CLIENT=<name>

Reads clients/<client-name>.env (LANGWATCH_API_KEY + LANGWATCH_PORT) on
EVERY request — a rotated key or moved LangWatch propagates to agents within
the document TTL, no restart needed.

Env overrides:
    REGISTER_PORT     port to listen on                  (default: 8901)
    AGENT_ENV_FILE    a .env file to stamp with CONNECTOR_REGISTER_URL at
                      startup (default: ../martino-agent/.env next to this
                      repo, if it exists; set empty to disable)
"""

import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
PORT = int(os.getenv("REGISTER_PORT", "8901"))
URL = f"http://localhost:{PORT}"
TTL_SECONDS = 60

_default_agent_env = REPO_ROOT.parent / "martino-agent" / ".env"
AGENT_ENV = os.getenv("AGENT_ENV_FILE", str(_default_agent_env) if _default_agent_env.is_file() else "")

if len(sys.argv) != 2 or not re.match(r"^[a-z0-9][a-z0-9-]*$", sys.argv[1]):
    sys.exit("usage: register.py <client-name>   (e.g. hapvida)")
CLIENT = sys.argv[1]
ENV_FILE = CLIENTS_DIR / f"{CLIENT}.env"
if not ENV_FILE.is_file():
    sys.exit(f"no such client env: {ENV_FILE}")


def build_document() -> dict:
    env = ENV_FILE.read_text()
    token = re.search(r"^LANGWATCH_API_KEY=(.*)$", env, re.M).group(1).strip()
    port = re.search(r"^LANGWATCH_PORT=(.*)$", env, re.M).group(1).strip()
    base = f"http://localhost:{port}"
    return {
        "version": "1",
        "ttl_seconds": TTL_SECONDS,
        "links": {
            "traces": {
                "href": f"{base}/api/otel/v1/traces",
                "method": "POST",
                "headers": {"Authorization": f"Bearer {token}"},
            },
            "events": {
                "href": f"{base}/api/track_event",
                "method": "POST",
                "headers": {"X-Auth-Token": token},
            },
        },
    }


def point_agent_at_me() -> None:
    """Write CONNECTOR_REGISTER_URL=<our URL> into the configured agent .env."""
    if not AGENT_ENV:
        return
    target = Path(AGENT_ENV)
    line = f"CONNECTOR_REGISTER_URL={URL}"
    text = target.read_text() if target.is_file() else ""
    if re.search(r"^CONNECTOR_REGISTER_URL=.*$", text, re.M):
        new = re.sub(r"^CONNECTOR_REGISTER_URL=.*$", line, text, flags=re.M)
    else:
        new = text + ("" if text.endswith("\n") or not text else "\n") + line + "\n"
    if new != text:
        target.write_text(new)
        print(f"[register:{CLIENT}] updated {target} → {line}", flush=True)
    else:
        print(f"[register:{CLIENT}] {target} already points here", flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        payload = json.dumps(build_document()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        print(f"[register:{CLIENT}] {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"[register:{CLIENT}] serving {ENV_FILE.relative_to(REPO_ROOT)}", flush=True)
    print(f"[register:{CLIENT}] CONNECTOR_REGISTER_URL={URL}", flush=True)
    point_agent_at_me()
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
