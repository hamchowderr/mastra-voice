---
paths:
  - "src/mastra/voice-worker.ts"
  - "src/mastra/lib/voice.ts"
  - "src/mastra/lib/compliance-ledger.ts"
  - "src/mastra/lib/consent-ledger.ts"
  - "src/mastra/tools/**/*.ts"
---

# Voice and telephony

Realtime voice runs on LiveKit (`@mastra/livekit`) in a SEPARATE worker process.
The worker owns the audio loop; the HTTP server owns the text path. It is not
bundled by `mastra build` — it runs from source via `tsx`. Only one worker
flavor runs at a time, since they all register under the same `agentName`.

Tools auto-flow to voice: any tool registered on the agent is available to the
voice session, with no separate registration.

## Writing instructions for speech

Voice instructions must explicitly prohibit lists, bullet points, markdown, and
anything that sounds unnatural read aloud. Keep responses short — they are
spoken, not displayed.

## Compliance controls live on the worker

On `configuration` plus the lifecycle hooks: AI-disclosure greeting
(non-interruptible, with periodic re-disclosure), consent declare→capture→enforce
(deny-by-default at `onCallEnd`), agent-initiated hang-up (`endCall` plus a
`stopWhen` guard), and the per-call Dolt audit ledger (dormant until `DOLT_*`
is set).

Keep the consent policy keys identical across `configuration.consentPolicy`, the
`recordConsent` tool's `items`, and the agent instructions — nothing enforces
that they agree.

## Keep slow work off the caller's clock

Tool filler (`toolFeedback`) speaks during slow tools. Per-turn side effects go
in fire-and-forget `onTurnComplete`. Expensive close-out (summaries, ledger
flush) goes in awaited `onCallEnd`. Memory writes are off-loop by design
(`agentManaged: false`).

## SIP

Inbound calls reach the same worker as browser calls, with no code change. What
breaks is always configuration, and it breaks SILENTLY — LiveKit accepts the
call, never dispatches an agent, and the caller hears nothing while no error
appears anywhere.

Three names must be byte-identical: `VOICE_AGENT_NAME` in `lib/voice.ts`,
`agentName` in the dispatch rule's `roomConfig.agents[]`, and whatever
`runLiveKitWorker` registers. It reads the same constant — never inline the
string.

A worker must always be registered. Scale-to-zero deregisters it from LiveKit,
and an inbound call then connects to silence.

`dispatchRuleIndividual` names the room after the CALLER'S PHONE NUMBER, and
LiveKit writes room names into logs and traces where PII redaction does not
reach them. For regulated calls, route to a predetermined room with a generated
ID instead of using an individual rule.

Never special-case SIP in agent code — the worker cannot tell a phone caller
from a browser caller, and should not try. Disclosure, consent, hang-up, and the
ledger all run identically. The only SIP-aware path is hang-up, which uses
`ctx.deleteRoom()` because it terminates a SIP leg correctly; do not replace it
with `ctx.shutdown()` alone.

Full CLI walkthrough: README, "Give it a phone number".
