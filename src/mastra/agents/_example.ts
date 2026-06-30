import { Agent } from '@mastra/core/agent';
import type { MastraVoice } from '@mastra/core/voice';
import { GeminiLiveVoice } from '@mastra/voice-google-gemini-live';

import { env } from '../../lib/env';
import { patchGeminiLiveForAudio } from '../lib/gemini-live-patch';
import { getCurrentTime, evaluateMath } from '../tools/time-and-math';
import { answerRelevancyScorer } from '../scorers/_example.scorers';
import { defaultInputProcessors, defaultOutputProcessors } from '../lib/processors';
import { createDefaultMemory } from '../lib/memory';

/**
 * Voice Assistant — canonical example for the voice template.
 *
 * Real-time voice conversation via Gemini Live STS. Can tell time and do math.
 * Tools attached here automatically flow to the voice instance.
 *
 * Who calls it:
 *   Local CLI: `npm run voice:cli` (uses mic + speakers)
 *   REST (text mode): POST /api/agents/voiceAssistant/generate
 *
 * Copy this file, swap tools, adjust instructions for new voice agents.
 */
export const voiceAssistantAgent = new Agent({
  id: 'voiceAssistant',
  name: 'Voice Assistant',
  description: 'Real-time voice assistant powered by Gemini Live STS. Handles tool-calling for time queries and math evaluation. Reference implementation for voice agents in the family.',
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
  // Shared safety/hygiene baseline — applies to the text-mode generate path
  // (the realtime Gemini Live STS stream below is separate). See lib/processors.ts.
  inputProcessors: defaultInputProcessors,
  outputProcessors: defaultOutputProcessors,
  voice: (() => {
    const v = new GeminiLiveVoice({
      apiKey: env.GOOGLE_API_KEY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: env.GEMINI_LIVE_MODEL as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      speaker: env.GEMINI_LIVE_SPEAKER as any,
    });
    patchGeminiLiveForAudio(v);
    // Type bridge: @mastra/voice-google-gemini-live@0.14.1 (latest) vendors a
    // pre-1.47 MastraVoice type (5 generics) that doesn't structurally match
    // core 1.47's MastraVoice (6 generics + private brand). The runtime class IS
    // a real MastraVoice (mastra build passes); only tsc rejects the stale brand.
    // Remove this cast once the voice package catches up to core 1.47.
    return v as unknown as MastraVoice;
  })(),
  scorers: {
    answerRelevancy: {
      scorer: answerRelevancyScorer,
      // Under AIMock the scorer hits OpenAI /v1/responses which has no fixtures — disable it.
      sampling: { type: 'ratio', rate: env.USE_AIMOCK ? 0 : 1 },
    },
  },
});
