# AGENTS.md — Conventions for AI Coding Agents

This file is for AI coding agents (Claude Code, Cursor, Copilot, etc.) working on this codebase. It describes conventions, rules, and things to never do.

---

## Skills (vendored — no install step)

Three skills live in `.claude/skills/` and are committed to the repo, so every
clone has them. They are real files, not symlinks: `git clone` is the whole
install.

| Skill | Reach for it when |
| --- | --- |
| `mastra` | Touching any Mastra API. Its own first rule is the important one: do not trust model memory — read `node_modules/@mastra/*/dist/docs/` for the exact installed version. |
| `livekit-agents` | Working on the worker, room lifecycle, or audio pipeline. |
| `livekit-simulations` | Authoring scenario tests against the voice agent. |

Two of the skills carry a script, and both are load-bearing rather than optional
helpers:

- `mastra/scripts/provider-registry.mjs` — the skill requires running it before
  naming any model string. Node, no dependencies.
- `livekit-simulations/scripts/build_scenarios.py` — assembles the scenario file
  and enforces per-risk coverage. **Requires Python 3** (stdlib only), which is
  otherwise not a prerequisite of this project.

### Scope `livekit-agents` before following it

It is written for LiveKit Cloud. That part is fine — this project runs against
either Cloud or a self-hosted server, and `stt`/`tts` do go through LiveKit
Inference. What does not hold is narrower:

- **The LLM leg does not go through LiveKit.** `MastraVoiceAgent` supplies
  `llmNode`, so LiveKit's `llm` slot is never used — replies come from Mastra's
  model router. Its Inference guidance applies to STT and TTS only; ignore it
  for the model.
- **Agent structure lives in Mastra, not the LiveKit SDK.** Its guidance on
  `Agent` classes, handoffs, and tasks describes a layer this project does not
  use. Take agent, tool, and memory design from the `mastra` skill instead.

What does transfer: VAD, turn detection, barge-in, worker lifecycle, and its
insistence on tests.

### Refreshing them

The committed files are the pinned version. `skills-lock.json` records a git
tree hash per skill so `npx skills update` can tell whether upstream has moved —
it is drift detection, not a version pin, and the CLI rewrites it, so do not
hand-edit it. To pull updates:

```bash
npx skills add mastra-ai/skills     --skill '*' --agent claude-code --copy -y
npx skills add livekit/agent-skills --skill '*' --agent claude-code --copy -y
```

`--copy` is required. Without it the CLI symlinks into `.claude/skills/`, and a
symlink is useless to anyone who clones the repo on another machine.

Note `.gitignore` deliberately tracks `.claude/skills/` while ignoring the rest
of `.claude/` — settings there are personal, skills are shared.

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

Model string format: `anthropic/claude-haiku-4-5` for text mode (AI SDK provider format). Use Anthropic (not OpenAI) for the text model — Mastra's `openai/` routing uses the Responses API (`/v1/responses`), which AIMock does not match fixtures against. Mastra's `anthropic/` routing reads `ANTHROPIC_BASE_URL` and calls `/v1/messages`, which AIMock handles natively. **No Google providers** — this project uses none.

Scorers are declared inline on the agent. Scorer implementations live in `src/mastra/scorers/`. Every agent should have at least an `answerRelevancy` scorer.

Tools used only by one agent live inline in that agent's file. Shared tools go in `src/mastra/tools/`.

---

## Voice Conventions

**Realtime voice runs on LiveKit (`@mastra/livekit`), in a SEPARATE worker process.** The worker (`src/mastra/voice-worker.ts`, run via `npm run worker:*`) owns the audio loop; the HTTP server owns the text path. The worker is NOT bundled by `mastra build` — it runs from source via `tsx`. Only one worker flavor runs at a time (same `agentName`).

**Compliance controls live on the worker** (`configuration` + lifecycle hooks): AI-disclosure greeting (non-interruptible, periodic re-disclosure), consent declare→capture→enforce (deny-by-default at `onCallEnd`), agent-initiated hang-up (`endCall` + a `stopWhen` guard), and a per-call Dolt audit ledger (`lib/compliance-ledger.ts`, dormant until `DOLT_*` set). Keep the consent policy keys in sync across `configuration.consentPolicy`, the `recordConsent` tool's `items`, and the agent instructions — nothing enforces that they agree.

**Keep slow work off the caller's clock.** Tool filler (`toolFeedback`) speaks during slow tools; per-turn side effects go in fire-and-forget `onTurnComplete`; expensive close-out (summaries, ledger flush) goes in awaited `onCallEnd`. Memory writes are off-loop by design (`agentManaged: false`).

**Tools auto-flow to voice.** Any tool registered on the agent is automatically available to the voice session. No separate voice tool registration is needed.

**Instructions must be tuned for spoken output.** Voice agent instructions must explicitly prohibit lists, bullet points, markdown, and anything that sounds unnatural when read aloud. Keep responses short — these are spoken, not displayed.

**Text mode**: `POST /api/agents/{id}/generate` → REST → standard LLM. Evals always run in text mode.

---

## Telephony (SIP) Setup

Inbound phone calls reach the SAME worker as browser calls — no code change. What breaks is always configuration, and it breaks SILENTLY: LiveKit accepts the call and never dispatches an agent, so the caller hears silence with no error anywhere.

**The invariant.** Three names must be byte-identical:

1. `VOICE_AGENT_NAME` in `src/mastra/lib/voice.ts`
2. `agentName` in the LiveKit dispatch rule's `roomConfig.agents[]`
3. Whatever `runLiveKitWorker` registers (it reads the same constant — never inline the string)

**Setup order.** Each step depends on the one before it:

1. **Provider** — buy a number, create a SIP trunk, point it at the LiveKit SIP endpoint.
2. **SIP endpoint** — `lk project list --json`, take `ProjectId` (`p_vjnxecm0tjk`), strip `p_`, giving `sip:vjnxecm0tjk.sip.livekit.cloud`. The endpoint some providers want is that URI WITHOUT the `sip:` prefix.
3. **Inbound trunk** — `lk sip inbound create inbound-trunk.json`. One per phone number, reused for every call. Do NOT create one per call: trunks are cached long-lived objects and per-call creation degrades reliability at scale.
4. **Dispatch rule** — `lk sip dispatch create dispatch-rule.json`, with `roomConfig.agents[].agentName`. Without `roomConfig` the caller lands in a room no agent ever joins.
5. **Verify** — `lk sip inbound list` and `lk sip dispatch list` before placing a call.

**PII — matters here because this template ships compliance controls.** `dispatchRuleIndividual` names the room after the CALLER'S PHONE NUMBER. LiveKit writes room names into logs and traces, and PII redaction does NOT strip them. For regulated calls, route to a predetermined room with a generated ID instead of using an individual rule.

**A worker must always be registered.** Scale-to-zero deregisters it from LiveKit, and an inbound call then connects to silence. Only one worker flavor can run at a time — they all register under the same `agentName`.

**Do not special-case SIP in agent code.** The worker cannot tell a phone caller from a browser caller, and it should not try. Disclosure, consent, hang-up, and the ledger all run identically. The only SIP-aware code is the hang-up path, which uses `ctx.deleteRoom()` because it terminates a SIP leg correctly — do not replace it with `ctx.shutdown()` alone.

Full CLI walkthrough is in the README under "Give it a phone number".

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

Every domain routes to one `PostgresStore` (Supabase Postgres via `SUPABASE_DB_URL`). It requires an explicit `id`:
```typescript
new PostgresStore({ id: 'mastra-storage', connectionString: env.SUPABASE_DB_URL })
```

**Share the ONE `pgStore` instance across every slot.** Two instances against the same DB race on first boot creating the shared `mastra_ai_spans` type → 23505.

**Storage must tolerate concurrent writers — this is architectural, not a preference.** The HTTP server and the LiveKit voice worker are separate processes, and the worker's job runners are separate processes again; all of them write spans (one per call, plus children per turn for STT/TTS/VAD/LLM-TTFT). A single-writer store cannot serve that. DuckDB was tried here and broke it concretely: the worker's supervised subprocesses failed with `Cannot open file "mastra.duckdb": ... already open in ... (PID N)` and the runner then timed out, so the worker registered but could not answer calls. Do not give `observability` (or any domain) its own single-writer store.

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
- **Never use lists or markdown in voice agent instructions** — they are spoken aloud and sound unnatural
- **Never change the Dockerfile base to `node:22-alpine`** — `onnxruntime-node` (fastembed embeddings, and LiveKit's Silero VAD + turn-detector) ships glibc-linked prebuilds with no musl build; `sharp` and the native tokenizers are the same. Stay on `node:22-slim`
- **Never add a new env var without updating `.env.example`** — new devs won't know it exists
- **Never skip the Zod schema for a new env var** — process will start with undefined values silently
- **Never import from `src/mastra/` in `src/lib/`** — creates circular dependency risk
- **Never register an agent before its file passes typecheck** — comment it out until types are clean
- **Never use barrel/index imports** — import from the specific file

---

## Ask Before Acting

Stop and confirm with the user before making these changes:

- Changing the boot order in `src/mastra/index.ts`
- Removing or renaming a scorer that's referenced in a dataset JSON
- Downgrading a Mastra or voice package version
- Adding a new `domain` to the composite store
- Any Supabase schema migrations

---

## Useful Commands

```bash
npm run dev          # Start Studio at localhost:4111 (text mode)
npm run typecheck    # Verify types before running
npm run eval         # Run all eval cases in text mode; exits 0 on pass, 1 on fail
npx supabase start   # Start local Supabase (Docker required)
```

Eval runs with `USE_AIMOCK=false` hit the real Anthropic API and incur cost. Use `USE_AIMOCK=true` with AIMock running for free deterministic runs during development.

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
