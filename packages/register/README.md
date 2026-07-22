# Connector register (v1 mock)

The discovery service between **agents** and the observability platform.
An agent's env carries exactly one observability setting — the register's
URL — fetched **verbatim** (the register owns its whole URL space). The
response is a hypermedia document: named capability links with `href`,
opaque auth `headers`, and a register-declared `ttl_seconds`.

```json
{
  "version": "1",
  "ttl_seconds": 60,
  "links": {
    "traces": { "href": "http://localhost:5568/api/otel/v1/traces",
                "method": "POST",
                "headers": { "Authorization": "Bearer sk-lw-..." } },
    "events": { "href": "http://localhost:5568/api/track_event",
                "method": "POST",
                "headers": { "X-Auth-Token": "sk-lw-..." } }
  }
}
```

**The connector defines the contracts; agents plug in.** Fixed protocols per
link (`traces` = OTLP over HTTP, `events` = HTTP+JSON), swappable vendors
behind them: moving LangWatch, rotating its key, or fronting it with an
adapter is an answer change here — never an agent change. Agents re-resolve
on TTL expiry or link failure, so changes propagate live, no restarts.

## Run

```bash
make register CLIENT=<name>
# or: python3 packages/register/register.py <name>
```

Single-tenant like everything in this repo: one instance = one client. It
reads `clients/<name>.env` (`LANGWATCH_API_KEY` + `LANGWATCH_PORT`) on
**every request**, so env-file changes propagate within the TTL.

Env overrides: `REGISTER_PORT` (default 8901); `AGENT_ENV_FILE` — a `.env`
to stamp with `CONNECTOR_REGISTER_URL` at startup (defaults to a sibling
`../martino-agent/.env` when present; set empty to disable).

## Status

v1 **mock** for local development and demos. The production register adds:
auth (open item), a real deployment per client (`connectorregister.<client>…`),
and a managed source of truth instead of the client env file.
