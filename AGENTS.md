# AGENTS.md — Conventions for AI Coding Agents

This file is for AI coding agents (Claude Code, Cursor, Copilot, etc.) working on this codebase. It describes conventions, rules, and things to never do.

---

## Boot Order (critical)

`src/mastra/index.ts` must initialize in this exact order:

```
1. env validation   (import env from '../lib/env')
2. AIMock setup     (configureAIMock())
3. Mastra instance  (new Mastra({ ... }))
```

**Why**: The Vercel AI SDK reads provider base URLs at client instantiation and caches them. AIMock must overwrite env vars before any AI SDK client is constructed. Env must validate before AIMock so it can read `USE_AIMOCK` and `AIMOCK_URL`.

Never reorder these. Never construct an `Agent` or `@ai-sdk/*` client before `configureAIMock()` is called.

---

## Import Rules

- Use **relative imports** for everything inside `src/mastra/`
- `src/lib/env` is the only cross-boundary import allowed in `src/mastra/`
- Never import from `src/mastra/` in `src/lib/`
- Never use barrel/index files — import from the specific file

```typescript
// correct
import { env } from '../../lib/env';
import { voiceAssistantAgent } from './agents/_example';

// wrong
import { env } from '@/lib/env';              // no path aliases
import { voiceAssistantAgent } from './agents'; // no barrel imports
```

---

## Environment Variables

All env vars flow through `src/lib/env.ts`. This is the single source of truth.

Rules:
- Never read `process.env.*` directly outside of `src/lib/env.ts`
- When adding a new env var: add to the Zod schema in `env.ts` AND to `.env.example` at the same time
- Optional vars use `.optional()` in the schema; required vars have no default
- Boolish vars (`USE_AIMOCK`) use the `boolish` transform defined at the top of `env.ts`

---

## Agent Conventions

File naming: `src/mastra/agents/<kebab-name>.ts` (prefix `_` for examples/templates).

Every agent file must export:
1. The agent instance with `id`, `name`, `instructions`, `model`, and `scorers`
2. Voice agents also export nothing special — the voice instance is attached inline

Model string format: `anthropic/claude-haiku-4-5` for text mode (AI SDK provider format). Voice agents use Gemini Live for real-time audio regardless of the text `model` field. Use Anthropic (not OpenAI or Google) for the text model — Mastra's `google/` routing hardcodes the base URL, and Mastra's `openai/` routing uses the Responses API (`/v1/responses`) which AIMock does not match fixtures against. Only Mastra's `anthropic/` routing reads `ANTHROPIC_BASE_URL` and calls `/v1/messages`, which AIMock handles natively.

Scorers are declared inline on the agent. Scorer implementations live in `src/mastra/scorers/`. Every agent should have at least an `answerRelevancy` scorer.

Tools used only by one agent live inline in that agent's file. Shared tools go in `src/mastra/tools/`.

---

## Voice Conventions

Voice is attached to the `Agent` via the `voice` prop, not the `Mastra` instance:

```typescript
const agent = new Agent({
  id: 'myAgent',
  // ...
  voice: new GeminiLiveVoice({ apiKey: env.GOOGLE_API_KEY, ... }),
});
```

**`gemini-live-patch.ts` is required.** Call `patchGeminiLiveForAudio(voice)` immediately after constructing `GeminiLiveVoice`. The patch fixes three library bugs in `@mastra/voice-google-gemini-live`:
1. Wrong API version (v1alpha → v1beta)
2. Wrong auth (header → query param)
3. Deprecated `realtime_input.media_chunks` format (→ `realtime_input.audio`)

Do NOT remove the patch until the library is updated to handle the v1beta API natively.

**Tools auto-flow to voice.** Any tool registered on the agent is automatically available to the voice session. No separate voice tool registration is needed.

**Instructions must be tuned for spoken output.** Voice agent instructions must explicitly prohibit lists, bullet points, markdown, and anything that sounds unnatural when read aloud. Keep responses short — these are spoken, not displayed.

**Two modes, one agent.** The same agent handles:
- Real-time voice: `npm run voice:cli` → WebSocket → Gemini Live STS
- Text mode: `POST /api/agents/{id}/generate` → REST → standard LLM

Both modes use the same tools, memory, and instructions. Evals always run in text mode.

**Audio format for mic input**: `getMicrophoneStream({ rate: 16000, fileType: 'raw' })`. Gemini Live expects 16kHz raw PCM. Do not use the default WAV format.

---

## Scorer Conventions

File naming: `src/mastra/scorers/<agent-name>.scorers.ts`.

Dataset files: `src/mastra/scorers/datasets/<agent-name>.json`.

Voice agent datasets use `expectedTool` (string or null) and `expectedKeywords` (string array) — not `expectedFields`. The eval runner asserts tool calls and keyword presence in the response text.

```json
{
  "agentId": "voiceAssistant",
  "thresholds": { "answerRelevancy": 0.4 },
  "cases": [
    { "name": "...", "input": "...", "expectedTool": "getCurrentTime", "expectedKeywords": [] }
  ]
}
```

The `answerRelevancy` threshold for voice agents should be ~0.3 (not 0.7). Voice responses are intentionally terse, farewell responses score near 0.00, and OpenAI (the text model) spells out numbers — all of which score low on relevancy even when correct.

Correct import for prebuilt scorers:
```typescript
import { createAnswerRelevancyScorer } from '@mastra/evals/scorers/prebuilt';
```

---

## Storage

The Mastra instance uses a composite store:
- **default domain** → `PostgresStore` (Supabase Postgres via `SUPABASE_DB_URL`)
- **observability domain** → `DuckDBStore`

Both require an explicit `id` field:
```typescript
new PostgresStore({ id: 'mastra-storage', connectionString: env.SUPABASE_DB_URL })
```

`DuckDBStore` requires glibc. Do not run it in Alpine-based containers — use `node:22-slim`.

---

## Reachability conventions

Every agent registered in `src/mastra/index.ts` is reachable through four standard protocols, configured at the Mastra level:

- REST: `POST /api/agents/{agentId}/generate` (and `/stream`) — automatic; text mode only for voice agents
- A2A agent card: `GET /api/.well-known/{agentId}/agent-card.json` — automatic
- A2A execute: `POST /api/a2a/{agentId}` (JSON-RPC, `method: "message/send"`) — automatic
- MCP: `POST /api/mcp/{serverId}/mcp` — via `MCPServer` instance in `src/mastra/index.ts`
- Studio: `localhost:4111` UI — automatic via `mastra dev` (text mode; Studio does not stream audio)

Note: `/a2a/{agentId}` (without `/api` prefix) is caught by Studio's router and returns HTML. Always use the `/api/` prefix for A2A and MCP calls.

When adding a new agent:
1. Register it in the `agents` field of the Mastra constructor (gets REST + A2A + Studio automatically)
2. Add it to the `agents` field of the `MCPServer` instance (exposes via MCP as `ask_<agentId>`)
3. Ensure the agent has a non-empty `description` property — MCPServer fails to start without it

The `MastraEditor` instance gives non-developers a way to iterate on agent prompts and tools without code changes. Changes are versioned and stored in the `editor` storage domain. The editor is mandatory for every template in this family.

---

## Things to Never Do

- **Never read `process.env` directly** — use `env` from `src/lib/env.ts`
- **Never construct an AI SDK client before `configureAIMock()`** — AIMock will be bypassed silently
- **Never remove `patchGeminiLiveForAudio()`** — the library has known v1beta incompatibilities; removing the patch breaks the voice session immediately with code 1007/1008
- **Never use `audio/wav` or 24kHz for mic input** — Gemini Live requires raw 16kHz PCM; wrong format causes silent failures or poor transcription
- **Never use lists or markdown in voice agent instructions** — they are spoken aloud and sound unnatural
- **Never change the Dockerfile base to `node:22-alpine`** — DuckDB native binaries will SIGSEGV at runtime
- **Never add a new env var without updating `.env.example`** — new devs won't know it exists
- **Never skip the Zod schema for a new env var** — process will start with undefined values silently
- **Never import from `src/mastra/` in `src/lib/`** — creates circular dependency risk
- **Never register an agent before its file passes typecheck** — comment it out until types are clean
- **Never use barrel/index imports** — import from the specific file

---

## Voice patch — do not modify lightly

`src/mastra/lib/gemini-live-patch.ts` works around three specific library/API mismatches. If you (the AI coding agent) find yourself wanting to "clean up" or "refactor" this file, STOP.

The patch overrides specific internal methods on `GeminiLiveVoice` instances. The names of those methods (`connect`, `sendEvent`, etc.) are the library's private API and will change when the library updates. Refactoring without testing voice end-to-end will silently break voice for everyone.

If the patch needs changes:
1. Run `npm run voice:cli` BEFORE making changes — confirm current state works
2. Make the change
3. Run `npm run voice:cli` AFTER — confirm voice still works end-to-end
4. Document what you changed and why in PROGRESS.md

Do not modify this file based on type errors alone. The TypeScript types from the library are intentionally bypassed by the patch (using `as unknown as {...}`). If you "fix" type errors, you'll likely break the runtime behavior.

---

## Ask Before Acting

Stop and confirm with the user before making these changes:

- Changing the boot order in `src/mastra/index.ts`
- Modifying `gemini-live-patch.ts` — the patch is a carefully calibrated workaround
- Removing or renaming a scorer that's referenced in a dataset JSON
- Downgrading a Mastra or voice package version
- Adding a new `domain` to the composite store
- Any Supabase schema migrations

---

## Useful Commands

```bash
npm run dev          # Start Studio at localhost:4111 (text mode)
npm run voice:cli    # Start real-time voice CLI (mic + speakers required)
npm run typecheck    # Verify types before running
npm run eval         # Run all eval cases in text mode; exits 0 on pass, 1 on fail
npx supabase start   # Start local Supabase (Docker required)
```

Eval runs with `USE_AIMOCK=false` hit the real Google API and incur cost. Use `USE_AIMOCK=true` with AIMock running for free deterministic runs during development.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
