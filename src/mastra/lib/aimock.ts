import { env } from '../../lib/env';

/**
 * Routes LLM provider calls through AIMock when USE_AIMOCK=true.
 *
 * MUST be called before any Mastra agent or @ai-sdk/* client is constructed.
 * The Vercel AI SDK reads provider base URLs from env at client instantiation
 * and caches them — late overrides will silently hit the real APIs.
 *
 * Idempotent. Safe to call multiple times.
 */
export function configureAIMock(): void {
  if (!env.USE_AIMOCK) return;

  const base = env.AIMOCK_URL.replace(/\/$/, '');

  // OpenAI
  process.env.OPENAI_BASE_URL = `${base}/v1`;
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'mock';

  // Anthropic — Mastra's anthropic/ routing calls createAnthropic({ apiKey }) then reads
  // ANTHROPIC_BASE_URL from env to determine the base URL. Set both so requests land at
  // {base}/v1/messages, which AIMock handles natively.
  process.env.ANTHROPIC_BASE_URL = `${base}/v1`;
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'mock';

  // Anthropic is the agent's model for a reason: Mastra's anthropic/ routing reads
  // ANTHROPIC_BASE_URL and calls /v1/messages, which AIMock handles natively. Mastra's
  // openai/ routing uses the Responses API (/v1/responses), which AIMock cannot match
  // fixtures against — so an openai/ model breaks the CI eval gate.

  if (env.LOG_LEVEL === 'debug') {
    console.log(`🎭 AIMock active — LLM calls routed to ${base}`);
  }
}
