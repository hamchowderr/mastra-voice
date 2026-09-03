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

`livekit-simulations` is runnable: `lk` is 2.18.3 (past the v2.16.7 floor for
Node.js agents) and `@livekit/agents ^1.7.0` clears the 1.6.0 one. Public beta,
no waitlist.

Note the skill's own beta block is stale — it warns that runs need the project
specially enabled, and that audio mode does not exist. Neither matches what
shipped: `lk agent simulate audio` exists, `SIMULATION_MODE_AUDIO = 2` is in
`@livekit/protocol`, and `@livekit/agents` parses it. Trust the CLI over the
skill text here. Simulations still judge a transcript, so they narrow the
real-call checklist without replacing it.

The worker needs no changes to take part: a simulation arrives as an ordinary
job carrying an `lk.simulator.dispatch` attribute, and `ctx.simulationContext()`
returns `undefined` on a normal call. `@mastra/livekit` exposes no simulation
surface, so the optional `onSimulationEnd` veto is unavailable — the simulator's
own verdict stands alone.

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
npx skills add mastra-ai/skills     --skill '*' --agent claude-code -y
npx skills add livekit/agent-skills --skill '*' --agent claude-code -y
```

This writes real files, not symlinks. The CLI only symlinks when installing to
several agents at once, where it keeps one canonical copy and links each agent
directory to it; with a single agent there is nothing to share, so it copies.
(`--copy` forces that behaviour and is harmless, but it changes nothing here —
verified byte-identical against a default install.)

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

The model is an **`@ai-sdk/anthropic` instance**, not a model-router string. Mastra accepts either — `MastraModelConfig` includes `LanguageModelV1..V4`, the AI SDK's own interfaces — and `@mastra/livekit` never inspects the model, so the voice path follows the agent.

It is wired as a **function** (`model: voiceModel`), and that is not stylistic. `createAnthropic()` captures its base URL at construction; agents are built at module scope, which runs before `configureAIMock()` can rewrite `ANTHROPIC_BASE_URL`. A module-scope `anthropic(...)` singleton would bake in the real endpoint and every eval would silently bill Anthropic instead of hitting the mock. Mastra's `model` is a `DynamicArgument`, so a factory is resolved per request — after boot. **Never collapse `lib/model.ts` into a top-level constant.**

Stay on Anthropic for the text model: OpenAI's Responses API (`/v1/responses`) is not something AIMock can match fixtures against, while `/v1/messages` it handles natively. **No Google providers** — this project uses none.

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
2. **SIP endpoint** — `lk project list --json`, take `ProjectId` (`p_<id>`), strip
   `p_`, giving `sip:<id>.sip.livekit.cloud`, port 5060. The endpoint most
   providers want is that URI WITHOUT the `sip:` prefix.

   **It is the ProjectId, NOT the URL subdomain.** Those differ: a project on
   `wss://my-thing-ab12cd34.livekit.cloud` with ProjectId `p_xyz789` has SIP host
   `xyz789.sip.livekit.cloud`, not `my-thing-ab12cd34.sip.livekit.cloud`. Getting
   this wrong is invisible until a call is placed, and DNS cannot catch it —
   `*.sip.livekit.cloud` is wildcarded, so the wrong host resolves happily.

   `lk project list --json` returns an EMPTY `ProjectId` for a project added by
   hand with `lk project add` rather than through `lk cloud auth`, and re-running
   `lk cloud auth` does not reliably backfill it. When it is empty, read the
   ProjectId off the project's settings page in the LiveKit Cloud dashboard.
   Do not substitute the URL subdomain — it is a different string.
3. **Inbound trunk** — `lk sip inbound create inbound-trunk.json`. One per phone number, reused for every call. Do NOT create one per call: trunks are cached long-lived objects and per-call creation degrades reliability at scale.
4. **Dispatch rule** — `lk sip dispatch create dispatch-rule.json`, with `roomConfig.agents[].agentName`. Without `roomConfig` the caller lands in a room no agent ever joins.
5. **Verify** — `lk sip inbound list` and `lk sip dispatch list` before placing a call.

**PII — matters here because this template ships compliance controls.** `dispatchRuleIndividual` names the room after the CALLER'S PHONE NUMBER. LiveKit writes room names into logs and traces, and PII redaction does NOT strip them. For regulated calls, route to a predetermined room with a generated ID instead of using an individual rule.

**A worker must always be registered.** Scale-to-zero deregisters it from LiveKit, and an inbound call then connects to silence. Only one worker flavor can run at a time — they all register under the same `agentName`.

**Read the carrier's log before you touch LiveKit.** A call that never reaches LiveKit cannot be a LiveKit fault, and the carrier's API says which case you are in. On Telnyx, SIP-trunk calls are in `GET /v2/detail_records?filter[record_type]=sip-trunking`. They are NOT in `/v2/call_events`, which only records Call Control calls and therefore stays empty while SIP trunking fails — an empty result there reads as "no call arrived" and is the wrong conclusion.

In a Telnyx record, `sip_invite_failure_status: 404` with an **empty `connection_id`** means Telnyx could not resolve the number to any destination and refused the call at ingress without sending an INVITE. That is provisioning or account state on the carrier's side. Rebuilding the trunk, the dispatch rule, or the connection cannot fix it — the decisive check is to point the number at any other destination the carrier offers (a native call-control app, say) and re-read the record. If `connection_id` is still empty, it is a support ticket, not a config bug.

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
    { "name": "...", "input": "...", "expectedTool": "evaluateMath", "expectedKeywords": [] }
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
- **Never let a second `onnxruntime-node` into the tree** — both bindings load a library whose SONAME is `libonnxruntime.so.1`, so on Linux the first one loaded wins process-wide and the other throws inside the job subprocess's prewarm, where the rejection is logged at debug and the child exits `0`. Calls connect to silence and nothing names the cause. Held to one version by `overrides` in `package.json`; check with `npm ls onnxruntime-node`
- **Never wrap a Dockerfile model bake in `|| true`** — a swallowed failure ships an image that registers a worker which cannot serve a call. Both bakes run with `HOME=/app` (the downloaders resolve `os.homedir()`, not `HF_HOME`) and are each followed by a `test -f`
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
npm test             # Unit + harness tiers (vitest). No Docker, no DB, no key. ~6s
npm run test:harness # Just the harness tier: headless voice.AgentSession, no infra
npm run eval         # Run all eval cases in text mode; exits 0 on pass, 1 on fail
npx supabase start   # Start local Supabase (Docker required)
```

`npm test` is the fast gate — run it after any edit. `npm run eval` is the slow
one: it needs Postgres and either an API key or AIMock, so it is the gate to run
before shipping, not between edits. Every other surface — audio, simulations,
load, the compliance ledger — is mapped in [`docs/testing.md`](docs/testing.md).

Eval runs with `USE_AIMOCK=false` hit the real Anthropic API and incur cost. Use `USE_AIMOCK=true` with AIMock running for free deterministic runs during development.
