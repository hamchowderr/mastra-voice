/**
 * # Shared Memory Baseline (working memory enabled)
 *
 * Use this factory instead of `new Memory()` so every agent shares one memory
 * policy:
 *
 *   import { createDefaultMemory } from '../lib/memory';
 *
 *   export const myAgent = new Agent({ ..., memory: createDefaultMemory() });
 *
 * ## What's configured
 *
 *   - Message history     — ON (Mastra default). Recent turns are prepended.
 *   - Working memory      — ON, resource-scoped. A persistent Markdown scratchpad
 *                           the agent updates over time (user profile + session
 *                           state). "resource-scoped" = it persists across ALL of
 *                           a user's threads, not just one conversation.
 *   - Semantic recall     — OFF (intentionally). It adds an embed + vector-query on
 *                           every turn and needs a `vector` store + `embedder` these
 *                           templates don't configure. Enable per-agent only when the
 *                           use case justifies the latency.
 *
 * ## Two things to know when calling agents
 *
 * 1. Storage: this factory passes no `storage`, so Memory inherits the Mastra
 *    instance's PostgresStore (Supabase). Postgres supports the `mastra_resources`
 *    table that resource-scoped working memory requires — no extra setup needed.
 *
 * 2. resourceId is REQUIRED for resource-scoped memory to actually persist per user:
 *
 *      await agent.generate('Hello', {
 *        memory: { thread: 'conversation-123', resource: 'user-alice-456' },
 *      });
 *
 *    Without `resource`, working memory falls back to thread-only behavior.
 *
 * Pass a custom `template` for agents that should track different fields (e.g. a
 * voice agent wants a leaner profile). See https://mastra.ai/docs/memory/working-memory
 */

import { Memory } from '@mastra/memory';

/**
 * Leaner scratchpad for voice: spoken interactions should track only a few
 * high-value facts so the agent stays fast and conversational.
 */
export const DEFAULT_WORKING_MEMORY_TEMPLATE = `# Caller
- Name:
- Preferences (style, language):
- Current goal:
`;

/**
 * Build a Memory instance with the shared baseline. Each agent gets its own
 * instance. Override `template` to track agent-specific fields.
 */
export function createDefaultMemory(
  template: string = DEFAULT_WORKING_MEMORY_TEMPLATE,
): Memory {
  return new Memory({
    options: {
      workingMemory: {
        enabled: true,
        scope: 'resource',
        template,
      },
      // semanticRecall: intentionally omitted (off). See file header.
    },
  });
}
