# Testing a voice agent

A text agent has one thing that can be wrong: what it says. A voice agent has a
dozen. It can say the right words and still cut the caller off, answer four
seconds late, mishear a postcode, talk over an interruption, hang up mid-sentence,
or connect to silence because nothing was registered to take the call.

No single surface catches all of that. Some ship with this repo, some come from
the LiveKit CLI, and one is you with a phone. This document is the map: what each
one proves, what it cannot prove, and which to reach for when.

Everything here is written against the agent this template ships. If you are
adapting it for your own agent, the commands transfer unchanged — only the
scenarios, dataset cases and risks are yours to rewrite.

---

## Start here

| You want to know | Reach for | Cost |
| --- | --- | --- |
| Did I break a type? | `npm run typecheck` | free, seconds |
| Does the security-critical logic still hold? | `npm test` | free, ~1s |
| Are the tools registered and callable with the right schema? | `npm run test:harness` | free, ~5s |
| Does the agent answer a known question correctly? | `npm run eval` | **billed**, or free under AIMock |
| Does it behave over a whole conversation? | Studio text chat, or `lk agent daemon` | model spend only |
| Does the audio loop work at all? | `lk agent console`, or Studio's voice call | inference minutes |
| Is the worker even being dispatched? | `lk dispatch create` | negligible |
| Does it survive an awkward caller? | `lk agent simulate` | inference + judge |
| How many concurrent calls fit? | `lk perf agent-load-test` | inference × rooms |
| Did the compliance trail actually get written? | query the Dolt ledger | free |
| Is it still behaving in production? | sampled scorers, traces, `:8081` | ongoing |
| Does it *sound* right? | call it yourself | your time |

The first three need nothing running and take under ten seconds together. Run
them on every edit. Everything below the line costs either money or attention.

---

## 1. Does the logic hold?

### `npm run typecheck`

`tsc --noEmit` across `src/` and `scripts/`. An agent must pass this before being
registered in `src/mastra/index.ts`.

### `npm test` — unit tests

Vitest. No Docker, no database, no API key, no network.

These cover the logic that must hold regardless of what any model says:

- **`resolveVoiceResourceId`** — that a voice call's memory scope comes from the
  verified JWT and *never* from the request body. This is the guard against one
  caller reading another caller's memory, and it is the single most important
  test in the repo.
- **Consent** — deny-by-default, and no leakage between callers.
- **`evaluateMath`'s character allowlist** — it builds a `new Function` from
  caller input, so that check is the only thing between a caller and arbitrary
  code execution.

They need nothing running, so there is no reason not to run them on every edit.

---

## 2. Does the agent decide the right thing?

### `npm run test:harness` — the zero-infrastructure tier

Drives a **real headless `voice.AgentSession`** with LiveKit's `voice.testing`
harness and `FakeLLM` in the `llm` slot. No LiveKit room, no Postgres, no AIMock,
no Docker, no network, no key, no model spend — and it still exercises the real
tool executor and the real Zod input schemas.

```bash
npm run test:harness
```

What it proves:

- the tool names the eval dataset expects are actually registered and callable;
- the real Zod schemas parse the arguments a model would emit — a schema rename
  fails here even for a mocked tool, because LiveKit parses before the mock
  substitutes `execute`;
- the real `evaluateMath` runs inside LiveKit's tool executor and returns the
  right number;
- a rejected tool comes back as an error output rather than taking the turn down.

CI runs it as a job with **no `services:` block, no `env:` block and no secrets**.
That absence is the assertion: if the file ever grows a dependency on Postgres, a
mock server or a provider key, the job goes red while the eval gate stays green.

> **It is a parallel bridge, not the worker's.** `createLiveKitWorker` builds
> `MastraVoiceAgent`, which overrides `llmNode()` and bypasses the `llm` slot
> entirely. This tier occupies that same slot with `FakeLLM`, so it asserts the
> agent's tool contract — not the code path a real call takes. A green run does
> not prove the worker answers a phone call. Closing that gap needs
> `MastraVoiceAgent` to be constructible from userland:
> [mastra-ai/mastra#22494](https://github.com/mastra-ai/mastra/issues/22494).

> **Event *order* is not assertable here.** `RunResult` inserts events by their
> item's `createdAt`, which is millisecond wall clock. With a fake model a whole
> turn lands inside one or two milliseconds, so the assistant message and the
> `function_call` it preceded swap places roughly one run in four. The tests
> assert `contains*()` plus an event count instead of `nextEvent()` sequences.
> **Consequence:** the say-goodbye-*then*-hang-up ordering the worker's `endCall`
> drain depends on stays a manual-checkpoint property.

### `npm run eval` — the regression gate

One fixed input per case, with asserted tool calls, keywords and scorer
thresholds. Exits 0 on pass, 1 on fail. This is what catches a change breaking
something you already knew to check.

```bash
npm run eval
```

**It hits the real Anthropic API and bills the key in `.env`**, because
`USE_AIMOCK` defaults to `false`. It also needs Postgres running. Run it before
shipping, not between edits.

### AIMock — the same gate, deterministic and free

```bash
npx -y -p @copilotkit/aimock aimock -c aimock.json   # terminal 1
USE_AIMOCK=true npm run eval                         # terminal 2
```

Fixtures live in `fixtures/`. AIMock is a separate binary, not a dependency of
this project.

> **Never collapse `src/mastra/lib/model.ts` into a module-scope constant.**
> `createAnthropic()` captures its base URL when constructed, and agents are built
> at import time — before `configureAIMock()` can rewrite it. A singleton bakes in
> the real endpoint and every eval afterwards silently bills you instead of
> hitting the mock.

### Studio text chat

With `npm run dev` up, open `http://localhost:4111`, pick `voiceAssistant`, and
type. This exercises instructions, tools and memory by hand — the same path evals
use.

**Studio's text chat does not stream audio.** VAD, turn detection, barge-in, STT
and TTS all live in the worker process, so a reply that reads perfectly here can
still sound wrong on a call.

### `lk agent daemon` — scripted turns against the real worker

The only scriptable text path that goes through the **actual worker process**,
sitting between the eval gate (no worker) and simulations (Cloud, slow, metered).

```bash
lk agent daemon start src/mastra/voice-worker.ts
lk agent daemon say "what is 47 times 23"
lk agent daemon stop
```

Reach for it when you want to drive a fixed sequence of turns and diff the replies
without paying for audio.

---

## 3. Does the audio loop work?

### `lk agent console` — mic and speakers, from the terminal

The fastest real audio loop. No browser, no Studio, one command.

```bash
lk agent console src/mastra/voice-worker.ts
lk agent console --record src/mastra/voice-worker.ts   # audio + session report
lk agent console --text src/mastra/voice-worker.ts     # text mode instead
lk agent console --list-devices                        # pick a mic
```

`--record` writes audio and a session report to `console-recordings/`, which makes
it the cheapest way to produce a reviewable artifact — two builds, two recordings,
listen back to back.

`--no-aec` disables acoustic echo cancellation; leave it on unless you are
deliberately testing without it.

### Studio's voice call

With both `npm run dev` and `npm run worker:dev` running, open Studio, pick
`voiceAssistant`, and press **Start voice call**. Studio ships a LiveKit client
and calls `/voice/livekit/connection-details` — the route this template registers
— so it connects to your worker with no extra setup.

### LiveKit Agents Playground

The [hosted playground](https://agents-playground.livekit.io) is the alternative
when you want to test from another machine, outside Studio, or with LiveKit's own
client — its transcript panel and participant-attribute inspector show things
Studio's client does not.

### `lk dispatch create` — is the worker being dispatched at all?

When a call connects to silence, the question is not "is the agent good" but "did
anything pick up the job". This answers that without a phone, a SIP trunk or a
browser:

```bash
lk dispatch create --new-room --agent-name mastra-voice
lk dispatch list --room <room>
```

If the worker logs a job, dispatch works and the fault is downstream. If it does
not, the `agentName` does not match — and **a mismatched `agentName` never
errors**. LiveKit accepts the call and dispatches nobody, which the caller hears
as silence.

### `lk egress start` — record a real call

Egress captures room audio to a file. It takes a `StartEgressRequest` as JSON
(see `lk egress start --help` and LiveKit's examples), and gives you the artifact
you need to re-listen to a production call, diff two builds by ear, or hand a
client evidence of what was said.

---

## 4. Does it survive a difficult caller?

LiveKit plays a scripted **caller persona** against the agent over a full
conversation and has an LLM judge grade the result. Where the eval gate asserts
known inputs, this surfaces the failures you did not think to assert — a caller
who withholds a required field, supplies an invalid one, or pushes at a guardrail.

```bash
lk agent simulate --scenarios simulations/scenarios.yaml src/mastra/voice-worker.ts
lk agent simulate audio --scenarios simulations/scenarios.yaml src/mastra/voice-worker.ts
```

**Audio mode drives the real STT→LLM→TTS path** with a simulated voice user, and
can degrade the caller's audio on purpose:

| Flag | Simulates |
| --- | --- |
| `--background-noise` | Ambient noise mixed into the caller's audio |
| `--low-quality-microphone` | A poor microphone |
| `--packet-loss` | Dropped packets on the caller's track |

`simulations/risks.yaml` is the checklist: every risk id must be covered by at
least one scenario's `covers` list, or `--strict` fails the build. `scenarios.yaml`
is generated from `authored.yaml` and `risks.yaml` and is gitignored — edit the
sources.

The bundled `livekit-simulations` skill writes scenarios locally from the agent's
own code; nothing is uploaded.

Requirements — a public beta, nothing to request access to:

| Requirement | Needed |
| --- | --- |
| LiveKit CLI | v2.16.7+ for Node.js agents |
| `@livekit/agents` | 1.6.0+ |
| LiveKit Cloud project | yes — runs execute on Cloud |

**The worker needs no changes to take part.** A simulation arrives as an ordinary
job carrying an `lk.simulator.dispatch` attribute; `ctx.simulationContext()`
returns `undefined` on a normal call, so the same worker serves both.

---

## 5. Does it survive load?

```bash
lk perf agent-load-test --agent-name mastra-voice --rooms 5 --duration 2m
```

It opens N rooms against your LiveKit project and dispatches to the named agent,
so it loads **whichever worker is registered** — local, VPS or LiveKit Cloud
Agents alike. Point `--url` at the project and the worker's location is
irrelevant.

Three things to know before running it:

- **The generator is local.** Your machine opens the rooms and publishes the echo
  tracks, so your CPU and uplink cap how much load you can actually produce. For
  real concurrency numbers, run it from a box that is not also your dev laptop.
- **It is an echo participant, not a conversation.** `--echo-speech-delay`
  (default 5s) controls when the echo track speaks. This measures response latency
  under concurrency, not conversational quality.
- **It costs real inference minutes per room, and contends with real callers.**
  Do not fire it at a production project casually.

This is the only surface that answers the sizing question honestly. The README's
"~1.5–2 GB RAM per concurrent call" is a starting estimate; this replaces it with
a measurement for your hardware.

---

## 6. Did the compliance trail actually get written?

The template's compliance claims are only worth what the ledger can prove. After a
call, query it:

```sql
-- one row per recorded event; one Dolt commit per completed call
SELECT call_thread, event, item, granted, occurred_at
FROM voice_compliance
ORDER BY occurred_at DESC;

-- the audit unit: a row per call, diffable
SELECT * FROM dolt_log LIMIT 10;
```

`voice_compliance` carries `disclosure`, `consent` (with `item` and `granted`) and
`hangup` events, keyed by `call_thread`. Because each call flushes as **one
attributed commit**, `dolt diff` shows exactly what a given call recorded.

Two properties worth asserting deliberately, since nothing else covers them:

- A call where consent was **refused** must still produce a `disclosure` row —
  the ledger records what happened regardless of the consent decision.
- A refused `summaryStorage` must leave **no stored summary**. Enforcement is
  deny-by-default at end of call.

The ledger no-ops silently when Dolt is unconfigured, which is the default for a
fresh clone. An empty table is therefore not evidence of a compliance failure —
check `DOLT_*` is set first.

---

## 7. Is it still right in production?

### Sampled scorers

`answerRelevancy` runs on a **ratio sample** of turns (`rate: 0.2`), fired without
being awaited so it never delays a reply. This is monitoring, not a gate — it
tells you the agent has drifted, it does not stop a release.

It is set to `rate: 0` under AIMock or with no `OPENAI_API_KEY`, because the
scorer reaches OpenAI's `/v1/responses`, which AIMock cannot match fixtures for.
`npm run eval` is unaffected either way — `scripts/eval.ts` calls the scorer
directly rather than through the sampling config.

```bash
npm run score:list   # what is registered
```

### Traces

`@mastra/observability` exports a trace per run, with `SensitiveDataFilter`
applied. This is where you find out what the agent actually did on a specific
turn — which tools it called, in what order, with what arguments.

### The worker health endpoint

```bash
curl http://localhost:8081/     # 200 healthy, 503 unhealthy
```

`@livekit/agents` serves this in production mode (`start`), **not** on the
server's `:4111`. A 503 means `inference process not running` — the shared
turn-detector subprocess died and nothing restarts it, so end-of-turn detection
fails for *every* subsequent call while the worker keeps registering and accepting
jobs. Callers hear silence.

`docker-compose.yml` probes it, but plain Compose only marks the container
unhealthy; it restarts on process *exit*, not on health. Acting on it needs an
orchestrator that does (Swarm, Kubernetes, ECS, Coolify) or a restart-unhealthy
sidecar.

---

## 8. Does it sound right?

Nothing above hears prosody. An audio simulation scores a *transcript*, so it can
catch a dropped turn or a guardrail miss, but it cannot tell you the agent sounded
rushed, or that a pause felt like a hang-up.

Before shipping, place a real call over the SIP path and verify:

- the AI disclosure plays **before** the caller says anything, and is not
  interruptible;
- interrupting mid-sentence actually stops the agent;
- a mid-thought pause does not get treated as end-of-turn;
- the goodbye completes before the line drops;
- silence, hold music and DTMF do not confuse it.

A real call is also the only surface that exercises the SIP leg, the 8 kHz
telephony codec, and real network jitter. Everything else runs at a sample rate
your callers will never hear.

---

## What none of this covers

Being honest about the holes is more useful than a longer table.

- **No browser end-to-end tests.** Nothing automated drives Studio or a web client.
- **Event ordering within a turn** is not assertable in the harness tier (see §2),
  so the goodbye-then-hangup sequence is verified by ear only.
- **The worker's own bridge is untested.** Every automated surface either bypasses
  `MastraVoiceAgent` or drives the whole stack through a real call; nothing tests
  that class in isolation.
- **A thrown tool error reaches the model as `An internal error occurred`.**
  LiveKit redacts the real message before the model sees it, deliberately, in case
  it carries sensitive data. So a tool that throws descriptively leaves the agent
  unable to tell the caller what went wrong, and the real message exists only in
  worker logs. Tools with a known refusal path should **return** a safe string
  rather than throw — only a throw is redacted.
- **Memory and semantic recall have no dedicated surface.** They are exercised
  incidentally by evals and real calls.

---

## CI

Every PR runs: **harness** (no infrastructure at all), **typecheck** (which also
runs `npm test`), **eval**, **build**, and **docker** — where *both* images are
built and *both* containers are started from their own image, with no command
override, so a broken entrypoint fails CI instead of a deploy.
