---
paths:
  - "src/lib/env.ts"
  - ".env.example"
---

# Environment variables

`src/lib/env.ts` is the single source of truth. Never read `process.env.*`
outside it.

Adding a var means two edits in the same change:

1. The Zod schema in `env.ts` — without it the process starts with an undefined
   value and no error.
2. `.env.example` — otherwise nobody cloning this knows the var exists.

Optional vars use `.optional()`; required vars have no default. Boolish vars
use the `boolish` transform at the top of the file.

Note the schema ends in a `.refine()` requiring `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY`. Refine failures surface as form errors rather than beside a
field, so they read differently in the startup output.
