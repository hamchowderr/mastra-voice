/**
 * # Default Agent Processors (shared baseline)
 *
 * Spread these into every agent so the whole fleet shares one safety/hygiene
 * baseline instead of each agent reinventing it:
 *
 *   import { defaultInputProcessors, defaultOutputProcessors } from '../lib/processors';
 *
 *   export const myAgent = new Agent({
 *     ...
 *     inputProcessors: defaultInputProcessors,
 *     outputProcessors: defaultOutputProcessors,
 *   });
 *
 * ## What's ACTIVE by default (and why only this one)
 *
 *   - UnicodeNormalizer (input)  — pure string op, no LLM. Strips homoglyph /
 *                                  invisible-char tricks and normalizes whitespace
 *                                  before any other check runs. Zero cost, zero downside.
 *
 * It is deterministic and behavior-neutral: safe to apply to EVERY agent. Nothing
 * else clears that bar, so nothing else is on by default.
 *
 * ## Why there is no default output processor
 *
 * Not because none can work — because none is behavior-neutral enough to impose
 * on every agent.
 *
 * History worth keeping: `TokenLimiter` used to sit in `outputProcessors` here
 * when it implemented ONLY `processInputStep`, i.e. it bounded what was sent TO
 * the model and had no valid output hook. @mastra/core <=1.36 ignored it
 * silently; >=1.47 did not — it wiped `result.text` and `result.steps` on every
 * non-streaming `generate()`, so REST /generate returned empty responses and the
 * eval gate saw no tool calls. It was removed for that reason.
 *
 * That constraint is GONE as of core 1.56. Verified against the installed 1.63:
 * `TokenLimiterProcessor` declares `processInputStep`, `processOutputStream` AND
 * `processOutputResult`, counts only generated output parts, and passes tool and
 * lifecycle chunks through untouched. An output-side cap is therefore available
 * and is listed as opt-in below.
 *
 * It stays opt-in rather than default because truncating a reply mid-sentence is
 * a product decision, not a hygiene one — and on the voice path a cut-off
 * sentence is heard, not skimmed. Pick the limit against this agent's real
 * responses. `CostGuardProcessor` is still input-phase only; do not put it here.
 *
 * ## What's OPT-IN (commented below) — and why it is NOT on by default
 *
 * The five model-backed safety processors (Moderation, PromptInjection, PII,
 * Language, SystemPromptScrubber) each construct their own agent and make their
 * own LLM call. Enabling all of them turns one user request into ~6 sequential
 * LLM calls — unacceptable latency for voice/realtime, and a cost multiplier on a
 * lean template. Several behavior-changing processors (StructuredOutput,
 * ToolCallFilter, message-selection, BatchParts, Skills/Workspace/ToolSearch)
 * are also per-agent decisions, not blanket defaults — some directly fight
 * features already wired into the example agent (Memory, structured output,
 * streaming latency).
 *
 * Uncomment + configure the ones a given agent actually needs. See:
 * https://mastra.ai/docs/agents/input-processors and /output-processors
 */

import type { InputProcessorOrWorkflow, OutputProcessorOrWorkflow } from '@mastra/core/processors';
import { TokenLimiter, UnicodeNormalizer } from '@mastra/core/processors';

// import {
//   ModerationProcessor,
//   PromptInjectionDetector,
//   PIIDetector,
//   LanguageDetector,
//   SystemPromptScrubber,
//   ToolCallFilter,
//   StructuredOutputProcessor,
//   BatchPartsProcessor,
//   CostGuardProcessor,
// } from '@mastra/core/processors';

export const defaultInputProcessors: InputProcessorOrWorkflow[] = [
  // Deterministic, no LLM — always safe.
  new UnicodeNormalizer({ stripControlChars: true, collapseWhitespace: true }),

  // --- OPT-IN: deterministic input-budget guards (no LLM) ---
  // Both bound the INPUT (system prompt + history) sent to the model, not the
  // response. Neither is behavior-neutral: TokenLimiter drops older messages to
  // fit, and throws a TripWire if the system prompt alone exceeds the limit —
  // which working memory can grow into. Set the limit against this agent's real
  // system prompt before enabling.
  // new TokenLimiter({ limit: 2000, strategy: 'truncate' }),
  // new CostGuardProcessor({ ... }),

  // --- OPT-IN: model-backed input guardrails (each = one extra LLM call) ---
  // Block jailbreak / prompt-injection before the agent acts:
  // new PromptInjectionDetector({ model: 'anthropic/claude-haiku-4-5' }),
  // Content moderation gate (toxicity / categories):
  // new ModerationProcessor({ model: 'anthropic/claude-haiku-4-5' }),
  // Detect & redact PII on the way in (also valid as an output processor):
  // new PIIDetector({ model: 'anthropic/claude-haiku-4-5', strategy: 'redact' }),
  // Detect / auto-translate input language (skip for data-extraction agents — corrupts source text):
  // new LanguageDetector({ model: 'anthropic/claude-haiku-4-5', targetLanguages: ['English'] }),
];

export const defaultOutputProcessors: OutputProcessorOrWorkflow[] = [
  // Empty by design — see "Why there is no default output processor" above.
  // Only put processors here that implement an OUTPUT phase hook
  // (processOutputResult / processOutputStream / processOutputStep).

  // Deterministic runaway cap on the RESPONSE. No LLM, no added latency. Bounds
  // both token spend and how long the agent can talk — the second matters more
  // on a call than on a page, because the caller has to sit through it. Counts
  // only generated output parts; tool and lifecycle chunks pass through
  // untouched, and it emits `data-token-limit-reached` if it ever truncates.
  //
  // 2000 tokens is far above any correct voice reply (the agent is instructed to
  // be terse), so this should never fire in normal operation — it exists to stop
  // a degenerate loop, not to shape answers.
  //
  // Requires core >=1.56 for the output hooks. Verified behaviourally on 1.63 via
  // scripts/probe-tokenlimiter.ts: identical text, steps and tool calls with and
  // without it, on both generate() and stream(). See voice-9jm.27.1.
  new TokenLimiter({ limit: 2000, strategy: 'truncate' }),

  // --- OPT-IN: model-backed / behavior-changing output processors ---
  // Stop system-prompt / instruction leakage in responses (one extra LLM call):
  // new SystemPromptScrubber({ model: 'anthropic/claude-haiku-4-5' }),
  // Redact PII in the response:
  // new PIIDetector({ model: 'anthropic/claude-haiku-4-5', strategy: 'redact' }),
  // Whitelist which tools the model may call (configure with this agent's tools):
  // new ToolCallFilter({ exclude: [] }),
  // Force schema-conformant output (mutually exclusive with free-text agents):
  // new StructuredOutputProcessor({ schema: MySchema, model: 'anthropic/claude-haiku-4-5' }),
  // Smooth streaming by batching chunks (adds time-to-first-token — skip for voice):
  // new BatchPartsProcessor(),
];
