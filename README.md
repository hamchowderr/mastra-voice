# template-mastra-voice

A production-ready Mastra voice agent starter. Real-time speech-to-speech via **LiveKit**, first-class **compliance controls** (AI disclosure, consent, agent hang-up), a full eval pipeline, Docker, and CI — everything you need to ship a regulated voice agent without building the scaffold yourself.

> **v0.2.0 — breaking change.** The realtime transport moved from Gemini Live to LiveKit (`@mastra/livekit`). Gemini Live's in-process STS is gone; LiveKit now owns the audio loop (VAD, streaming STT, semantic turn detection, barge-in, TTS) while Mastra owns replies, tools, and memory. A voice deployment is now **two processes** — the Mastra HTTP server and a separate LiveKit worker. Upgrading from v0.1.x is not drop-in: re-read the Quickstart and Deployment sections.

**Scaffold this template:**

```bash
npx degit hamchowderr/template-mastra-voice my-agent && cd my-agent
```

---

## Quickstart (5 minutes)

**Prerequisites**: Node 22.13+, Docker Desktop, a Supabase project, an Anthropic API key, and LiveKit credentials ([LiveKit Cloud](https://cloud.livekit.io) or self-hosted).

```bash
# 1. Clone and install
git clone <repo> my-agent && cd my-agent
npm install

# 2. Configure environment
cp .env.example .env
# Fill in: APP_SECRET, SUPABASE_*, ANTHROPIC_API_KEY

# 3. Start local Supabase (first time only)
npx supabase start

# 4. Run Studio (text mode — no mic required)
npm run dev
# → Mastra Studio at http://localhost:4111
```

Chat with the `voiceAssistant` agent in Studio to verify the text pipeline works. Send:

> What time is it?

Expected: agent calls `getCurrentTime` and returns the current time.

### Talk to it (the LiveKit worker)

Real audio runs in a **second process** — the LiveKit worker — alongside the server:

```bash
# One-time: fetch the turn-detector model (Silero VAD already ships in node_modules)
npm run worker:download-files

# Start the worker (hot-reload dev). Requires LIVEKIT_URL/API_KEY/API_SECRET in .env.
npm run worker:dev
```

Then place a call from the hosted [LiveKit Agents Playground](https://agents-playground.livekit.io) (no frontend needed) — it dispatches to the same `agentName` the worker registers. AIMock and the eval gate cover only the **text** path; real audio is a **manual** checkpoint (see [Realtime voice](#realtime-voice)).

---

## Reachability

This template's agents are reachable through four standard protocols. Once the dev server is running (`npm run dev`), every registered agent can be called via:

### REST API

Direct HTTP calls — text mode only. The voice agent supports text input for integration testing and evals.

```bash
curl -X POST http://localhost:4111/api/agents/voiceAssistant/generate \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What time is it?"}]}'
```

For streaming responses, use `/stream` instead of `/generate`. Full OpenAPI spec at `/api/openapi.json`. Interactive docs at `/swagger-ui` (dev only).

#### Working memory (persist context per user)

The `voiceAssistant` has **memory** tuned for voice latency (resource-scoped — see `src/mastra/lib/memory.ts`): working memory is **read-only to the agent** (`agentManaged: false`, so it never writes on the audio path), semantic recall is kept **small** (topK 3), and observational memory is sized to distill off-call. It applies to the **text** path below; pass `memory.resource` (a stable user ID) and `memory.thread` (the conversation ID) to persist across conversations:

```bash
curl -X POST http://localhost:4111/api/agents/voiceAssistant/generate \
  -H "Content-Type: application/json" \
  -d '{
    "messages":[{"role":"user","content":"What time is it?"}],
    "memory":{"resource":"user-alice-456","thread":"conversation-123"}
  }'
```

**Note:** these memory processors apply to the text `/generate` path. Semantic recall is on but deliberately small, and working-memory writes are kept off the loop — both to protect voice latency (see `src/mastra/lib/memory.ts`).

### A2A (Agent-to-Agent Protocol)

Google's open standard for agent-to-agent communication. JSON-RPC over HTTP.

```bash
# Get agent card
curl http://localhost:4111/api/.well-known/voiceAssistant/agent-card.json

# Send a message (JSON-RPC)
curl -X POST http://localhost:4111/api/a2a/voiceAssistant \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":{"kind":"message","messageId":"msg-1","role":"user","parts":[{"kind":"text","text":"What time is it?"}]}}}'
```

Use this when another agent (in CrewAI, LangGraph, ADK, or any A2A-compatible framework) needs to delegate work to this template's agent.

### MCP (Model Context Protocol)

Anthropic's open standard for agent-tool integration. The template's MCPServer exposes every agent as a callable tool at `/api/mcp/voice-mcp/mcp`.

To use from Claude Desktop, add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "template-mastra-voice": {
      "url": "http://localhost:4111/api/mcp/voice-mcp/mcp"
    }
  }
}
```

Each agent appears as a tool named `ask_<agentId>`. Useful during development (call your own agent from your IDE) and for cross-system integration.

### Studio (visual UI + Editor)

Open `http://localhost:4111` in a browser. Studio provides:

- Interactive chat with each agent (text mode — Studio does not stream audio)
- Trace inspection for every run
- Metrics dashboard (cost, latency, errors)
- **Agent Editor**: Non-developers iterate on agent instructions, prompts, and tools without touching code. Changes are versioned with draft/publish workflow.

The Editor is intended for product teams, prompt engineers, or subject-matter experts to tune behavior between deploys. Code-defined agents have read-only `id`, `name`, and `model` fields; everything else is editable through Studio.

For production deployment, secure Studio behind authentication. See [Mastra's auth docs](https://mastra.ai/docs/server/auth/overview).

---

## File Structure

```
template-mastra-voice/
├── src/
│   ├── lib/
│   │   └── env.ts                  # Zod-validated env loader — crashes on bad config
│   └── mastra/
│       ├── index.ts                # Entry point: env → AIMock → Mastra instance
│       ├── voice-worker.ts         # LiveKit worker: audio loop + greeting/consent/hang-up
│       ├── agents/
│       │   └── _example.ts         # voiceAssistant agent — copy this for new voice agents
│       ├── lib/
│       │   ├── aimock.ts           # Routes LLM calls to AIMock when USE_AIMOCK=true
│       │   ├── memory.ts           # Voice-tuned Memory baseline (read-only WM, small recall)
│       │   ├── voice.ts            # Shared voice agent id/name constants
│       │   ├── processors.ts       # Shared input/output processor baseline
│       │   ├── consent-ledger.ts   # In-process consent store (enforce within a call)
│       │   ├── compliance-ledger.ts# Durable per-call audit trail → Dolt (versioned)
│       │   ├── dolt.ts             # Dolt connection + attributed commit()
│       │   └── supabase.ts         # Supabase client factory
│       ├── scorers/
│       │   ├── _example.scorers.ts # answerRelevancy scorer
│       │   └── datasets/
│       │       └── _example.json   # Eval dataset — 5 cases with thresholds
│       └── tools/
│           ├── time-and-math.ts    # getCurrentTime + evaluateMath example tools
│           ├── consent.ts          # recordConsent tool (capture caller's decision)
│           ├── end-call.ts         # endCall tool (agent-initiated hang-up)
│           └── dolt.ts             # doltQuery/doltWrite/doltHistory (versioned data)
├── fixtures/                       # AIMock fixtures (voice-assistant.json) for the eval gate
├── scripts/
│   └── eval.ts                     # Offline CI eval gate — exits 0/1
├── prompts/
│   ├── README.md                   # Index of agent-building prompts
│   ├── build-agent.md              # Parameterized prompt for adding a text agent
│   └── build-voice-agent.md        # Parameterized prompt for adding a voice agent
├── .github/
│   └── workflows/
│       └── ci.yml                  # typecheck → build + eval (parallel) → docker
├── Dockerfile                      # Multi-stage; ONE image runs the server OR the worker
├── docker-compose.yml              # server + worker + postgres(pgvector) + dolt
├── .env.example                    # All required env vars with comments
└── AGENTS.md                       # Conventions for AI coding agents
```

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start Mastra Studio at localhost:4111 (text mode) |
| `npm run build` | Bundle the server for production (output → `.mastra/output/`) |
| `npm run start` | Start production server (no Studio) |
| `npm run worker:dev` | Start the LiveKit worker with hot reload (dev only) |
| `npm run worker:start` | Start the LiveKit worker in production mode |
| `npm run worker:download-files` | Fetch the turn-detector model (one-time; bake into the image) |
| `npm run eval` | Run offline eval gate against all cases in the dataset |
| `npm run typecheck` | TypeScript type check (zero-emit) |
| `npm run score:list` | List registered scorers |

> The worker (`worker:*`) is a **separate process** from the server. `worker:dev` is hot-reload only — never ship it; use `worker:start` in production.

---

## Adding a New Voice Agent

1. Copy `src/mastra/agents/_example.ts` → `src/mastra/agents/my-agent.ts`
2. Rename the agent, update `id`, `instructions`, `model`, tools, and voice config
3. Register it in `src/mastra/index.ts` under `agents:`
4. Add eval cases to a new dataset file in `src/mastra/scorers/datasets/`
5. Use `prompts/build-voice-agent.md` with Claude Code to generate a complete voice agent from a description

---

## Running Evals

Evals run in text mode — no mic or audio required.

```bash
# Against the live provider API
npm run eval

# Against AIMock (deterministic, no API cost)
npx @copilotkit/aimock --config aimock.json &
USE_AIMOCK=true npm run eval

# Custom dataset
node --env-file=.env --import tsx/esm scripts/eval.ts path/to/dataset.json
```

### CI eval coverage

The CI eval gate runs against AIMock (deterministic, no API cost) and asserts on the **text** path only — AIMock can't intercept the realtime WebRTC/WebSocket audio stream. All 5 cases have fixtures in `fixtures/voice-assistant.json`, so CI validates the full tool-calling matrix.

What CI validates (4 jobs):
- **Typecheck** — full
- **Build** — full (`mastra build`)
- **AIMock eval** — all 5 cases (tool-calling, no-tool, graceful goodbye) against a bare `postgres:16` service
- **Docker** — the image builds

Voice quality — disclosure playout, turn detection, barge-in, tool filler, consent capture, agent hang-up — can NOT be validated by AIMock. It's a **manual** checkpoint with real audio (see [Realtime voice](#realtime-voice)).

To run the eval against the live provider (real API cost) instead of AIMock:

```bash
npm run eval
```

---

## Docker

**One image, two services.** The same image runs either the Mastra **server** (HTTP + Studio, the default command) or the LiveKit **worker** (outbound audio loop, `node --import tsx src/mastra/voice-worker.ts start`). `docker-compose.yml` runs both plus Postgres (pgvector) and Dolt.

```bash
# Build the shared image once
docker compose build

# Run the full stack (server + worker + postgres + dolt)
docker compose up -d

# Health check (server only — the worker has no HTTP port)
curl http://localhost:4111/health
```

The worker connects **outbound** to LiveKit — no inbound ports, no public domain. Keep **at least one worker always on**: with zero workers a call connects to silence, and scaling to zero deregisters it from LiveKit. Only one worker flavor runs at a time (they all register under the same `agentName`).

Managed single-process HTTP hosts (Mastra Cloud, Railway, Cloud Run) can host the **server** but not the worker — run the worker where a long-lived outbound process is allowed. This template targets Coolify on a VPS, which runs Docker Compose directly. Both processes write to the same Postgres/Dolt concurrently, which those stores support (a single-writer store would not).

---

## Deployment Notes

### Docker image size

The image is large — `node:22-slim` (Debian, glibc) is required because `node:22-alpine` (musl) breaks the native modules: `onnxruntime-node` (fastembed embeddings, plus LiveKit's Silero VAD and turn-detector), `sharp`, and the native tokenizers all ship glibc-linked prebuilds with no musl build.

It also carries the **worker runtime** (production `node_modules` + `src` + `tsx`), because the worker runs from source — bundling it would drag in LiveKit's native deps. The server bundle alone is ~676MB; the shared two-service image is larger. Alpine is not a shortcut: the ONNX models the worker needs are the reason the image is big, and the same reason musl is off the table.

### Hardware & scaling

The worker needs **no GPU**. STT (`deepgram/nova-3`), TTS (`cartesia/sonic-3`), and the LLM all run remotely (LiveKit Cloud inference + your model provider). On-box it runs only small ONNX models — Silero VAD, turn detection, and the 384-dim embeddings for semantic recall — plus the JS agent loop and Postgres I/O.

Its cost is **RAM-dominated**: each concurrent call spins a job runner that re-imports the full Mastra app (~2GB), the base worker is ~1GB, and each prewarmed idle runner (`numIdleProcesses`) holds ~2GB.

- **Local dev:** 32GB is comfortable; 16GB is the practical floor, and only if little else runs — one call is ~5GB (base + prewarm + active runner) on top of Docker, a browser, and your editor. Set `numIdleProcesses: 0` to drop the idle spare, and run the call client on a second device (phone or laptop) so the browser's WebRTC encoding doesn't compete with the worker for CPU. An NVMe SSD helps model load.
- **Production:** budget ~1.5–2GB RAM and ~1–2 vCPU per concurrent call — a 4 vCPU / 8–16GB instance handles several. Scale **horizontally**: LiveKit dispatches across every registered worker, so add worker replicas for volume rather than enlarging one box, and keep the worker region-close to your LiveKit project to minimize round-trip to the cloud STT/TTS. The compose `worker` service reserves 2GB / limits 4GB.

## Common Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid environment variables` on boot | Missing or malformed `.env` | Check each var listed in the error against `.env.example` |
| `ECONNREFUSED 127.0.0.1:54322` | Local Supabase not running | `npx supabase start` |
| Docker container crashes (SIGSEGV) | Native modules (onnxruntime, sharp) need glibc | Use `node:22-slim`, not `node:22-alpine` |
| `ECONNREFUSED` inside Docker | `127.0.0.1`/`localhost` in a DB URL | In compose, use the service names (`postgres`, `dolt`) — already wired in `docker-compose.yml` |
| Call connects to silence | No worker running (or scaled to zero) | Keep ≥1 `worker` service up; check it registered under the right `agentName` |
| `runner initialization timed out` | Worker subprocess re-imports ~2GB (fastembed/onnx) | Already raised via `initializeProcessTimeout` in `voice-worker.ts`; if it persists, the host is RAM-starved (see below) |
| Responses lag; log shows `inference is slower than realtime` (delay climbing) | Host RAM/CPU starved — unrelated Docker stacks running, or the call's browser sharing the box | Free RAM (`docker ps`, then `supabase stop --project-id <id>` on strays), set `numIdleProcesses: 0`, run the call client off-box |
| Agent not listed in Studio | Not registered in `mastra.agents` | Add to `src/mastra/index.ts` |
| PostHog telemetry noise | Mastra runtime phones home on startup | Set `MASTRA_TELEMETRY_DISABLED=1` in `.env` |

---

## Environment Variables

See `.env.example` for the full list with comments. Minimum required:

- `APP_SECRET` — min 32 chars, generate with `openssl rand -hex 32`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`
- At least one of: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — the realtime voice transport; all three required

---

## Realtime voice

Real audio runs through **LiveKit** (`@mastra/livekit`), not the server. Two processes:

- **Server** (`npm run dev` / `start`) — the Mastra HTTP API + Studio. Text path, evals, REST/A2A/MCP.
- **Worker** (`npm run worker:start`) — a standalone process that connects to LiveKit. LiveKit owns the audio loop (VAD, streaming STT, semantic turn detection, barge-in, TTS); Mastra owns replies, tools, and memory. They talk over the LiveKit room. The worker is **not** bundled by `mastra build` — it runs from source via `tsx`.

STT/TTS route through **LiveKit Cloud inference** (`deepgram/nova-3`, `cartesia/sonic-3`) using just your `LIVEKIT_*` credentials — no separate Deepgram/Cartesia accounts. LiveKit Inference serves STT and TTS, **not** the LLM: the reply still comes from the Mastra agent's model.

### Compliance controls (the headline feature)

The worker ships a regulated-voice surface most tutorials skip — configured in `src/mastra/voice-worker.ts`:

- **AI disclosure** — a non-interruptible greeting states the caller is speaking with an AI at first contact (EU AI Act Art. 50), with periodic re-disclosure on long calls (California SB 243). Spoken via TTS with no LLM round-trip, and persisted to the thread as evidence.
- **Consent — declare → capture → enforce** — the worker declares required consents (`configuration.consentPolicy`); the agent's `recordConsent` tool captures the caller's yes/no; enforcement is deny-by-default at `onCallEnd` (e.g. no call summary is stored unless consent was granted).
- **Agent-initiated hang-up** — the agent says goodbye then calls `endCall`; the worker waits for the closing words, plays a guaranteed sign-off, and disconnects. A `stopWhen` guard structurally stops the loop so the model can't speak past its goodbye.
- **Versioned audit ledger** — disclosure + consent + hang-up records are committed to **Dolt** as one attributed, diffable commit per call (`src/mastra/lib/compliance-ledger.ts`), off the caller's clock. Dormant until `DOLT_*` is set + the compose `dolt` service runs.

### Where call data goes (data residency)

The compliance controls above are about *what you tell the caller*. This is about *where their voice actually travels* — a separate question, and one you must answer for yourself before deploying to regulated callers.

A single call involves three external parties beyond your own infrastructure:

| Leg | Goes to | Carrying |
|---|---|---|
| Transport | Your `LIVEKIT_URL` (LiveKit Cloud unless self-hosted) | The live audio stream |
| STT + TTS | `agent-gateway.livekit.cloud` (**US**, hardcoded default) | Raw caller audio, and the synthesized reply |
| LLM | Anthropic | The transcribed conversation + memory context |

**Caller audio does not stay on your VPS.** `stt: 'deepgram/nova-3'` and `tts: 'cartesia/sonic-3'` are LiveKit *Inference* model strings: they resolve to LiveKit's US agent-gateway, authenticated with your `LIVEKIT_API_KEY`. That is the convenience — one credential, no separate Deepgram or Cartesia account — and it is also the trade.

**Self-hosting the LiveKit server does not change this.** The inference endpoint is derived independently of `LIVEKIT_URL`. To keep STT/TTS off LiveKit Cloud you must either:

- set `LIVEKIT_INFERENCE_URL` to your own gateway, or
- pass real plugin instances instead of model strings (`stt: new deepgram.STT({...})`), using your own provider accounts and their regions.

Likewise, the audit ledger records *that* consent was captured — it does not constrain where the audio was processed.

None of this is a defect. It is the default data path, and for many deployments it is fine. But a template that ships EU AI Act and SB 243 controls invites use with EU callers, so the path is documented here rather than left to be discovered. Whether it satisfies your obligations is a question for you and your counsel, not for this README.

### Model swap-ins

The agent model is `anthropic/claude-haiku-4-5` — a **non-reasoning** model on purpose: time-to-first-token is what the caller hears, and a reasoning model spends seconds "thinking" every turn. Haiku is also the default because it's the one provider that routes cleanly through AIMock, keeping the CI eval green. Non-reasoning swap-ins: `google/gemma-4-31b-it` (LiveKit's voice-tuned default) or `openai/gpt-4.1-mini`. Edit `model` in `src/mastra/agents/_example.ts`.

### Manual verification (required)

AIMock and the eval gate cover the text path only. Voice quality is a **manual** checkpoint with real hardware — place a call from the hosted [LiveKit Agents Playground](https://agents-playground.livekit.io) and verify: the disclosure plays uninterruptibly, turn detection doesn't cut you off mid-thought, barge-in stops generation, tool filler speaks, consent captures, the agent hang-up signs off cleanly, and the thread transcript matches what you heard.

> **Note:** `turnDetection: 'multilingual'` currently uses LiveKit's text-based turn detector, which `@livekit/agents` marks deprecated. The migration to the on-device audio EOT detector is tracked but deferred until it can be verified with real audio (it's a behavior change to the core turn-taking UX, not a drop-in swap).

---

## For AI Coding Agents

See `AGENTS.md` for conventions, boot order, import rules, voice-specific patterns, and things to never do.
