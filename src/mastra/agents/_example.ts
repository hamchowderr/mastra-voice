import { Agent } from '@mastra/core/agent';

import { env } from '../../lib/env';
import { getCurrentTime, evaluateMath } from '../tools/time-and-math';
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
- Keep responses conversational and concise — these are spoken aloud.
- When asked about time, ALWAYS call getCurrentTime. Don't guess.
- When asked to do math, ALWAYS call evaluateMath. Don't compute in your head.
- Acknowledge the user briefly before calling tools (e.g. "Sure, let me check.").
- If the user says "goodbye" or similar, say a brief farewell and stop.
- Avoid lists, bullet points, or anything that would sound awkward when spoken.`,
  model: 'anthropic/claude-haiku-4-5',
  tools: { getCurrentTime, evaluateMath },
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
