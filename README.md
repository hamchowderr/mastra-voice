# template-mastra-voice

A production-ready Mastra voice agent starter. Real-time speech-to-speech via LiveKit, full eval pipeline, Docker, CI — everything you need to ship a voice agent without building the scaffold yourself.

> **Migration in progress.** The realtime transport is moving from Gemini Live to LiveKit. The Gemini Live stack is removed and the LiveKit worker is not wired up yet, so the agent is text-mode only right now.

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

The `voiceAssistant` has **working memory** enabled (resource-scoped, leaner template — see `src/mastra/lib/memory.ts`). It applies to the **text** path below; pass `memory.resource` (a stable user ID) and `memory.thread` (the conversation ID) to persist across conversations:

```bash
curl -X POST http://localhost:4111/api/agents/voiceAssistant/generate \
  -H "Content-Type: application/json" \
  -d '{
    "messages":[{"role":"user","content":"What time is it?"}],
    "memory":{"resource":"user-alice-456","thread":"conversation-123"}
  }'
```

**Note:** these memory processors apply to the text `/generate` path. Semantic recall is intentionally off (latency).

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
│       ├── agents/
│       │   └── _example.ts         # voiceAssistant agent — copy this for new voice agents
│       ├── lib/
│       │   ├── aimock.ts           # Routes LLM calls to AIMock when USE_AIMOCK=true
│       │   └── supabase.ts         # Supabase client factory
│       ├── scorers/
│       │   ├── _example.scorers.ts # answerRelevancy scorer
│       │   └── datasets/
│       │       └── _example.json   # Eval dataset — 5 cases with thresholds
│       └── tools/
│           └── time-and-math.ts    # getCurrentTime + evaluateMath example tools
├── scripts/
│   └── eval.ts                     # Offline CI eval gate — exits 0/1
├── prompts/
│   ├── README.md                   # Index of agent-building prompts
│   ├── build-agent.md              # Parameterized prompt for adding a text agent
│   └── build-voice-agent.md        # Parameterized prompt for adding a voice agent
├── .github/
│   └── workflows/
│       └── ci.yml                  # typecheck → build + eval (parallel) → docker
├── Dockerfile                      # Multi-stage, node:22-slim runtime
├── docker-compose.yml              # Production compose
├── .env.example                    # All required env vars with comments
└── AGENTS.md                       # Conventions for AI coding agents
```

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start Mastra Studio at localhost:4111 (text mode) |
| `npm run build` | Bundle for production (output → `.mastra/output/`) |
| `npm run start` | Start production server (no Studio) |
| `npm run eval` | Run offline eval gate against all cases in the dataset |
| `npm run typecheck` | TypeScript type check (zero-emit) |
| `npm run score:list` | List registered scorers |

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

The CI eval gate runs against AIMock with text-mode assertions only. AIMock cannot intercept the realtime voice stream, and full tool-call coverage requires per-case fixtures that aren't included in v1.

What CI validates:
- Typecheck: full
- Build: full
- AIMock eval: partial — case 1 only (no-tool-call case). Tool-calling cases (2–5) require AIMock fixtures not included here.
- Docker: full

For full eval coverage, run locally with real API keys:

```bash
npm run eval
```

This validates all 5 cases against the live agent (~$0.05 in API costs).

---

## Docker

The voice CLI does NOT work in a container (no audio devices). The REST API and Studio work fine.

```bash
# Build
docker build -t my-agent:latest .

# Run
docker compose up -d

# Health check
curl http://localhost:4111/health
```

The `docker-compose.yml` already includes the `host.docker.internal` override for Supabase — no manual URL changes needed.

---

## Deployment Notes

### Docker image size

The production image is ~676MB because `node:22-slim` (Debian, glibc) is required — `node:22-alpine` (musl) breaks the native modules. `onnxruntime-node` (fastembed embeddings, plus LiveKit's Silero VAD and turn-detector), `sharp`, and the native tokenizers all ship glibc-linked prebuilds with no musl build.

Alpine is not a shortcut here: the ONNX models the voice worker needs are the reason the image is big, and they are the same reason musl is off the table.

## Common Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid environment variables` on boot | Missing or malformed `.env` | Check each var listed in the error against `.env.example` |
| `ECONNREFUSED 127.0.0.1:54322` | Local Supabase not running | `npx supabase start` |
| Docker container crashes (SIGSEGV) | Native modules (onnxruntime, sharp) need glibc | Use `node:22-slim`, not `node:22-alpine` |
| `ECONNREFUSED` inside Docker | `127.0.0.1` in DB URL | Already handled in `docker-compose.yml` via `host.docker.internal` |
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

The realtime voice transport is being migrated to LiveKit. The previous Gemini Live
STS stack has been removed; the LiveKit worker is not wired up yet, so the agent is
text-mode only in the interim. This section documents the realtime setup once the
worker lands.

---

## For AI Coding Agents

See `AGENTS.md` for conventions, boot order, import rules, voice-specific patterns, and things to never do.
