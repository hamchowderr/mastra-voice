import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const getCurrentTime = createTool({
  id: 'getCurrentTime',
  description: "Get the current date and time in the user's local timezone",
  inputSchema: z.object({
    timezone: z
      .string()
      .optional()
      .describe('IANA timezone (e.g. "America/Los_Angeles"). Optional; defaults to system timezone.'),
  }),
  outputSchema: z.object({
    iso: z.string(),
    formatted: z.string(),
    timezone: z.string(),
  }),
  execute: async ({ timezone }) => {
    const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    return {
      iso: now.toISOString(),
      formatted: now.toLocaleString('en-US', {
        timeZone: tz,
        dateStyle: 'full',
        timeStyle: 'long',
      }),
      timezone: tz,
    };
  },
});

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
