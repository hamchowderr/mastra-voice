---
paths:
  - "src/mastra/scorers/**"
  - "scripts/eval.ts"
---

# Scorers and eval datasets

File naming: `src/mastra/scorers/<agent-name>.scorers.ts`. Datasets live in
`src/mastra/scorers/datasets/<agent-name>.json`.

Voice datasets use `expectedTool` (string or null) and `expectedKeywords`
(string array) — not `expectedFields`. The runner asserts tool calls and
keyword presence in the response text.

```json
{
  "agentId": "voiceAssistant",
  "thresholds": { "answerRelevancy": 0.4 },
  "cases": [
    { "name": "...", "input": "...", "expectedTool": "evaluateMath", "expectedKeywords": [] }
  ]
}
```

Set the `answerRelevancy` threshold for voice agents near 0.3, not 0.7. Voice
responses are intentionally terse, farewells score near 0.00, and the model
spells out numbers — all of which score low even when the answer is correct.

Prebuilt scorers import from the prebuilt path:

```typescript
import { createAnswerRelevancyScorer } from '@mastra/evals/scorers/prebuilt';
```

Ask before removing or renaming a scorer that a dataset JSON references.
