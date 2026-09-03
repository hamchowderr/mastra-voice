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
    result: z.number(),
  }),
  execute: async ({ expression }) => {
    const safe = /^[0-9+\-*/().\s]+$/.test(expression);
    if (!safe) {
      throw new Error(`Unsafe math expression: ${expression}`);
    }
    const result = new Function(`return (${expression})`)();
    if (typeof result !== 'number' || !Number.isFinite(result)) {
      throw new Error(`Expression did not evaluate to a finite number: ${expression}`);
    }
    return { expression, result };
  },
});
