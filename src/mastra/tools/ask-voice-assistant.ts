import { randomUUID } from 'node:crypto';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { voiceAssistantAgent } from '../agents/_example';
import { verifiedResourceId } from '../lib/voice';

/**
 * The MCP server's `ask_voiceAssistant` tool, in place of `MCPServer({ agents })`.
 *
 * MCPServer's built-in agent tool calls `agent.generate(message)` with no memory
 * scope. Observational memory runs at thread scope (src/mastra/lib/memory.ts),
 * which throws without a threadId, so every MCP ask would fail. This tool gives
 * each ask its own server-minted thread, and takes the resource from the verified
 * JWT subject exactly as the LiveKit connection route does (lib/voice.ts) — never
 * from the tool input, so an MCP caller can't read another caller's memory.
 */
export const askVoiceAssistantTool = createTool({
  id: 'ask_voiceAssistant',
  description: `Ask agent '${voiceAssistantAgent.name}' a question. It answers as it would on a call, in plain spoken text.`,
  inputSchema: z.object({
    message: z.string().min(1).describe('The question or input for the agent.'),
  }),
  outputSchema: z.object({ text: z.string() }),
  execute: async ({ message }, context) => {
    const result = await voiceAssistantAgent.generate(message, {
      memory: {
        resource: verifiedResourceId(context?.requestContext?.get('user')),
        thread: `mcp-${randomUUID()}`,
      },
      ...(context?.requestContext ? { requestContext: context.requestContext } : {}),
      ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
    });
    return { text: result.text };
  },
});
