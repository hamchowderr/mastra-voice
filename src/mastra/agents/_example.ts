import { Agent } from '@mastra/core/agent';

import { env } from '../../lib/env';
import { getCurrentTime, evaluateMath } from '../tools/time-and-math';
import { recordConsentTool } from '../tools/consent';
import { answerRelevancyScorer } from '../scorers/_example.scorers';
import { defaultInputProcessors, defaultOutputProcessors } from '../lib/processors';
import { createDefaultMemory } from '../lib/memory';

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
  instructions: `You are a friendly real-time voice assistant.

Rules:
- Early in the call, ask whether it's okay to store a short summary of this call. The moment the caller answers, call recordConsent with item "summaryStorage" and granted set to their yes/no. Ask this only once.
- Keep responses conversational and concise — these are spoken aloud.
- When asked about time, ALWAYS call getCurrentTime. Don't guess.
- When asked to do math, ALWAYS call evaluateMath. Don't compute in your head.
- Acknowledge the user briefly before calling tools (e.g. "Sure, let me check.").
- If the user says "goodbye" or similar, say a brief farewell and stop.
- Avoid lists, bullet points, or anything that would sound awkward when spoken.`,
  // Non-reasoning model on purpose: time-to-first-token is what the caller hears.
  // A reasoning model (e.g. openai/gpt-5-mini) spends seconds "thinking" before it
  // speaks on every turn + tool round-trip — it dominates conversational latency.
  // Anthropic is also the only provider that routes cleanly through AIMock (Mastra's
  // Google router hardcodes its base URL; the OpenAI router uses /v1/responses, which
  // AIMock can't match), so Haiku keeps the CI eval green. Non-reasoning swap-ins:
  // 'google/gemma-4-31b-it' (LiveKit's voice-tuned default) or 'openai/gpt-4.1-mini'
  // (the shipped example). CI validates the text path only — AIMock can't intercept
  // the WebRTC audio loop.
  model: 'anthropic/claude-haiku-4-5',
  tools: { getCurrentTime, evaluateMath, recordConsent: recordConsentTool },
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
