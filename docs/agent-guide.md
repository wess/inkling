# Operating an Inkling site with an agent

Inkling exposes its existing admin API as MCP tools over stdio. The MCP process
does not bypass the application: every operation takes the same authenticated
route as the admin, so validation, revisions, hooks, and the audit log still
apply.

Use this guide when an external coding agent or automation needs to inspect or
manage one Inkling site. If you are building a website that only reads published
content, use the [delivery API guide](delivery.md) instead.

## The trust boundary

An agent key starts with `inkagt_`. It is:

- limited to named grants;
- capped by the issuing account's live role on every request;
- required to expire, with a 90-day default and 365-day maximum;
- revocable without changing the account password or ending other sessions;
- refused by administrative routes such as users, delivery keys, webhooks,
  plugins, connected providers, and social accounts.

The MCP tool list is filtered to the key's grants for usability. The API is the
actual security boundary and performs the same checks even if a caller ignores
the advertised tool list.

Use a separate key for each agent and site. Give it the shortest practical
expiry and the smallest useful grant set. Do not put a key in a repository,
prompt, transcript, issue, or shell history.

## Connect

1. Sign in to the Inkling admin as the account the agent should act as.
2. Open **Agent keys**, create a key, choose its expiry, and grant only the work
   it needs.
3. Copy the key when it is shown. Inkling stores only its hash and cannot show
   the plaintext again.
4. Configure an MCP stdio server in the client. Point the command at the Inkling
   checkout that matches the site's installed version.

```json
{
  "mcpServers": {
    "inkling-site": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/inkling/scripts/mcp.ts"],
      "env": {
        "INKLING_URL": "https://cms.example.com",
        "INKLING_KEY": "inkagt_…"
      }
    }
  }
}
```

Set `INKLING_MCP_READONLY=1` for inspection, planning, and production diagnosis.
This hides write tools in addition to the key's own restrictions. It is a
client-side narrowing convenience; the key grants remain the server-enforced
boundary.

The server logs diagnostics to stderr and reserves stdout for newline-delimited
JSON-RPC. It is dual-era: current clients discover protocol `2026-07-28` with
`server/discover` and send version metadata on every request; clients using the
`2025-11-25` or `2025-06-18` initialization handshake continue to work. Tool
calls can run concurrently, and a cancelled call never emits a late result.

## Discover before acting

Start every unfamiliar site in this order:

1. Call `list_types` to learn the site's type handles and field definitions.
2. Call `get_type` for the type you will use. Do not infer field keys from labels.
3. Call `list_entries` and inspect `meta.total`; page until the relevant set has
   been seen.
4. Call `get_entry` immediately before an update so the change is based on the
   current record.
5. Use the smallest mutation that achieves the request, then read the result
   back before reporting success.

Entries store their model-specific values in `data`. Keys in that JSON are
camelCase and must match the content type exactly. Database columns are not part
of the MCP contract.

## Common workflows

### Inspect a site

Use `list_types`, `list_entries`, `get_entry`, `list_media`,
`get_site_settings`, `list_menus`, and `search`. A read-only connection is
enough. Search requires at least two characters, and list operations are paged.

### Edit content safely

Read the entry and its type first. Send only fields the type declares, preserve
unrelated `data`, and read the entry back after the update. Publishing is a
separate grant from writing; a key that can edit a draft may still be unable to
publish it.

### Work with media

Prefer existing media when it fits. A remote import refuses loopback, link-local,
and private-network destinations. That protects the machine running the MCP
process from server-side request forgery; it is not an upload failure to retry
against another private address.

### Work in production

Use `INKLING_MCP_READONLY=1` for discovery and diagnosis. For an approved write,
use a narrowly scoped key, make one coherent change, verify it, and revoke the
key when the task is complete. Content changes are attributed to the account and
record the agent-key id in the audit trail.

## Credentials and surfaces

| Credential | Prefix | Audience | Surface |
|---|---|---|---|
| Session token | none | A person in the admin | `/api/*` within the account role |
| Agent key | `inkagt_` | MCP client or automation | `/api/*` within grants and role |
| Delivery key | `ink_` | A consuming website | Published `/content` and `/site` data |

`GET /api/agents/me` reports the calling agent key's effective scopes. A 401
means the key is missing, malformed, expired, revoked, or belongs to a deleted
account. A 403 means the credential is valid but lacks the required grant or
current role. Do not retry either response with broader actions.

## Rules for reliable automation

- Treat every type handle, field key, entry id, and menu name as site-specific.
- Never assume the first page is the complete result; inspect pagination metadata.
- Re-read before a mutation and verify afterward.
- Do not use a delivery key for admin work or expose an agent key to browser code.
- Do not turn a 401 or 403 into a credential-renewal loop.
- Do not retry a publish or other externally visible operation without checking
  the current state first.
- Keep one MCP process per site so credentials and audit identity cannot cross.

For implementation details and route invariants, read the
[architecture](https://raw.githubusercontent.com/wess/inkling/main/docs/ARCHITECTURE.md).
For the complete tool inventory, inspect
[`scripts/mcp.ts`](https://github.com/wess/inkling/blob/main/scripts/mcp.ts).
