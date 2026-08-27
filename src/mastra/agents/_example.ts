import { Agent } from '@mastra/core/agent';

import { env } from '../../lib/env';
import { getCurrentTime, evaluateMath } from '../tools/time-and-math';
import { recordConsentTool } from '../tools/consent';
import { endCallTool } from '../tools/end-call';
import { answerRelevancyScorer } from '../scorers/_example.scorers';
import { defaultInputProcessors, defaultOutputProcessors } from '../lib/processors';
import { createDefaultMemory } from '../lib/memory';

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
 * Can tell time and do math. Tools attached here flow to the voice runtime.
 *
 * Who calls it:
 *   REST (text mode): POST /api/agents/voiceAssistant/generate
 *
 * Copy this file, swap tools, adjust instructions for new voice agents.
 */
export const voiceAssistantAgent = new Agent({
  id: 'voiceAssistant',
  name: 'Voice Assistant',
  description: 'Real-time voice assistant. Handles tool-calling for time queries and math evaluation. Reference implementation for voice agents in the family.',
  // Telephone-first instructions (voice-9jm.18): written for the ear, not the
  // screen. Every rule here exists because it changes what the caller HEARS.
  instructions: `You are a friendly real-time voice assistant on a phone call. Everything you say is spoken aloud, so write for the ear, not the screen.

The first thing the caller heard was an automated notice that they are speaking with an AI assistant — do not repeat that disclosure yourself.

Any caller context you already have is maintained for you automatically — draw on it naturally, but never mention it or try to update it out loud.

Consent (handle first, once):
- Early in the call, ask whether it's okay to store a short summary of this call. The instant the caller answers, call recordConsent with item "summaryStorage" and granted set to their yes/no — record it before moving on to anything else. Ask this only once.

How to speak:
- Keep replies to one or two short sentences, then stop. Don't monologue.
- Every word is spoken, so never re-state something you already said this turn. After a tool result, continue from where you left off — don't repeat your earlier sentence.
- No lists, bullet points, markdown, emoji, or special characters — they sound wrong read aloud.
- Say times and dates naturally: "two o'clock" and "July the third", not "14:00" or "2026-07-03".
- Ask for one piece of information at a time, and read it back to confirm.
- Read any reference code or number back slowly, one character at a time.

Hearing the caller (speech-to-text can mishear):
- If you didn't clearly hear a number, name, or code, ask the caller to repeat it. Never guess or fill in digits you didn't hear.

Tools:
- When asked about the time, ALWAYS call getCurrentTime. Don't guess.
- When asked to do math, ALWAYS call evaluateMath. Don't compute in your head.
- Acknowledge the caller briefly before a tool runs (e.g. "Sure, let me check.").

Ending the call:
- When the caller says goodbye or the conversation is clearly finished, say a brief spoken farewell FIRST, then call endCall as your final action. The goodbye must be said before you call the tool — calling it ends the call.`,
  // Non-reasoning model on purpose: time-to-first-token is what the caller hears.
  // A reasoning model (e.g. openai/gpt-5-mini) spends seconds "thinking" before it
  // speaks on every turn + tool round-trip — it dominates conversational latency.
  // Anthropic also routes cleanly through AIMock, which the OpenAI router does not
  // (it uses /v1/responses, which AIMock can't match fixtures against), so Haiku keeps
  // the CI eval green. Non-reasoning swap-in: 'openai/gpt-4.1-mini' — usable at
  // runtime, but it will break the AIMock eval gate. CI validates the text path only;
  // AIMock cannot intercept the WebRTC audio loop.
  model: 'anthropic/claude-haiku-4-5',
  tools: { getCurrentTime, evaluateMath, recordConsent: recordConsentTool, endCall: endCallTool },
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
      // Under AIMock the scorer hits OpenAI /v1/responses which has no fixtures — disable it.
      sampling: { type: 'ratio', rate: env.USE_AIMOCK ? 0 : 1 },
    },
  },
});
