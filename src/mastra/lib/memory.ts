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
 *   - Working memory      — ON, resource-scoped, but READ-ONLY to the agent
 *                           (agentManaged: false). A persistent Markdown scratchpad
 *                           (user profile + session state) the agent sees as context
 *                           but never updates in-loop — writing on the audio path is
 *                           the top voice-latency offender. "resource-scoped" = it
 *                           persists across ALL of a user's threads, not one call.
 *   - Semantic recall     — ON, resource-scoped, kept SMALL (topK 3, one message of
 *                           context each side) because recall runs synchronously
 *                           before every reply. The embedder is **fastembed** — a
 *                           local ONNX model (bge-small-en-v1.5, 384-dim), so recall
 *                           needs no API key and no external embedding spend; vectors
 *                           live in the same Supabase Postgres via PgVector.
 *   - Observational memory — ON, resource-scoped, threshold sized to land its inline
 *                           distillation on a LATER call, never mid-call. See the
 *                           options below for the latency reasoning.
 *
 * All four are tuned for voice latency (voice-9jm.17): keep memory writes and recall
 * off the caller's clock.
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
 *
 * @public — exported for template users to reference or override the default.
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
      // Working memory as READ-ONLY context (agentManaged: false) — the single
      // biggest voice-latency win. The main agent gets working memory folded into
      // its context but has NO updateWorkingMemory tool and no "update it now"
      // instruction. On a live call the in-loop write tool was the top UX offender,
      // two ways: the model re-states its reply after the tool result (the caller
      // hears the answer twice), and it sometimes writes memory BEFORE replying
      // (seconds of dead air). Off the loop, neither can happen. Update it off the
      // audio path instead — e.g. memory.updateWorkingMemory(...) inside the
      // worker's fire-and-forget onTurnComplete (voice-9jm.9).
      //
      // Uses a Markdown `template` (replace semantics). If you switch to a Zod
      // `schema` and let an extractor populate it, EVERY field must be `.nullish()`,
      // never `.optional()`: the extractor returns the whole object and emits `null`
      // for fields it doesn't know yet, and a bare `.optional()` boolean REJECTS that
      // null and silently drops the entire write.
      workingMemory: {
        enabled: true,
        scope: 'resource',
        agentManaged: false,
        template,
      },
      // Semantic recall runs SYNCHRONOUSLY before the reply — every extra hit is
      // latency the caller waits through. Keep it small: 3 hits, one message of
      // context on each side. The embedder (fastembed, above) is one small
      // LRU-cached LOCAL call per turn — no network round-trip.
      semanticRecall: {
        topK: 3,
        messageRange: { before: 1, after: 1 },
        scope: 'resource',
      },
      // Observational memory distills the conversation into dense observations. With
      // scope: 'resource' it runs SYNCHRONOUSLY INLINE on the caller's clock when
      // unobserved tokens cross `messageTokens` — there is NO background buffering at
      // resource scope. So size `messageTokens` to EXCEED a typical call: the
      // threshold isn't reached mid-call, and distillation lands on a LATER call
      // instead of stalling this one (a reasoning observer model was measured at
      // ~25s per inline fire, so `model` is a fast non-reasoning one, shared by the
      // observer and reflector). Do NOT set observation.manageWorkingMemory with
      // resource-scoped working memory — a known core bug crashes it with "no
      // resourceId was provided" (it defaults off, kept off here).
      observationalMemory: {
        scope: 'resource',
        model: 'anthropic/claude-haiku-4-5',
        observation: {
          messageTokens: 3000,
        },
      },
    },
  });
}
