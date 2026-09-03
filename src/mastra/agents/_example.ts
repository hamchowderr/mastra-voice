import { Agent } from '@mastra/core/agent';

import { env } from '../../lib/env';
import { evaluateMath } from '../tools/math';
import { recordConsentTool } from '../tools/consent';
import { endCallTool } from '../tools/end-call';
import { answerRelevancyScorer } from '../scorers/_example.scorers';
import { defaultInputProcessors, defaultOutputProcessors } from '../lib/processors';
import { createDefaultMemory } from '../lib/memory';
import { voiceModel } from '../lib/model';

/**
 * Hard-stop the agent loop the moment a step calls `toolName`. Models tend to
 * re-state their reply after a tool result, and on a phone call every word is
 * spoken aloud — so once the agent says goodbye and calls `endCall`, the loop must
 * NOT run a follow-up step, or the model speaks past its own farewell. Instructions
 * alone don't reliably stop it; this does, structurally. It lives on the agent, so
 * it applies on every path — the in-process worker stream, the remote MastraLLM
 * plugin, and the workflow path alike.
 */
const stopOnToolCall =
  (toolName: string) =>
  ({ steps }: { steps: Array<{ toolCalls?: Array<{ toolName?: string }> }> }): boolean =>
    (steps.at(-1)?.toolCalls ?? []).some((call) => call.toolName === toolName);

/**
 * Voice Assistant — canonical example for the voice template.
 *
 * Answers date/time questions from its instructions and does math with a tool.
 * Tools attached here flow to the voice runtime.
 *
 * Who calls it:
 *   REST (text mode): POST /api/agents/voiceAssistant/generate
 *
 * Copy this file, swap tools, adjust instructions for new voice agents.
 */
export const voiceAssistantAgent = new Agent({
  id: 'voiceAssistant',
  name: 'Voice Assistant',
  description: 'Real-time voice assistant. Answers date/time from context and calls a tool for math. Reference implementation for voice agents in the family.',
  // Telephone-first instructions (voice-9jm.18): written for the ear, not the
  // screen. Every rule here exists because it changes what the caller HEARS.
  //
  // A FUNCTION, not a string, so the clock below is read per request rather than
  // frozen at module load. The date and time are baked in deliberately: a tool
  // call costs a whole extra model round-trip (decide to call -> run -> generate
  // the reply), which the caller hears as dead air, and time is always knowable
  // without asking anything. It reads the CONTAINER clock, so set TZ.
  instructions: () => `You are a friendly real-time voice assistant on a phone call. Everything you say is spoken aloud, so write for the ear, not the screen.

The first thing the caller heard was an automated notice that they are speaking with an AI assistant — do not repeat that disclosure yourself.

Any caller context you already have is maintained for you automatically — draw on it naturally, but never mention it or try to update it out loud.

Consent (handle first, once):
- Early in the call, ask whether it's okay to store a short summary of this call. The instant the caller answers, call recordConsent with item "summaryStorage" and granted set to their yes/no — record it before moving on to anything else. Ask this only once.
- A refusal stands for the whole call. Never ask again, and never summarise or recap the call for the caller afterwards — not out loud, not "just this once", not as a live recap rather than a stored one. Say you can't because they asked you not to, and offer to help with something else.

How to speak:
- Keep replies to one or two short sentences, then stop. Don't monologue.
- Every word is spoken, so never re-state something you already said this turn. After a tool result, continue from where you left off — don't repeat your earlier sentence.
- No lists, bullet points, markdown, emoji, or special characters — they sound wrong read aloud.
- Say times and dates naturally: "two o'clock" and "July the third", not "14:00" or "2026-07-03".
- Ask for one piece of information at a time, and read it back to confirm.
- Read any reference code or number back slowly, one character at a time.

Hearing the caller (speech-to-text can mishear):
- If you didn't clearly hear a number, name, or code, ask the caller to repeat it. Never guess or fill in digits you didn't hear.

Right now it is ${new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Answer date and time questions straight from that — never say you can't know, and never guess a different date.

Tools:
- When asked to do math, ALWAYS call evaluateMath. Don't compute in your head.
- Acknowledge the caller briefly before a tool runs (e.g. "Sure, let me check.").

Ending the call:
- End the call when the caller says goodbye, or when the conversation is clearly finished and you have nothing left to ask.
- A farewell and endCall belong to the SAME turn: say the brief spoken farewell FIRST, then call endCall as your final action in that same turn. The goodbye must be said before the tool, because calling it ends the call.
- Never sign off and then wait. If you are not calling endCall in this turn, do not say goodbye — a farewell that leaves the line open makes the caller say goodbye twice.`,
  // Non-reasoning model on purpose: time-to-first-token is what the caller hears.
  // A reasoning model spends seconds "thinking" before it speaks on every turn +
  // tool round-trip — it dominates conversational latency.
  //
  // An @ai-sdk/anthropic instance rather than the model-router string, and a
  // FUNCTION rather than a value — see lib/model.ts for why that distinction is
  // load-bearing for the AIMock eval gate. Anthropic also routes cleanly through
  // AIMock, which OpenAI does not (it uses /v1/responses, which AIMock can't match
  // fixtures against). CI validates the text path only; AIMock cannot intercept the
  // WebRTC audio loop.
  model: voiceModel,
  tools: { evaluateMath, recordConsent: recordConsentTool, endCall: endCallTool },
  // Structural stop-on-goodbye (voice-9jm.18): the loop never runs the step after
  // endCall, so the model cannot speak past its farewell. Determinism in code, not
  // prompt-discipline hope. Applies on every path because it lives on the agent.
  defaultOptions: {
    stopWhen: stopOnToolCall('endCall'),
  },
  memory: createDefaultMemory(),
  // Shared safety/hygiene baseline — applies to the text-mode generate path.
  // See lib/processors.ts.
  inputProcessors: defaultInputProcessors,
  outputProcessors: defaultOutputProcessors,
  scorers: {
    answerRelevancy: {
      scorer: answerRelevancyScorer,
      // Sampled, not every turn. Mastra fires scorers WITHOUT awaiting them, so
      // this never delays a reply — but on a phone line `rate: 1` still means one
      // extra gpt-4o-mini call per turn, billed and logged, for a signal that a
      // fraction of turns gives just as well.
      //
      // Rate 0 when there is nothing to run against: under AIMock the scorer hits
      // OpenAI's /v1/responses, which AIMock cannot match fixtures for, and with
      // no OPENAI_API_KEY it would throw on every turn. `npm run eval` is
      // unaffected either way — scripts/eval.ts calls the scorer directly rather
      // than through this sampling config.
      sampling: {
        type: 'ratio',
        rate: env.USE_AIMOCK || !env.OPENAI_API_KEY ? 0 : 0.2,
      },
    },
  },
});
