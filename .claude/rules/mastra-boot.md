---
paths:
  - "src/mastra/index.ts"
  - "src/mastra/lib/memory.ts"
  - "src/mastra/lib/supabase.ts"
  - "src/mastra/lib/aimock.ts"
---

# Boot order, storage, reachability

## Boot order is load-bearing

`src/mastra/index.ts` must initialize in exactly this order:

```
1. env validation   (import env from '../lib/env')
2. AIMock setup     (configureAIMock())
3. Mastra instance  (new Mastra({ ... }))
```

The Vercel AI SDK reads provider base URLs at client instantiation and caches
them, so AIMock must overwrite env vars before any AI SDK client is
constructed. Env must validate first so AIMock can read `USE_AIMOCK` and
`AIMOCK_URL`.

Never construct an `Agent` or `@ai-sdk/*` client before `configureAIMock()`
runs — AIMock is bypassed silently, not loudly. Ask before reordering these.

## Storage

Every domain routes to one `PostgresStore` (Supabase Postgres via
`SUPABASE_DB_URL`), which requires an explicit `id`:

```typescript
new PostgresStore({ id: 'mastra-storage', connectionString: env.SUPABASE_DB_URL })
```

Share the ONE `pgStore` instance across every slot. Two instances against the
same DB race on first boot creating the shared `mastra_ai_spans` type → 23505.

Storage must tolerate concurrent writers, and that is architectural rather than
a preference. The HTTP server and the LiveKit worker are separate processes, and
the worker's job runners are separate processes again — all of them write spans.
A single-writer store cannot serve that. DuckDB was tried here and broke it
concretely: the worker's subprocesses failed with `already open in ... (PID N)`
and the runner then timed out, so the worker registered but could not answer
calls. Never give `observability`, or any domain, its own single-writer store.

Ask before adding a new `domain` to the composite store.

## Registering an agent

Every registered agent is reachable over REST, A2A, MCP, and Studio. When
adding one:

1. Register it in the `agents` field of the Mastra constructor — REST, A2A, and
   Studio come free.
2. Add it to the `agents` field of the `MCPServer` instance, which exposes it as
   `ask_<agentId>`.
3. Give it a non-empty `description` — `MCPServer` fails to start without one.

Never register an agent before its file passes `npm run typecheck`; comment it
out until types are clean.

Use the `/api/` prefix for A2A and MCP calls. `/a2a/{agentId}` without it is
caught by Studio's router and returns HTML.
