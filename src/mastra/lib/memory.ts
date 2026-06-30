/**
 * # Shared Memory Baseline (working memory + semantic recall enabled)
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
 *   - Semantic recall     — ON, resource-scoped. Past messages are embedded and
 *                           the most relevant ones are recalled each turn. The
 *                           embedder is **fastembed** — a local ONNX model
 *                           (bge-small-en-v1.5, 384-dim), so recall needs no API
 *                           key and no external embedding spend. Vectors live in
 *                           the same Supabase Postgres via PgVector.
 *
 * ## Two things to know when calling agents
 *
 * 1. Storage: this factory passes no `storage`, so Memory inherits the Mastra
 *    instance's PostgresStore (Supabase). Postgres supports the `mastra_resources`
 *    table that resource-scoped working memory requires — no extra setup needed.
 *    Semantic recall vectors use a dedicated PgVector on the same database; the
 *    `pgvector` extension must be enabled (the compose stack does this via
 *    docker/postgres-init/01-pgvector.sql).
 *
 * 2. resourceId is REQUIRED for resource-scoped memory to actually persist per user:
 *
 *      await agent.generate('Hello', {
 *        memory: { thread: 'conversation-123', resource: 'user-alice-456' },
 *      });
 *
 *    Without `resource`, working memory falls back to thread-only behavior.
 *
 * Pass a custom `template` for agents that should track different fields (this
 * voice template is intentionally leaner). See
 * https://mastra.ai/docs/memory/working-memory and
 * https://mastra.ai/docs/memory/semantic-recall
 */

import { Memory } from '@mastra/memory';
import { PgVector } from '@mastra/pg';
import { fastembed } from '@mastra/fastembed';
import { env } from '../../lib/env';

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
 * One shared PgVector pool for semantic-recall embeddings across every agent's
 * Memory. Lazily created so importing this module never opens a connection; a
 * single instance avoids one pool per agent on the same database.
 */
let _vector: PgVector | null = null;
function memoryVector(): PgVector {
  if (!_vector) {
    _vector = new PgVector({ id: 'memory-vector', connectionString: env.SUPABASE_DB_URL });
  }
  return _vector;
}

/**
 * Build a Memory instance with the shared baseline. Each agent gets its own
 * instance (sharing the vector pool). Override `template` to track agent-specific
 * fields. The embedding dimension is probed from fastembed automatically — no
 * hard-coded dimension to keep in sync.
 */
export function createDefaultMemory(
  template: string = DEFAULT_WORKING_MEMORY_TEMPLATE,
): Memory {
  return new Memory({
    vector: memoryVector(),
    embedder: fastembed,
    options: {
      workingMemory: {
        enabled: true,
        scope: 'resource',
        template,
      },
      semanticRecall: {
        topK: 3,
        messageRange: 2,
        scope: 'resource',
      },
    },
  });
}
