---
paths:
  - "src/mastra/agents/**/*.ts"
  - "src/mastra/lib/model.ts"
---

# Agent conventions

File naming: `src/mastra/agents/<kebab-name>.ts`, prefixed `_` for examples.

Every agent exports an instance with `id`, `name`, `instructions`, `model`, and
`scorers`. Scorers are declared inline; implementations live in
`src/mastra/scorers/`. Every agent should carry at least an `answerRelevancy`
scorer. Tools used by one agent live inline in that agent's file; shared tools
go in `src/mastra/tools/`.

## The model is a function, and that is not stylistic

The model is an `@ai-sdk/anthropic` instance, not a model-router string. Mastra
accepts either — `MastraModelConfig` includes the AI SDK's own
`LanguageModelV1..V4` interfaces — and `@mastra/livekit` never inspects the
model, so the voice path follows the agent.

It is wired as a function (`model: voiceModel`). `createAnthropic()` captures
its base URL at construction, and agents are built at module scope, which runs
before `configureAIMock()` can rewrite `ANTHROPIC_BASE_URL`. A module-scope
singleton would bake in the real endpoint. Mastra's `model` is a
`DynamicArgument`, so a factory resolves per request — after boot.

Stay on Anthropic for the text model: AIMock handles `/v1/messages` natively but
cannot match fixtures against OpenAI's Responses API (`/v1/responses`), which
breaks the CI eval gate. No Google providers — this project uses none.

Ask before downgrading a Mastra or voice package version.
