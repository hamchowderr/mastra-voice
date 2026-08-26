import { createAnswerRelevancyScorer } from '@mastra/evals/scorers/prebuilt';

// LLM-judged relevancy — runs on every agent invocation as an agent-level scorer.
// Uses OpenAI for AIMock compatibility.
export const answerRelevancyScorer = createAnswerRelevancyScorer({
  model: 'openai/gpt-4o-mini',
});

// createToolCallAccuracyScorerCode requires expectedTool at construction time
// (per-case): re-exported for template users wiring per-case tool-accuracy
// evals in scripts/eval.ts. Kept intentionally though currently unused here.
// fallow-ignore-next-line unused-export
export { createToolCallAccuracyScorerCode } from '@mastra/evals/scorers/prebuilt';
