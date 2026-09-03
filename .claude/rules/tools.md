---
paths:
  - "src/mastra/tools/**/*.ts"
---

# Tool conventions

Shared tools live in `src/mastra/tools/<name>.ts` and export a `createTool(...)`
instance. A tool used by exactly one agent belongs inline in that agent's file.

Every tool needs an `inputSchema`. On the voice path it is the only thing standing
between a caller's transcribed speech and whatever the tool does — LiveKit parses
the arguments against it before `execute` runs, so a schema is a guard, not
documentation.

## Return what the caller should hear; throw only what they should not

**LiveKit replaces a thrown tool error with the literal string
`An internal error occurred` before the model ever sees it.** That is deliberate —
`@livekit/agents` `generation.ts:417` does it because a thrown message may carry
sensitive data — and it is invisible from inside the tool.

The consequence on a call: a tool that throws descriptively leaves the agent
unable to say *why* it could not help. The caller hears something vague, and the
real reason exists only in the worker's logs, where nobody on the call can reach
it. Nothing warns you; the tool looks correct in isolation.

So split the two cases deliberately:

- **A failure the caller should hear is a RESULT.** Refusals, validation
  rejections, "no record found", anything caller-caused. Return it as an ordinary
  value with a field the model can read aloud. `evaluateMath` is the worked
  example — its `outputSchema` carries `result: number | null` alongside
  `refusal: string | null`, and every failure path returns rather than throws.
- **A failure the caller should NOT hear is a THROW.** A database that is down, a
  bug, anything carrying internals or secrets. Here the generic string is exactly
  right, and the detail belongs in the logs.

When you write a refusal, remember it is spoken to whoever is on the line. Keep it
short, keep it plain, and do not describe the guard it tripped — a caller probing
for an injection should not learn which characters your allowlist objects to.

Assert it. `src/mastra/tools/math.test.ts` pins that each refusal path resolves
rather than rejects, and `src/mastra/lib/voice-harness.test.ts` pins that the
words actually survive the trip to the model. A test asserting only that a tool
"fails" would pass just as happily with the message redacted.

## Changing an output shape is a contract change

`src/mastra/lib/voice-harness.test.ts` keys a follow-up turn on the tool output's
exact serialisation, because that is what LiveKit feeds the model as the next
turn's input. Adding or renaming an `outputSchema` field changes that string and
the harness will fail — which is the point. Update the pinned literal in the same
change, and check `src/mastra/scorers/datasets/` for cases asserting the same tool.
