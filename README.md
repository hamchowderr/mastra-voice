# template-mastra-voice

A production-ready Mastra voice agent starter. Real-time speech-to-speech via Gemini Live, full eval pipeline, Docker, CI — everything you need to ship a voice agent without building the scaffold yourself.

---

## Quickstart (5 minutes)

**Prerequisites**: Node 22+, Docker Desktop, a Supabase project, a Google API key with Gemini Live access.

```bash
# 1. Clone and install
git clone <repo> my-agent && cd my-agent
npm install

# 2. Configure environment
cp .env.example .env
# Fill in: APP_SECRET, SUPABASE_*, GOOGLE_GENERATIVE_AI_API_KEY, GOOGLE_API_KEY

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

**Note:** the realtime `npm run voice:cli` path uses Gemini Live STS, a separate pipeline that bypasses these memory processors — working memory applies to the text `/generate` path, not the live audio stream. Semantic recall is intentionally off (latency).

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

## Pre-flight: try the voice CLI

Once Studio works, test the real-time voice pipeline:

```bash
npm run voice:cli
# → "Connected. Speak now. Ctrl+C to quit."
```

Speak into your microphone. The agent should respond in audio and print a transcript to the console. Press Ctrl+C to exit cleanly.

**Requirements**: a working microphone and speakers/headphones. The voice CLI uses `@mastra/node-audio` which compiles a native addon (`@mastra/node-speaker`) — this requires VS Build Tools (Windows), Xcode CLI tools (macOS), or `build-essential` (Linux) and ALSA dev headers (`libasound2-dev` on Debian/Ubuntu).

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
│       │   ├── gemini-live-patch.ts # Patches @mastra/voice-google-gemini-live for v1beta API
│       │   └── supabase.ts         # Supabase client factory
│       ├── scorers/
│       │   ├── _example.scorers.ts # answerRelevancy scorer
│       │   └── datasets/
│       │       └── _example.json   # Eval dataset — 5 cases with thresholds
│       └── tools/
│           └── time-and-math.ts    # getCurrentTime + evaluateMath example tools
├── scripts/
│   ├── voice-cli.ts                # Local real-time voice CLI (mic + speakers)
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
| `npm run voice:cli` | Start real-time voice CLI (mic + speakers) |
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
# Against live Google Gemini API
npm run eval

# Against AIMock (deterministic, no API cost)
npx @copilotkit/aimock --config aimock.json &
USE_AIMOCK=true npm run eval

# Custom dataset
node --env-file=.env --import tsx/esm scripts/eval.ts path/to/dataset.json
```

### CI eval coverage

The CI eval gate runs against AIMock with text-mode assertions only. AIMock cannot intercept WebSocket-based voice calls (Gemini Live), and full tool-call coverage requires per-case fixtures that aren't included in v1.

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

The production image is ~676MB because:

- `node:22-slim` (Debian, glibc) is required — `node:22-alpine` (musl) causes DuckDB to SIGSEGV
- DuckDB is used by `@mastra/observability` for trace storage

If you need a smaller image, swap `DuckDBStore` for `LibSQLStore` in `src/mastra/index.ts`. Trade-off: slower trace queries in Studio under load.

### Voice CLI on a server

The voice CLI (`npm run voice:cli`) is a local-only tool. It requires physical audio devices and won't run in a headless environment. Deploy the Mastra server normally and call it via REST or voice from client devices.

---

## Common Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid environment variables` on boot | Missing or malformed `.env` | Check each var listed in the error against `.env.example` |
| `ECONNREFUSED 127.0.0.1:54322` | Local Supabase not running | `npx supabase start` |
| Docker container crashes (SIGSEGV) | DuckDB requires glibc | Use `node:22-slim`, not `node:22-alpine` |
| `ECONNREFUSED` inside Docker | `127.0.0.1` in DB URL | Already handled in `docker-compose.yml` via `host.docker.internal` |
| Agent not listed in Studio | Not registered in `mastra.agents` | Add to `src/mastra/index.ts` |
| `node-gyp rebuild` fails on install | Missing native build tools | Install VS Build Tools (Win), Xcode CLI (Mac), or `build-essential + libasound2-dev` (Linux) |
| Voice CLI: mic not captured | Wrong sample rate or format | `getMicrophoneStream` must use `{ rate: 16000, fileType: 'raw' }` for Gemini Live |
| Voice: audio sounds pitched up/distorted | Speaker sample rate mismatch | `playAudio()` must use `{ sampleRate: 24000 }` — Gemini Live outputs 24000 Hz, default is 24100 Hz |
| Voice session disconnects immediately (1007) | Deprecated `media_chunks` format | `gemini-live-patch.ts` handles this — verify the patch is applied |
| PostHog telemetry noise | Mastra runtime phones home on startup | Set `MASTRA_TELEMETRY_DISABLED=1` in `.env` |

---

## Environment Variables

See `.env.example` for the full list with comments. Minimum required:

- `APP_SECRET` — min 32 chars, generate with `openssl rand -hex 32`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`
- At least one of: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`
- `GOOGLE_API_KEY` — required for Gemini Live voice (separate from `GOOGLE_GENERATIVE_AI_API_KEY`)

---

## Voice Quality Troubleshooting

The voice CLI (`npm run voice:cli`) uses native audio I/O. If quality is poor:

**1. Mic permissions**
- macOS: System Settings → Privacy & Security → Microphone → allow Terminal/your app
- Windows: Settings → Privacy → Microphone → allow desktop apps
- Without permission, mic stream is silent and the model receives no audio

**2. Audio device selection**
- Bluetooth headsets often switch to a low-quality "hands-free" (SCO) profile when used bidirectionally. Use wired headphones, or set your Bluetooth device to use its A2DP profile for output (manual in OS sound settings) and a separate wired mic for input.
- Verify the correct input device is set as default in OS sound settings before starting the CLI

**3. Network**
- Gemini Live is a real-time WebSocket stream; latency above ~150 ms round-trip makes conversation feel unnatural
- Wired Ethernet is strongly preferred over WiFi. Run `ping generativelanguage.googleapis.com` — if RTT is consistently over 100 ms, network latency is the bottleneck (not fixable at code level)

**4. Model selection**
- `GEMINI_LIVE_MODEL` in `.env` controls which model is used. Default: `gemini-3.1-flash-live-preview`
- If quality is poor, try `gemini-live-2.5-flash-preview` or `gemini-live-2.5-flash-preview-native-audio` — model behavior varies across preview builds
- All model changes require updating `.env` only; no code changes needed

**5. If voice stops working entirely**
- Check `src/mastra/lib/gemini-live-patch.ts` — this file patches the `@mastra/voice-google-gemini-live` library for v1beta API compatibility, correct auth, and audio format. If the library is upgraded, re-run `scripts/voice-connect-test.ts` to verify the patch is still compatible.

**6. Audio format reference**
- Mic input expected by Gemini Live: 16000 Hz, 16-bit signed int, mono, raw PCM (no WAV header)
- Agent output from Gemini Live: 24000 Hz, 16-bit signed int, mono, PCM

---

## Voice library patch

This template includes a patch file at `src/mastra/lib/gemini-live-patch.ts` that bridges three incompatibilities between `@mastra/voice-google-gemini-live` and the current Gemini Live API:

1. **API version**: library hardcodes v1alpha; current API requires v1beta
2. **Missing config**: library omits `responseModalities: ['AUDIO']` from setup messages
3. **Deprecated payload**: library uses old `realtime_input.media_chunks` format; current API requires `realtime_input.audio`

The patch is applied automatically when the voice agent is constructed. **No client action is required to make voice work** — this is informational.

### When to update the patch

- **The library is updated** (new version of `@mastra/voice-google-gemini-live`): test if voice still works without the patch. If it does, remove the patch entirely. If it doesn't, the patch may need updating to match new internal method names.
- **Voice mysteriously stops working**: the most likely cause is Gemini Live API changing. Check the [Gemini Live changelog](https://ai.google.dev/gemini-api/docs/live-guide) for recent breaking changes, then update the patch's intercept logic accordingly.
- **You see `TypeError: this.X is not a function`**: the library changed an internal method our patch wraps. Open `gemini-live-patch.ts` and look for the method name in the error.

### Removing the patch

When `@mastra/voice-google-gemini-live` natively supports v1beta + correct payload format:

1. Delete `src/mastra/lib/gemini-live-patch.ts`
2. Remove the import and call from `src/mastra/agents/_example.ts`
3. Run `npm run voice:cli` to verify voice still works
4. Update this README section to remove the "Voice library patch" section

---

## For AI Coding Agents

See `AGENTS.md` for conventions, boot order, import rules, voice-specific patterns, and things to never do.
