<div align="center">

# 📞 Mastra Voice

### Answer the phone with an AI agent — disclosure, consent, and audit built in.

**A production-ready [Mastra](https://mastra.ai) voice agent you can clone and deploy.** Real-time speech-to-speech over [LiveKit](https://livekit.io), with the compliance surface regulated calls actually need — an AI-disclosure greeting, runtime consent capture, agent-initiated hang-up, and a versioned audit ledger — plus evals, Docker, and CI.

[![License: ISC](https://img.shields.io/badge/license-ISC-blue)](#-license)
[![Version: 0.2.0](https://img.shields.io/badge/version-0.2.0-orange)](https://github.com/hamchowderr/mastra-voice/releases/tag/v0.2.0)
[![Node: 22.13+](https://img.shields.io/badge/node-22.13%2B-339933?logo=node.js&logoColor=white)](#-getting-started)
[![Built on Mastra](https://img.shields.io/badge/built%20on-Mastra-000)](https://mastra.ai)
[![Realtime by LiveKit](https://img.shields.io/badge/realtime-LiveKit-1f8cf9)](https://livekit.io)

</div>

---

## ⚡ What it does

Someone calls. The agent answers, states that it's an AI, captures the consent the call requires, has the conversation, then says goodbye and hangs up. Each of those moments is written to a versioned ledger.

Included:

- **AI disclosure** — a non-interruptible greeting at first contact (EU AI Act Art. 50), re-disclosed periodically on long calls (California SB 243). Spoken via TTS with no LLM round-trip.
- **Consent — declare → capture → enforce** — the worker declares what a call needs, the agent's `recordConsent` tool captures the caller's answer, and enforcement is **deny-by-default** at end of call.
- **Agent-initiated hang-up** — the agent says goodbye, then a `stopWhen` guard structurally stops the loop so the model can't talk past its own sign-off.
- **Versioned audit ledger** — disclosure, consent, and hang-up records commit to [Dolt](https://www.dolthub.com/) as one attributed, diffable commit per call.

Underneath: LiveKit handles VAD, streaming STT, semantic turn detection, barge-in, and TTS. Mastra handles replies, tools, and memory tuned so nothing writes on the audio path.

---

## 🚀 Getting started

**Prerequisites**

- **Node.js 22.13+** — `node --version`
- **Docker Desktop** (or any Docker daemon) — `npx supabase start` boots Postgres + pgvector inside it
- **A Supabase project** — local is fine
- **An Anthropic API key** — the agent's model
- **LiveKit credentials** — [LiveKit Cloud](https://cloud.livekit.io) or self-hosted

Four commands from a clean checkout to a working agent:

```bash
# 1. Clone and install
git clone https://github.com/hamchowderr/mastra-voice.git my-agent
cd my-agent && npm install

# 2. Configure environment — every variable is documented inline
cp .env.example .env
#    Required: APP_SECRET, SUPABASE_*, ANTHROPIC_API_KEY, LIVEKIT_*

# 3. Boot local Supabase (first time only)
npx supabase start

# 4. Start the server + Studio on :4111
npm run dev
```

Open `http://localhost:4111`, chat with the `voiceAssistant` agent, and send *"What time is it?"* — it should call `getCurrentTime` and answer. That proves the text pipeline end to end.

### 🎙️ Then talk to it

Audio runs in a **second process**. Start it in another terminal:

```bash
# One-time: fetch the turn-detector model (Silero VAD already ships in node_modules)
npm run worker:download-files

# Start the worker — needs LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
npm run worker:dev
```

With the worker running, open Studio at `http://localhost:4111`, pick the `voiceAssistant` agent, and press **Start voice call**. Studio ships a LiveKit client and calls `/voice/livekit/connection-details` — the route this template registers — so it connects to your worker with no extra setup. This is the fastest way to hear the agent.

The hosted [LiveKit Agents Playground](https://agents-playground.livekit.io) is the alternative when you want to test from another machine or outside Studio.

Studio's **text** chat is a different thing: it exercises the agent's replies and tools, but not audio. Turn detection, barge-in, and TTS only run on a voice call.

### ☎️ Give it a phone number

LiveKit handles SIP telephony, and the hang-up path already uses `ctx.deleteRoom()` because it terminates a SIP caller correctly instead of leaving a dangling leg. Everything under **What it does** applies identically to a phone call.

Buy a number from a SIP provider (Twilio, Telnyx, Plivo, Wavix), point its trunk at your LiveKit SIP endpoint, then create the inbound trunk and dispatch rule with the [LiveKit CLI](https://docs.livekit.io/home/cli/cli-setup/):

```bash
# 1. Find your SIP endpoint. Take ProjectId and strip the `p_` prefix:
#      p_<id> → <id>.sip.livekit.cloud   (port 5060, usually no `sip:` prefix)
#    This is the ProjectId, NOT the URL subdomain — they are different strings,
#    and `*.sip.livekit.cloud` is wildcarded so a wrong host still resolves.
#    If ProjectId comes back empty (projects added via `lk project add` rather
#    than `lk cloud auth`), read it from the LiveKit Cloud dashboard.
lk project list --json

# 2. Inbound trunk — one per phone number, reused for every call
cat > inbound-trunk.json <<'JSON'
{ "trunk": { "name": "mastra-voice", "numbers": ["+15105550100"] } }
JSON
lk sip inbound create inbound-trunk.json

# 3. Dispatch rule — routes callers to a room AND dispatches this worker.
#    agentName MUST match VOICE_AGENT_NAME in src/mastra/lib/voice.ts.
cat > dispatch-rule.json <<'JSON'
{
  "dispatch_rule": {
    "name": "mastra-voice inbound",
    "rule": { "dispatchRuleIndividual": { "roomPrefix": "call-" } },
    "roomConfig": { "agents": [{ "agentName": "mastra-voice" }] }
  }
}
JSON
lk sip dispatch create dispatch-rule.json

lk sip inbound list && lk sip dispatch list   # verify
```

A mismatched `agentName` does not error — LiveKit accepts the call and never dispatches a worker, so the caller hears silence. Check it first when a phone call connects to nothing.

**When a call fails, read the provider's log before touching LiveKit.** A call that never reaches LiveKit cannot be a LiveKit problem, and the provider's own API will say so. On Telnyx the relevant log is:

```bash
# SIP-trunk calls. NOT /v2/call_events — that only records Call Control calls,
# so it stays empty while SIP trunking fails, which reads as "no call arrived".
curl -s -H "Authorization: Bearer $TELNYX_API_KEY" \
  "https://api.telnyx.com/v2/detail_records?filter[record_type]=sip-trunking"
```

An `sip_invite_failure_status: 404` with an **empty `connection_id`** means the provider could not resolve the number to any destination and refused the call itself — it never sent an INVITE. That is a provider-side provisioning or account problem, not a trunk, dispatch-rule, or worker problem, and no amount of reconfiguring on the LiveKit side will change it. To confirm, assign the number to any other destination the provider offers; if the record still shows an empty `connection_id`, open a support ticket rather than rebuilding your config.

> **PII warning.** `dispatchRuleIndividual` names each room after the **caller's phone number**. LiveKit records room names in logs and traces, and its [PII redaction](https://docs.livekit.io/deploy/observability/pii-redaction/) does **not** strip them. For regulated calls, route to a predetermined room with a generated ID instead.

### 🔐 Secrets with Infisical

`.env` works fine. If you'd rather not have secrets on disk, this project runs cleanly under [Infisical](https://infisical.com) — inject at runtime instead:

```bash
# Server + Studio
infisical run --path=/mastra-voice --silent -- npm run dev

# Worker (second terminal) — same secrets, same path
infisical run --path=/mastra-voice --silent -- npm run worker:start

# Evals
infisical run --path=/mastra-voice --silent -- npm run eval
```

Nothing in the app reads Infisical directly — it only ever sees environment variables, so `.env` and `infisical run` are interchangeable. Don't use `--recursive`; scope each project to its own path.

---

## 🔌 Reachability

Four standard protocols, all live once `npm run dev` is up.

### REST

Text mode. Useful for integration tests and evals.

```bash
curl -X POST http://localhost:4111/api/agents/voiceAssistant/generate \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What time is it?"}]}'
```

Use `/stream` for streaming. OpenAPI spec at `/api/openapi.json`; interactive docs at `/swagger-ui` (dev only).

Pass `memory.resource` (a stable user ID) and `memory.thread` (the conversation ID) to persist context across conversations:

```bash
curl -X POST http://localhost:4111/api/agents/voiceAssistant/generate \
  -H "Content-Type: application/json" \
  -d '{
    "messages":[{"role":"user","content":"What time is it?"}],
    "memory":{"resource":"user-alice-456","thread":"conversation-123"}
  }'
```

### A2A

The open agent-to-agent standard, JSON-RPC over HTTP. Use it when an agent in CrewAI, LangGraph, ADK, or anything A2A-compatible needs to delegate here.

```bash
curl http://localhost:4111/api/.well-known/voiceAssistant/agent-card.json
```

### MCP

Every agent is exposed as a callable tool at `/api/mcp/voice-mcp/mcp`. From Claude Desktop:

```json
{
  "mcpServers": {
    "mastra-voice": {
      "url": "http://localhost:4111/api/mcp/voice-mcp/mcp"
    }
  }
}
```

Each agent appears as `ask_<agentId>`.

### Studio

`http://localhost:4111` — interactive chat, trace inspection, a metrics dashboard, and the **Agent Editor**, where non-developers tune instructions and tools with a draft/publish workflow. Code-defined agents keep `id`, `name`, and `model` read-only; everything else is editable.

Secure Studio behind auth before exposing it — see [Mastra's auth docs](https://mastra.ai/docs/server/auth/overview).

---

## 🧠 How it works

```
Caller (phone via SIP · browser · playground)
        │
   LiveKit  ── transport + Inference (STT, TTS)
        │
   LiveKit worker          owns: VAD, streaming STT, turn detection,
   node --import tsx             barge-in, TTS
        │
   MastraVoiceAgent        owns: replies, tools, memory
        │
   Mastra server (REST · A2A · MCP · Studio) → Postgres + Dolt
```

**Two processes, one image.** The server and the worker run the same Docker image with different commands. Workers scale by call volume, the server by request volume.

**The worker takes no inbound traffic.** Calls arrive at LiveKit; the worker dials *out* to register. No port, no public domain.

**Never scale the worker to zero.** With no worker registered, a call connects to silence. Keep at least one running, and note that only one worker flavor can run at a time — they all register under the same `agentName`.

### Where call data goes

Three external legs per call. None of the audio stays on your host.

| Leg | Endpoint | Carries |
|---|---|---|
| Transport | `LIVEKIT_URL` | Live audio stream |
| STT + TTS | `agent-gateway.livekit.cloud` (US) | Raw caller audio; synthesized reply |
| LLM | Anthropic | Transcript + memory context |

`stt: 'deepgram/nova-3'` and `tts: 'cartesia/sonic-3'` are LiveKit **Inference** model strings, resolving to a hardcoded US gateway authenticated with `LIVEKIT_API_KEY`. This is what removes the need for separate Deepgram and Cartesia accounts.

**Inference carries STT and TTS only.** The model never touches it: `MastraVoiceAgent` supplies LiveKit's `llmNode`, so the `llm` slot goes unused and replies come from Mastra's model router — which is why the LLM leg above points at Anthropic and not at the gateway.

**Anthropic is only the default.** Mastra takes a model two ways, and both work on the voice path — `@mastra/livekit` never inspects the model:

| Form | Looks like | Good for |
| --- | --- | --- |
| Router string | `model: 'anthropic/claude-haiku-4-5'` | **187 providers** with no imports, resolved against a registry bundled inside `@mastra/core` |
| AI SDK instance | `model: voiceModel` → `createAnthropic({...})('claude-haiku-4-5')` | Per-provider control the string can't express: custom `fetch`, headers, middleware |

This project uses the **instance**, in `src/mastra/lib/model.ts`. Run `node .claude/skills/mastra/scripts/provider-registry.mjs --list` to see every provider the string form supports.

Either way there is **no Mastra Platform account** involved — the model is called directly from your own process with your own key.

> **If you switch to an AI SDK instance yourself, keep it a function.** `createAnthropic()` captures its base URL when constructed, and agents are built at import time — before `configureAIMock()` rewrites it. A module-scope singleton bakes in the real endpoint, and evals bill your provider instead of hitting the mock. Mastra resolves a factory per request, which is late enough. See the comment in `lib/model.ts`.

Self-hosting the LiveKit server does not move STT/TTS — the inference endpoint is derived independently of `LIVEKIT_URL`. To relocate it, set `LIVEKIT_INFERENCE_URL`, or pass plugin instances instead of model strings (`stt: new deepgram.STT({...})`) using your own provider accounts.

The Dolt ledger records that consent was captured. It does not constrain where audio was processed.

---

## 🧪 Build & test

Testing here comes in three tiers that cover genuinely different things. The first is text only — it checks what the agent *says and decides*. The second can drive the real audio pipeline. The third is you, on the phone, and nothing replaces it.

| Tier | Exercises | Covers audio? | Runs where |
| --- | --- | --- | --- |
| 1. Eval gate | Reply content, tool calls, scorers | No | CI, every PR |
| 2. Agent simulations | Multi-turn conversation vs. a simulated caller | Yes, in audio mode | LiveKit Cloud, on demand |
| 3. Real call | Barge-in, turn-taking, disclosure timing | **Yes** | Your ears |

### 1️⃣ Eval gate — automated, runs in CI

```bash
npm run typecheck    # tsc --noEmit, covers src/ and scripts/
npm run eval         # agent eval gate against the example dataset
npm run build        # mastra build → .mastra/output
npm run score:list   # list registered scorers
```

Evals run against a real provider by default, or deterministically against [AIMock](https://aimock.copilotkit.dev) with no API spend:

```bash
npx -y -p @copilotkit/aimock aimock -c aimock.json   # terminal 1
USE_AIMOCK=true npm run eval                         # terminal 2
```

CI runs four jobs on every PR: **typecheck**, **eval**, **build**, and **docker** — where the image is built *and both containers are started*, so a broken entrypoint fails CI instead of a deploy.

Each case is one fixed input with asserted tool calls and scorer output. That makes it a regression gate: it catches a change breaking something you already knew to check.

### 2️⃣ Agent simulations — a scripted caller, in text or in audio

LiveKit plays a scripted *caller persona* against the agent over a full conversation and has an LLM judge grade the result. Where the eval gate asserts known inputs, this surfaces the failures you didn't think to assert — a caller who withholds a required field, supplies an invalid one, or pushes at a guardrail.

The bundled `livekit-simulations` skill writes the scenario file locally from the agent's own code (nothing is uploaded) and enforces at least one scenario per identified risk.

```bash
lk agent simulate --scenarios scenarios.yaml src/mastra/voice-worker.ts         # text
lk agent simulate audio --scenarios scenarios.yaml src/mastra/voice-worker.ts   # full audio pipeline
```

**Audio mode drives the real STT→LLM→TTS path** with a simulated voice user, and can degrade the caller's audio on purpose:

| Flag | Simulates |
| --- | --- |
| `--background-noise` | Ambient noise mixed into the caller's audio |
| `--low-quality-microphone` | A poor microphone |
| `--packet-loss` | Dropped packets on the caller's track |

Requirements — a public beta with no waitlist and nothing to request access to:

| Requirement | Needed |
| --- | --- |
| LiveKit CLI | v2.16.7+ for Node.js agents (`winget upgrade LiveKit.LiveKitCLI`) |
| `@livekit/agents` | 1.6.0+ |
| LiveKit Cloud project | yes — runs execute on Cloud |

**The worker needs no changes to take part.** A simulation arrives as an ordinary job carrying an `lk.simulator.dispatch` attribute; `ctx.simulationContext()` returns `undefined` on a normal call, so the same worker serves both. The one thing `@mastra/livekit` does not expose is the optional `onSimulationEnd` veto, which would let your own checks fail a run the judge passed — the judge's own verdict still stands without it.

> Note the [LiveKit docs](https://docs.livekit.io/agents/start/testing/simulations/) still say audio mode "isn't available yet". The CLI ships it, `SIMULATION_MODE_AUDIO` is in the protocol, and the SDK parses it — the docs are behind. Whether Cloud accepts an audio run for a given project is worth confirming with one run before relying on it.

### 3️⃣ The real call — what a simulation still can't tell you

Audio simulations narrow this list; they don't empty it. The judge scores a *transcript*, so it can catch a dropped turn or a guardrail miss, but it cannot tell you the agent sounded right. Nothing automated hears prosody, or judges whether a pause felt like a hang-up.

So before shipping, place a real call and verify:

- The disclosure plays without being interruptible
- Turn detection doesn't cut you off mid-thought
- Barge-in stops generation
- The tool filler speaks while a tool runs
- Consent captures
- The agent's hang-up signs off cleanly
- The thread transcript matches what you actually heard

The eval gate cannot reach any of this either: AIMock's WebSocket support is text-frames-only, and LiveKit's `voice.testing` harness takes a string and skips the audio path. Both mock the *model*, not the microphone.

---

## 🐳 Docker

```bash
docker compose build                      # one image, both services
docker compose up -d                      # server + worker + postgres + dolt
curl http://localhost:4111/health         # server only — the worker has no HTTP port
```

The stack is four containers. Only `mastra` is public; `worker`, `postgres`, and `dolt` are reachable only on the internal network.

| Service | Public | Memory | Role |
|---|---|---|---|
| `mastra` | ✅ via Traefik | 1 GB | REST · A2A · MCP · Studio |
| `worker` | ❌ outbound only | 4 GB limit / 2 GB reserved | The audio loop |
| `postgres` | ❌ | — | Memory + semantic recall (pgvector) |
| `dolt` | ❌ | — | Versioned compliance ledger |

`pgdata` and `doltdata` must persist — the Dolt volume holds your entire audit history.

### Image size

`node:22-slim` (Debian, glibc) is required. `node:22-alpine` (musl) breaks `onnxruntime-node`, `sharp`, and the native tokenizers — all ship glibc-linked prebuilds with no musl build.

The image also carries the worker runtime (production `node_modules` + `src` + `tsx`), because the worker runs from source; bundling it would drag in LiveKit's native deps. That means `onnxruntime-node` is present **twice** — once in the server bundle `mastra build` produces, once in the worker's tree.

The build prunes what can't load: `onnxruntime-node` bundles binaries for every platform inside one package, so npm's `optionalDependencies` pruning can't reach them. Removing the macOS and Windows copies saves ~199 MB per tree, ~400 MB total. `linux/arm64` is kept so the same Dockerfile still builds for arm64.

### Hardware & scaling

**No GPU.** STT, TTS, and the LLM all run remotely. On-box it runs only small ONNX models — Silero VAD, turn detection, and 384-dim embeddings for semantic recall — plus the agent loop and Postgres I/O.

Cost is **RAM-dominated**: each concurrent call spins a job runner that re-imports the full Mastra app (~2 GB), the base worker is ~1 GB, and each prewarmed idle runner holds ~2 GB.

- **Local dev** — 32 GB is comfortable, 16 GB is the floor. One call is ~5 GB on top of Docker, a browser, and your editor. Set `numIdleProcesses: 0` and run the call client on a second device so the browser's WebRTC encoding doesn't compete for CPU.
- **Production** — budget ~1.5–2 GB RAM and 1–2 vCPU per concurrent call; a 4 vCPU / 8–16 GB instance handles several. Scale **horizontally**: LiveKit dispatches across every registered worker. Keep workers region-close to your LiveKit project.

---

## 🧯 Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid environment variables` on boot | Missing or malformed `.env` | Check each var in the error against `.env.example` |
| `ECONNREFUSED 127.0.0.1:54322` | Local Supabase not running | `npx supabase start` |
| Container crashes (SIGSEGV) | Native modules need glibc | Use `node:22-slim`, not `node:22-alpine` |
| `ECONNREFUSED` inside Docker | `127.0.0.1` in a DB URL | Use service names (`postgres`, `dolt`) — already wired in compose |
| Call connects to silence | No worker running, or scaled to zero | Keep ≥1 `worker` up; check it registered under the right `agentName` |
| `runner initialization timed out` | Subprocess re-imports ~2 GB | Already raised via `initializeProcessTimeout`; if it persists the host is RAM-starved |
| Replies lag; log shows `inference is slower than realtime` | Host RAM/CPU starved | Free RAM, set `numIdleProcesses: 0`, run the call client off-box |
| Agent missing from Studio | Not registered in `mastra.agents` | Add it in `src/mastra/index.ts` |

---

## ⚠️ Known limitations

- **`turnDetection: 'multilingual'`** uses LiveKit's deprecated text-based detector. The audio EOT `TurnDetector` can't be adopted yet: its constructor captures `getJobContext().inferenceExecutor`, and worker options are evaluated at module scope where that throws — leaving the executor `undefined`, which silently disables semantic turn detection rather than erroring. The fix is a job-scoped `turnDetection` factory upstream in `@mastra/livekit`.

---

## 🤖 For AI coding agents

See [`AGENTS.md`](AGENTS.md) for conventions, boot order, import rules, voice-specific patterns, and things to never do.

Three skills are vendored into `.claude/skills/` and committed, so a plain `git clone` is the only install step:

| Skill | Covers |
| --- | --- |
| `mastra` | Mastra APIs, verified against the installed version rather than model memory |
| `livekit-agents` | Worker lifecycle, room handling, the audio pipeline |
| `livekit-simulations` | Generating and running scenario tests against the agent |

`livekit-agents` is written for LiveKit Cloud; [`AGENTS.md`](AGENTS.md#scope-livekit-agents-before-following-it) says which parts to ignore here. The committed files are the pinned version — `skills-lock.json` only records a tree hash so `npx skills update` can spot upstream drift.

---

## 📜 License

ISC
