import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { initializeLogger, llm, voice } from '@livekit/agents';

import { evaluateMath } from '../tools/math';
import { recordConsentTool } from '../tools/consent';
import { endCallTool } from '../tools/end-call';

/**
 * # Zero-infrastructure agent tests — the `voice.testing` harness tier
 *
 * Drives a REAL `voice.AgentSession` headless: no LiveKit room, no Postgres, no
 * AIMock, no Docker, no network, no API key, no model spend. It is the cheap gate
 * between `npm test` (pure units) and `npm run eval` (Postgres + a billed model),
 * and it runs in the same second as the rest of the suite.
 *
 * ## READ THIS BEFORE TRUSTING A GREEN RUN — it is a PARALLEL bridge
 *
 * `createLiveKitWorker` builds `MastraVoiceAgent`, which overrides `llmNode()` and
 * bypasses the `llm` slot entirely. This file occupies that same `llm` slot with
 * `FakeLLM`, so it asserts the agent's TOOL CONTRACT and the TURN'S EVENT ORDERING
 * — not the code path a real call takes. A green run here does NOT prove the worker
 * answers a phone call, and it does NOT replace the manual voice checkpoint.
 * Closing that gap needs `MastraVoiceAgent` to be constructible from userland:
 * upstream issue mastra-ai/mastra#22494 is the ask.
 *
 * What it therefore DOES prove, cheaply and deterministically:
 *   - the tool names the eval dataset expects are actually registered and callable;
 *   - the real Zod input schemas parse the arguments a model would emit;
 *   - the real `evaluateMath` runs inside the LiveKit tool executor and returns the
 *     right number;
 *   - a turn emits exactly the events it should, and a rejected tool comes back as
 *     an error output rather than taking the turn down.
 *
 * What it CANNOT prove, and therefore does not assert:
 *   - **event ORDER.** `RunResult` inserts each event by its item's `createdAt`
 *     (`_findInsertionIndex`), which is millisecond-resolution wall clock. With a
 *     fake model the whole turn lands inside one or two milliseconds, so the
 *     assistant message and the `function_call` it preceded swap places roughly one
 *     run in four. Asserting `nextEvent()` sequences here is a flaky test, not a
 *     guarantee — so the say-goodbye-THEN-hang-up ordering the worker's endCall
 *     drain depends on stays a manual-checkpoint property. `lookedUp` below is the
 *     one ordering this file does assert, because it is causal rather than clocked.
 *
 * ## Three traps, each of which costs an afternoon
 *
 * 1. `initializeLogger(...)` must run before the first `new voice.AgentSession(...)`,
 *    or the constructor throws `logger not initialized`.
 * 2. `session.start(agent)` passed POSITIONALLY fails with `Cannot read properties
 *    of undefined (reading 'id')`. The signature is `start({ agent, room?, ... })`.
 * 3. `session.run()` returns a `RunResult`, NOT a promise. `await session.run(...)`
 *    resolves instantly to the object, before the agent has said anything, and
 *    `result.events` reads back `[]` with no error. Always `.wait()`.
 *
 * ## What FakeLLM keys its responses on
 *
 * `FakeLLMStream.run()` looks the response up by `getInputText()`
 * (`@livekit/agents/src/voice/testing/fake_llm.ts:118`), and returns SILENTLY on a
 * miss — no events, no error, a green-but-empty run. The key is not always the
 * `userInput` string:
 *   - turn 1 -> the last chat item is the user message, so the key is its text;
 *   - turn 2 (after a tool ran) -> the last item is the `function_call_output`, so
 *     the key is the tool's return value SERIALISED AS JSON, not the user's words.
 * The `evaluateMath` test below pins both, executably.
 *
 * ## Why this file rebuilds the agent instead of importing it
 *
 * `src/mastra/agents/_example.ts` imports `src/lib/env.ts`, which `process.exit(1)`s
 * when the env schema is unsatisfied — that would take the whole vitest worker with
 * it. This tier's entire point is needing no environment, so it imports the real
 * TOOL modules (which are env-free) and mounts them on a LiveKit agent here. The
 * cost is that a tool added to `voiceAssistantAgent` and not to `HARNESS_TOOLS` goes
 * unnoticed; the dataset-coverage test below is the tripwire for that.
 */

// Trap 1. Module scope, before any session is constructed.
initializeLogger({ pretty: false, level: 'silent' });

const { FakeLLM, withMockTools } = voice.testing;

/** The `_example.json` shape, as far as this file reads it. */
type DatasetCase = {
  name: string;
  input: string;
  expectedTool: string | null;
  expectedKeywords: string[];
};

const dataset = JSON.parse(
  readFileSync(new URL('../scorers/datasets/_example.json', import.meta.url), 'utf8'),
) as { cases: DatasetCase[] };

/**
 * A Mastra tool, narrowed to the fields the LiveKit bridge needs. `createTool`'s
 * inferred generics do not survive being put in a heterogeneous array, so this is
 * the same narrowing `math.test.ts` does at its call sites.
 */
type MastraToolLike = {
  id: string;
  description?: string;
  inputSchema: unknown;
  execute?: unknown;
};

/**
 * Mount a Mastra tool in a LiveKit agent's tool context. The real description and
 * the real `inputSchema` are used, so LiveKit parses the model's arguments through
 * the same Zod schema the worker does — and that parse happens BEFORE any mock
 * replaces `execute`, so a schema regression fails here even for a mocked tool.
 */
const asLiveKitTool = (tool: MastraToolLike) =>
  llm.tool({
    description: tool.description ?? '',
    parameters: tool.inputSchema as Parameters<typeof llm.tool>[0]['parameters'],
    execute: async (args: unknown) => (tool.execute as (i: unknown) => Promise<unknown>)(args),
  });

/**
 * Keyed by each tool's own `id`, so the names here cannot drift from the names the
 * agent registers — the dataset's `expectedTool` strings have to match both.
 */
const HARNESS_TOOLS = Object.fromEntries(
  ([evaluateMath, recordConsentTool, endCallTool] as unknown as MastraToolLike[]).map((tool) => [
    tool.id,
    asLiveKitTool(tool),
  ]),
);

/**
 * A named subclass because `withMockTools` matches on `agent.constructor` — mocks
 * registered against the base `voice.Agent` would apply to every agent in the process.
 *
 * The instructions are inert: FakeLLM never reads them (it keys on the user turn,
 * see the header). They exist because `voice.Agent` requires them. Deliberately NOT
 * ending in a line starting with `instructions:` — `getInputText()` treats such a
 * system message as the lookup key, which would break every case here.
 */
class HarnessVoiceAgent extends voice.Agent {
  constructor() {
    super({
      id: 'voiceAssistant-harness',
      instructions: 'Harness stand-in for voiceAssistant. Never read by FakeLLM.',
      tools: HARNESS_TOOLS,
    });
  }
}

/**
 * FakeLLM that records every key it was asked to look up. Without this a miss is
 * invisible — the stream just returns and the run ends with no events — so the
 * recorded keys are both the debugging aid and the subject of an assertion below.
 */
class RecordingFakeLLM extends FakeLLM {
  readonly lookedUp: string[] = [];

  override lookup(input: string) {
    this.lookedUp.push(input);
    return super.lookup(input);
  }
}

/** The scripted model turn for a dataset case: what it says, and what it calls. */
type ScriptedTurn = { reply: string; toolArgs?: Record<string, unknown> };

/**
 * FakeLLM decides nothing, so each dataset case needs a scripted turn that ACTS OUT
 * `expectedTool`. The arguments are real: `evaluateMath` really evaluates them.
 */
const SCRIPTED_TURNS: Record<string, ScriptedTurn> = {
  'calls recordConsent when the caller answers the consent question': {
    reply: 'Thanks, I have noted that down.',
    toolArgs: { item: 'summaryStorage', granted: true },
  },
  'answers a time question without calling a tool': {
    reply: 'It is just after two o clock.',
  },
  'calls evaluateMath when asked to compute': {
    reply: 'Sure, let me check.',
    toolArgs: { expression: '47 * 23' },
  },
  'calls evaluateMath for word-form math': {
    reply: 'Sure, one moment.',
    toolArgs: { expression: '15 + 27' },
  },
  'no tool needed for casual hello': {
    reply: 'Doing well, thanks for asking.',
  },
  'says farewell then calls endCall on goodbye': {
    reply: 'Goodbye, take care.',
    toolArgs: { reason: 'caller said goodbye' },
  },
};

/**
 * `recordConsent` writes to the consent ledger and `endCall` to the compliance
 * ledger; neither has a Mastra runtime context here, and neither should leave a
 * trace just because a test ran. `evaluateMath` is pure, so it runs for real — it
 * is the tool whose OUTPUT this tier actually asserts.
 */
const SIDE_EFFECTING_TOOL_MOCKS = {
  recordConsent: (args: { item: string; granted: boolean }) => ({ recorded: true, ...args }),
  endCall: () => ({ ended: true }),
};

/** One headless turn: start a session, run the input, hand back events and keys. */
async function runTurn(
  userInput: string,
  responses: voice.testing.FakeLLMResponse[],
): Promise<{ result: voice.testing.RunResult; lookedUp: string[] }> {
  const model = new RecordingFakeLLM(responses);
  const session = new voice.AgentSession({ llm: model });

  // Trap 2: the object argument.
  await session.start({ agent: new HarnessVoiceAgent() });
  try {
    // `withMockTools` returns a Disposable. Disposed by hand rather than with a
    // `using` declaration, which needs a lib this tsconfig does not enable.
    const mocks = withMockTools(HarnessVoiceAgent, SIDE_EFFECTING_TOOL_MOCKS);
    try {
      // Trap 3: `.wait()`, or `result.events` comes back empty.
      const result = await session.run({ userInput }).wait();
      return { result, lookedUp: model.lookedUp };
    } finally {
      mocks[Symbol.dispose]();
    }
  } finally {
    await session.close();
  }
}

/** The spoken text of every assistant message in a run, in event order. */
const spokenIn = (result: voice.testing.RunResult): string[] =>
  result.events
    .filter((event) => event.type === 'message')
    .map((event) => (event.item as { textContent?: string }).textContent ?? '');

/** Build the first scripted turn's FakeLLM response for a dataset case. */
const responseFor = (testCase: DatasetCase, turn: ScriptedTurn): voice.testing.FakeLLMResponse => ({
  input: testCase.input,
  content: turn.reply,
  toolCalls: testCase.expectedTool
    ? [{ name: testCase.expectedTool, args: turn.toolArgs ?? {} }]
    : undefined,
});

describe('eval dataset coverage', () => {
  // The tripwire for this file drifting from the eval gate. Adding a case to
  // _example.json without scripting it here fails immediately, rather than silently
  // leaving the cheap tier one behaviour short of the expensive one.
  it('scripts every case in _example.json', () => {
    expect(dataset.cases.map((c) => c.name).sort()).toEqual(Object.keys(SCRIPTED_TURNS).sort());
  });

  it('names only tools the harness agent actually registers', () => {
    const expected = dataset.cases.map((c) => c.expectedTool).filter((t): t is string => t !== null);
    for (const toolName of expected) {
      expect(Object.keys(HARNESS_TOOLS)).toContain(toolName);
    }
  });
});

describe('agent turns, headless — no room, no network, no key', () => {
  it.each(dataset.cases.map((c) => [c.name, c] as const))('%s', async (_name, testCase) => {
    const turn = SCRIPTED_TURNS[testCase.name]!;
    const { result, lookedUp } = await runTurn(testCase.input, [responseFor(testCase, turn)]);

    // Turn 1 keys on the user's words — the first half of what getInputText returns.
    expect(lookedUp[0]).toBe(testCase.input);

    // Exactly one thing said, and it is the scripted line. `contains*` rather than
    // `nextEvent()` throughout: see the ordering note in the header.
    expect(spokenIn(result)).toEqual([turn.reply]);

    for (const keyword of testCase.expectedKeywords) {
      expect(turn.reply.toLowerCase()).toContain(keyword.toLowerCase());
    }

    if (testCase.expectedTool) {
      // The real Zod schema parsed these arguments on the way in, so a rename or a
      // type change in the tool's inputSchema fails right here.
      result.expect.containsFunctionCall({ name: testCase.expectedTool, args: turn.toolArgs });
      // isError:false is the load-bearing half — a schema mismatch or a throw still
      // produces an output event, just an error-shaped one.
      result.expect.containsFunctionCallOutput({ isError: false });
    }

    // Nothing else was emitted: in particular the model did not get a second turn,
    // because no response was scripted for the tool output.
    expect(result.events).toHaveLength(testCase.expectedTool ? 3 : 1);
  });
});

describe('the real evaluateMath runs inside the LiveKit tool executor', () => {
  // 47 * 23 = 1081 is computed by src/mastra/tools/math.ts, not by the fake — the
  // fake supplies only the expression. This is the assertion in the file that
  // depends on real project code producing a real value.
  const toolOutput = JSON.stringify({ expression: '47 * 23', result: 1081 });

  it('returns 1081 and closes the turn with a spoken answer', async () => {
    const { result, lookedUp } = await runTurn('What is 47 times 23?', [
      {
        input: 'What is 47 times 23?',
        content: 'Sure, let me check.',
        toolCalls: [{ name: 'evaluateMath', args: { expression: '47 * 23' } }],
      },
      // Turn 2 is keyed on the TOOL OUTPUT, not on anything the caller said.
      { input: toolOutput, content: 'That is one thousand and eighty one.' },
    ]);

    // `output` is compared byte-for-byte, so this pins the real tool's return value
    // — 1081 came out of `new Function`, not out of the fixture.
    result.expect.containsFunctionCall({ name: 'evaluateMath', args: { expression: '47 * 23' } });
    result.expect.containsFunctionCallOutput({ output: toolOutput, isError: false });
    expect(spokenIn(result)).toHaveLength(2);
    expect(result.events).toHaveLength(4);

    // The executable record of what getInputText() returns, turn by turn — the
    // detail the whole tier was blocked on. This IS an ordering assertion, and a
    // sound one: turn 2 can only be keyed on the tool's output because the tool had
    // already run. Causal, not clock-derived.
    expect(lookedUp).toEqual(['What is 47 times 23?', toolOutput]);
  });

  it('surfaces a real tool rejection as an error output rather than a crash', async () => {
    // The allowlist in evaluateMath rejects this. The turn must still complete — on
    // a call, a thrown tool means the agent has to say something, not hang up.
    const { result } = await runTurn('Run this for me.', [
      {
        input: 'Run this for me.',
        content: 'Let me try that.',
        toolCalls: [{ name: 'evaluateMath', args: { expression: 'process.exit(1)' } }],
      },
    ]);

    // LiveKit REDACTS the thrown message before it reaches the model
    // (`generation.ts:417` — a tool error may carry sensitive data). So the model is
    // told only that something failed: the agent cannot explain the failure to the
    // caller, and `Unsafe math expression` exists solely in the worker's own logs.
    result.expect.containsFunctionCallOutput({ output: 'An internal error occurred', isError: true });
    expect(result.events).toHaveLength(3);
  });
});

describe('FakeLLM lookup misses are silent', () => {
  // Pinned because it is how this tier stayed "blocked": a wrong key produces a
  // passing run with an empty event list, which reads like the harness not working
  // rather than like a typo.
  it('produces no events at all when no response matches the input', async () => {
    const { result } = await runTurn('unmatched input', [
      { input: 'some other input', content: 'never spoken' },
    ]);

    expect(result.events).toEqual([]);
  });
});
