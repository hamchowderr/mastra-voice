import { createAnthropic } from '@ai-sdk/anthropic';

/**
 * The agent's language model, as a Vercel AI SDK provider instance.
 *
 * Mastra takes either a model-router STRING ('anthropic/claude-haiku-4-5') or an
 * AI SDK model object — `MastraModelConfig` includes `LanguageModelV1..V4`, which
 * are the AI SDK's own interfaces. This project uses the instance so the provider
 * is configurable (custom fetch, headers, middleware) in a way the string can't
 * express. `@mastra/livekit` is indifferent: its bridge takes a Mastra agent and
 * never inspects the model, so the voice path runs on whatever the agent runs on.
 *
 * WHY THIS IS A FUNCTION, NOT A MODULE-SCOPE CONSTANT
 * ---------------------------------------------------
 * `createAnthropic()` captures its base URL at construction. Agents are built at
 * module scope, which runs at IMPORT time — before `configureAIMock()` has had a
 * chance to rewrite ANTHROPIC_BASE_URL. A module-scope `anthropic(...)` singleton
 * would therefore bake in the real API endpoint and every eval would silently hit
 * (and bill) Anthropic instead of the mock.
 *
 * Mastra's `model` option is a `DynamicArgument`, so it accepts a factory that it
 * calls per request — long after boot. That is the seam this uses: construction is
 * deferred past `configureAIMock()`, and the base URL is read when it is correct.
 * Never turn this back into a top-level constant.
 */
const VOICE_MODEL_ID = 'claude-haiku-4-5';

let provider: ReturnType<typeof createAnthropic> | undefined;

function anthropicProvider() {
  // Cached after the first request: configureAIMock() runs once at boot, so the
  // env is already settled by the time anything calls this.
  if (!provider) {
    provider = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Set by configureAIMock() when USE_AIMOCK=true; otherwise undefined, and
      // the SDK falls back to the real Anthropic endpoint.
      ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
    });
  }
  return provider;
}

/** Pass as an agent's `model`. Mastra calls it per request. */
export const voiceModel = () => anthropicProvider()(VOICE_MODEL_ID);
