---
paths:
  - "src/**/*.ts"
---

# Import rules

- Relative imports for everything inside `src/mastra/`. No path aliases.
- Never use barrel or index imports — import from the specific file.
- `src/lib/env` is the only cross-boundary import allowed in `src/mastra/`.
- Never import from `src/mastra/` in `src/lib/` — circular dependency risk.

```typescript
// correct
import { env } from '../../lib/env';
import { voiceAssistantAgent } from './agents/_example';

// wrong
import { env } from '@/lib/env';
import { voiceAssistantAgent } from './agents';
```
