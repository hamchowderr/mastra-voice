import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const evaluateMath = createTool({
  id: 'evaluateMath',
  description: 'Safely evaluate a simple math expression. Supports +, -, *, /, parentheses.',
  inputSchema: z.object({
    expression: z.string().describe('Math expression to evaluate (e.g. "2 + 2 * 5")'),
  }),
  outputSchema: z.object({
    expression: z.string(),
    /** The value, or null when the expression was refused. */
    result: z.number().nullable(),
    /** Why it was refused, phrased to be read aloud. Null on success. */
    refusal: z.string().nullable(),
  }),
  execute: async ({ expression }) => {
    // Every failure below is RETURNED, never thrown (voice-4sh).
    //
    // LiveKit replaces a thrown tool error with the literal string "An internal
    // error occurred" before the model ever sees it — deliberately, per the
    // comment at @livekit/agents generation.ts:417, since a thrown message may
    // carry sensitive data. So a throw here would leave the agent unable to tell
    // the caller why it could not answer, with the real reason living only in the
    // worker's logs where no one on the call can reach it.
    //
    // Only a genuinely unexpected fault should throw, where the generic string is
    // the right thing to say. Everything here is caller-caused and safe to explain.
    const refuse = (refusal: string) => ({ expression, result: null, refusal });

    // The allowlist is the only thing between a caller and arbitrary code
    // execution, because the evaluator below builds a `new Function`. Keep it
    // first, and keep the refusal vague about WHY — a caller probing for an
    // injection should not be told which characters the filter objects to.
    if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
      return refuse('I can only work out arithmetic — numbers, plus, minus, times, divide and parentheses.');
    }

    let value: unknown;
    try {
      value = new Function(`return (${expression})`)();
    } catch {
      // Allowlisted characters still form invalid JavaScript readily enough
      // ("2 + )", "(("), and on a call that is usually a transcription artefact
      // rather than an attack. Worth asking the caller to repeat themselves.
      return refuse("I couldn't make sense of that expression — could you say it again?");
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      // Division by zero, or an overflow to Infinity.
      return refuse("That doesn't come out to a number I can give you.");
    }

    return { expression, result: value, refusal: null };
  },
});
