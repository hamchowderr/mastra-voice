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

Open `http://localhost:4111`, chat with the `voiceAssistant` agent, and send *"What is 47 times 23?"* — it should call `evaluateMath` and answer `1081`. That proves the text pipeline end to end. (Ask it the date instead and it answers straight from its instructions, with no tool call — see `TZ` in `.env.example`.)

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

**Studio is text-only. It does not stream audio.** Chatting with `voiceAssistant` here exercises the agent's instructions, tools, and memory — the same path evals use — but never the voice pipeline. VAD, turn detection, barge-in, STT, and TTS all live in the worker process, so a reply that reads perfectly in Studio can still sound wrong on a call. Judge how it *sounds* with the worker and a real call or a simulation.

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

**Two processes, two images, one Dockerfile.** The server and the worker share a base and the fastembed model, then each stage copies only the runtime it executes — the server has no `src/`, the worker has no `.mastra/output`. Neither can run the other's process, which is what makes the worker image correct on its own for hosts that cannot override a command. Workers scale by call volume, the server by request volume.

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

Self-hosting the LiveKit server does not move STT/TTS — the inference endpoint is derived independently of `LIVEKIT_URL`. Setting `LIVEKIT_INFERENCE_URL` relocates the gateway; leaving it entirely means passing plugin instances instead of model strings, below.

The Dolt ledger records that consent was captured. It does not constrain where audio was processed.

### Bring your own STT and TTS

Inference is the right default for a first run — one credential, no extra accounts, and you can hear the agent minutes after cloning. It is also metered on LiveKit credits, per second of audio transcribed and per character synthesized, so on real call volume it is the line item that grows fastest. Bringing your own accounts moves that spend onto contracts you negotiate directly, and reaches providers the gateway doesn't carry.

The worker takes either form in the same slot: `@mastra/livekit` types `stt` and `tts` as `voice.AgentSessionOptions['stt' | 'tts']` — *a LiveKit plugin instance or an inference model string*. Two packages and two lines, not a fork.

```bash
# Track the @livekit/agents version already in package.json — the plugins ship
# on the same release line (1.7.x today) and are versioned together.
npm install @livekit/agents-plugin-deepgram@^1.7.1 @livekit/agents-plugin-cartesia@^1.7.1
```

```ts
// src/mastra/voice-worker.ts
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as deepgram from '@livekit/agents-plugin-deepgram';

export default createLiveKitWorker({
  // …
  // Replaces:  stt: 'deepgram/nova-3',  tts: 'cartesia/sonic-3'
  stt: new deepgram.STT({ model: 'nova-3', language: 'en-US' }),
  tts: new cartesia.TTS({ model: 'sonic-3', voice: 'your-cartesia-voice-id' }),
});
```

`nova-3` and `sonic-3` are those plugins' own defaults, so this reaches the same two models the Inference strings resolved to — the route and the bill change, the voice does not. Each plugin reads its own key from the environment (`DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`) unless you pass `apiKey`, and both are listed commented-out in `.env.example`. **The app never reads them**, so `src/lib/env.ts` doesn't require them and a missing key surfaces at call setup rather than at boot — promote them into that schema once BYO is your permanent path. Every provider ships as `@livekit/agents-plugin-<name>` on the same version line: ElevenLabs, OpenAI, AssemblyAI, and the rest.

**Per-tenant or per-language selection belongs on the resolvers, not here.** `configuration.stt` and `configuration.tts` each take a function invoked once per call, after connect, with the call context — return anything the top-level option accepts, or `undefined` to fall through to it. The resolver wins when both are set.

```ts
// Module scope: one instance per locale, built once at import — NOT per call.
const sttByLocale = new Map([['nl', new deepgram.STT({ model: 'nova-3', language: 'nl' })]]);

// …inside createLiveKitWorker:
configuration: {
  // Dutch callers get a Dutch transcriber; every other call returns undefined
  // and falls through to the top-level `stt`. `metadata.requestContext` carries
  // whatever the dispatch rule put in the job metadata, so that is the routing
  // signal — dialed number, tenant id, locale, whatever you set.
  stt: ({ metadata }) => sttByLocale.get(String(metadata.requestContext?.locale)),
},
```

It runs on the call-setup path, before the caller hears anything, so keep it to a lookup. Constructing a plugin inside the resolver puts that work on every call's clock.

**One leg does not swap.** `turnDetection` still runs on LiveKit's inference gateway on your `LIVEKIT_*` credentials, whatever you do with STT and TTS, and the local alternative is not reachable from a module-scope instance. Swapping both providers therefore reduces your Inference spend to the per-turn detector call rather than eliminating it — **Known limitations** below has why, and why omitting `version` makes it worse rather than better.

---

## 🧪 Build & test

A text agent has one thing that can be wrong: what it says. A voice agent can say
the right words and still cut the caller off, answer four seconds late, talk over
an interruption, or connect to silence because nothing was registered to take the
call. No single surface catches all of that.

**[`docs/testing.md`](docs/testing.md) is the full map** — every surface, what it
proves, what it cannot prove, and what none of them cover. This is the short form.

| You want to know | Reach for | Cost |
| --- | --- | --- |
| Did I break a type? | `npm run typecheck` | free, seconds |
| Does the security-critical logic hold? | `npm test` | free, ~1s |
| Are the tools registered with the right schema? | `npm run test:harness` | free, ~5s |
| Does it answer a known question correctly? | `npm run eval` | **billed** — free under AIMock |
| Does the audio loop work? | `lk agent console` | inference minutes |
| Is the worker being dispatched at all? | `lk dispatch create` | negligible |
| Does it survive an awkward caller? | `lk agent simulate` | inference + judge |
| How many concurrent calls fit? | `lk perf agent-load-test` | inference × rooms |
| Did the compliance trail get written? | query the Dolt ledger | free |
| Does it *sound* right? | call it yourself | your time |

The first three need nothing running and take under ten seconds together — run
them on every edit:

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest. No Docker, no database, no API key
npm run test:harness # headless voice.AgentSession. No infrastructure at all
npm run build        # mastra build → .mastra/output
```

`npm run eval` is the slow gate. **It hits the real Anthropic API and bills the
key in `.env`**, because `USE_AIMOCK` defaults to `false`, and it needs Postgres
running. For a free deterministic run:

```bash
npx -y -p @copilotkit/aimock aimock -c aimock.json   # terminal 1
USE_AIMOCK=true npm run eval                         # terminal 2
```

CI runs five jobs on every PR: **harness** (no infrastructure at all),
**typecheck** (which also runs `npm test`), **eval**, **build**, and **docker** —
where *both* images are built and *both* containers are started from their own
image, so a broken entrypoint fails CI instead of a deploy.

### What automation still can't reach

Nothing above hears prosody. An audio simulation scores a *transcript*, so it can
catch a dropped turn or a guardrail miss, but not that the agent sounded rushed or
that a pause felt like a hang-up. AIMock's WebSocket support is text-frames-only,
and the `voice.testing` harness takes a string and skips the audio path — both
mock the *model*, not the microphone.

So before shipping, place a real call and verify the disclosure plays
uninterruptibly, barge-in stops generation, a mid-thought pause isn't treated as
end-of-turn, consent captures, and the hang-up signs off cleanly.
[`docs/testing.md`](docs/testing.md#8-does-it-sound-right) has the full checklist.

---

## 🐳 Docker

There are two deploy targets, and this is the default one: you run every process, including the databases. [LiveKit Cloud Agents](#-livekit-cloud-agents) is the alternative — LiveKit runs the worker container and you run the rest.

```bash
docker compose build                      # two images: server + worker
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

The worker runs from source rather than a bundle, because bundling it would drag in LiveKit's native deps — so it needs the production `node_modules`, `src` and `tsx`, and `onnxruntime-node` therefore exists in two trees: the server bundle `mastra build` emits, and the worker's own.

Both trees no longer land in one image. Each stage copies only what it runs, which keeps roughly 600 MB of server bundle out of the worker and 841 MB of worker tree plus the 441 MB turn-detector model out of the server:

| Payload | Server | Worker |
| --- | :---: | :---: |
| `.mastra/output` (bundle + Studio) | ✅ | — |
| `node_modules` + `src` + `tsx` | — | ✅ |
| `.cache/mastra` (fastembed, semantic recall) | ✅ | ✅ |
| `.cache/huggingface` (turn detector) | — | ✅ |

Only the fastembed model and the Debian base are shared, so building both targets costs little more than building one, and a host running both pulls the same bytes it always did.

The build prunes what can't load: `onnxruntime-node` bundles binaries for every platform inside one package, so npm's `optionalDependencies` pruning can't reach them. Removing the macOS and Windows copies saves ~199 MB per tree, ~400 MB total. `linux/arm64` is kept so the same Dockerfile still builds for arm64.

### Hardware & scaling

**No GPU.** STT, TTS, and the LLM all run remotely. On-box it runs only small ONNX models — Silero VAD, turn detection, and 384-dim embeddings for semantic recall — plus the agent loop and Postgres I/O.

Cost is **RAM-dominated**: each concurrent call spins a job runner that re-imports the full Mastra app (~2 GB), the base worker is ~1 GB, and each prewarmed idle runner holds ~2 GB.

- **Local dev** — 32 GB is comfortable, 16 GB is the floor. One call is ~5 GB on top of Docker, a browser, and your editor. Set `numIdleProcesses: 0` and run the call client on a second device so the browser's WebRTC encoding doesn't compete for CPU.
- **Production** — budget ~1.5–2 GB RAM and 1–2 vCPU per concurrent call; a 4 vCPU / 8–16 GB instance handles several. Scale **horizontally**: LiveKit dispatches across every registered worker. Keep workers region-close to your LiveKit project.

---

## 🚢 LiveKit Cloud Agents

The second target. LiveKit hosts the worker container itself, so the audio loop needs no host of your own — and it hosts *only* that container. There are no sidecars, so Postgres and Dolt have to become managed endpoints reachable from outside your network, and the Mastra HTTP server (REST, A2A, MCP, Studio) keeps running wherever it already runs.

| | Docker Compose | LiveKit Cloud Agents |
|---|---|---|
| Worker process | your host | LiveKit |
| Mastra server | your host | your host — unchanged |
| Postgres + Dolt | containers in the same stack | managed, externally reachable |
| Secrets | `.env`, read by compose | uploaded ahead of the container |
| Scaling | your orchestrator | LiveKit, per region |
| Portability | one `docker compose up`, on anything | LiveKit Cloud only |

Self-hosting stays the default because it is the one that runs anywhere and keeps the four processes in one file. Cloud Agents trades that away for not operating a worker host. The commands below were checked against `lk` 2.18.3; authenticate the CLI against the project first with `lk cloud auth`.

### Build the worker image

The Dockerfile's default target is the **HTTP server** — what compose and CI build, and it registers no worker at all. Cloud Agents runs one process per container, so it wants the `agent` target instead, whose `CMD` is the worker:

```bash
docker build --target agent -t mastra-voice-agent:latest .
```

`lk agent create` has no `--target` flag, and it reuses a `Dockerfile` already sitting in the working directory rather than generating one — so left to itself it would build that server stage and deploy a container that answers no calls. Select the stage locally and hand LiveKit the finished image with `--image`. Where there is no Docker daemon, `--image-tar ./image.tar` takes an OCI tar instead.

### Create the agent

Secrets are uploaded ahead of the container, not mounted into it. Put them in a file of `KEY=VALUE` lines, one per line — call it `.env.livekit` and the existing `.env.*` rule already keeps it out of git:

```bash
lk agent create \
  --image mastra-voice-agent:latest \
  --secrets-file .env.livekit \
  --region <region>                  # omit and it deploys to the nearest region
```

**That file needs the whole env schema, not just the LiveKit keys.** The worker imports the full Mastra app, so `src/lib/env.ts` validates everything at boot: `APP_SECRET`, all four `SUPABASE_*`, `ANTHROPIC_API_KEY`, and all three `LIVEKIT_*`. Add `DOLT_*` for the ledger and `TZ` for the agent's clock. Copying `.env` across wholesale fails twice over — its `SUPABASE_DB_URL` and `DOLT_HOST` name compose services or `127.0.0.1`, which resolve to nothing from LiveKit's side, and its blank optional entries are rejected unless you also pass `--ignore-empty-secrets`. A secret that has to arrive as a file rather than a variable goes through `--secret-mount` instead.

`lk agent create` writes `livekit.toml` beside it, carrying your project subdomain and the agent id LiveKit just minted:

```toml
[project]
  subdomain = "your-project-subdomain"

[agent]
  id = "CA_..."
```

Both values are yours, not the template's, so a committed copy would point every clone at an agent it cannot reach — which is why this repo gitignores the file instead of shipping one. Every later `lk agent` command reads the id from it; on a second machine, regenerate it with `lk agent config --id CA_...`.

### Ship, rotate, watch

```bash
docker build --target agent -t mastra-voice-agent:latest .
lk agent deploy --image mastra-voice-agent:latest                 # new version
lk agent update-secrets --secrets-file .env.livekit --overwrite   # rotate keys
lk agent status                    # current deployment
lk agent logs                      # tail
lk agent versions                  # what you can go back to
lk agent rollback                  # go back to it
```

`update-secrets` restarts the agent, so a key rotation costs the same interruption as a deploy — drain calls the same way.

### What carries over unchanged

`agentName` still has to match. The dispatch rule from **Give it a phone number** names `mastra-voice`, and a Cloud Agent that registers under anything else is dispatched nothing while LiveKit accepts the call, which the caller hears as silence.

**Only one worker flavor serves a call.** A Cloud Agent and your compose workers register under that same `agentName`, so running both means LiveKit round-robins calls between them — a useful cutover trick, and a bewildering bug when it isn't deliberate. Scale one to zero before depending on the other.

The `agent` stage's healthcheck probes `:8081`, which is where `@livekit/agents` serves its own endpoint in production mode — not the server's `:4111/health`, which this container never serves. It returns 503 for `inference process not running`, the failure described under **Known limitations**; that check is the prerequisite for anything acting on it.

---

## 🧯 Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid environment variables` on boot | Missing or malformed `.env` | Check each var in the error against `.env.example` |
| `ECONNREFUSED 127.0.0.1:54322` | Local Supabase not running | `npx supabase start` |
| Container crashes (SIGSEGV) | Native modules need glibc | Use `node:22-slim`, not `node:22-alpine` |
| `ECONNREFUSED` inside Docker | `127.0.0.1` in a DB URL | Use service names (`postgres`, `dolt`) — already wired in compose |
| Call connects to silence | No worker running, or scaled to zero | Keep ≥1 `worker` up; check it registered under the right `agentName` |
| Calls go silent after a busy period, worker still `running` | The shared inference process was killed and nothing restarts it | `docker compose ps` shows `unhealthy`; `docker compose restart worker`. See Known limitations |
| `process exited before initializing (code 0, signal null)`, no child output | Two `onnxruntime-node` versions in the tree — on Linux the second binding cannot load | `npm ls onnxruntime-node`; pin one via `overrides` (already pinned here) |
| `no native root CA certificates found` on connect | Runtime image has no OS trust store; `@livekit/rtc-node` is Rust and does not use Node's bundled CAs | Install `ca-certificates` in the runtime stage (already in the Dockerfile) |
| `Tokenizer file not found … fast-bge-small-en-v1.5` | Embedding model not baked, so the first call raced its own download | Bake it at build time with `warmup()` (already in the Dockerfile) |
| `runner initialization timed out` | Subprocess re-imports ~2 GB | Already raised via `initializeProcessTimeout`; if it persists the host is RAM-starved |
| Replies lag; log shows `inference is slower than realtime` | Host RAM/CPU starved | Free RAM, set `numIdleProcesses: 0`, run the call client off-box |
| Agent missing from Studio | Not registered in `mastra.agents` | Add it in `src/mastra/index.ts` |
| Cloud Agent starts, exits, logs `Invalid environment variables` | The uploaded secrets file is missing keys the full env schema requires | `lk agent update-secrets --secrets-file .env.livekit --overwrite` with every required var |
| Cloud Agent runs but never answers a call | Deployed the default Dockerfile target — that's the HTTP server, which registers no worker | Rebuild with `--target agent` and `lk agent deploy --image …` |

---

## ⚠️ Known limitations

- **A dead inference process is never replaced.** One shared subprocess runs the turn detector for every call. If it is killed — it stops answering pings under load, and its supervisor kills it — nothing starts another. End-of-turn detection then fails for *every* subsequent call while the worker keeps registering and accepting jobs, so calls connect and sit in silence. The worker's healthcheck on `:8081` reports `503 inference process not running`, and the `worker` service in `docker-compose.yml` probes it, but plain Compose only marks the container unhealthy — it restarts on process *exit*, not on health. Acting on it needs an orchestrator that does, or a restart-unhealthy sidecar.

- **`turnDetection` uses the cloud audio model.** `inference.eot.TurnDetector({ version: 'v1' })` runs over LiveKit's inference gateway on the same `LIVEKIT_*` credentials as the STT and TTS — no extra account, but it is a network hop per turn and it is not free. The local alternative (`'v1-mini'`) needs the job context's inference executor, which a module-scope instance cannot reach; adopting it needs a job-scoped `turnDetection` factory upstream in `@mastra/livekit`. Do not simply omit `version` — on a self-hosted worker the default resolves to `'v1-mini'`, which is exactly that degraded path.

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
