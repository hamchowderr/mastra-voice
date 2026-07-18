import { createConsentTool } from '@mastra/livekit';

import { recordConsentGrant } from '../lib/consent-ledger';

/**
 * Runtime consent capture — the companion to `configuration.consentPolicy`, which
 * only declares which consents a call needs. Add this to the agent that answers the
 * call; on each call it reads the caller's resourceId/threadId from its execution
 * context and hands the decision to the ledger (`recordConsentGrant`). Enforcement
 * happens separately, at `onCallEnd` (see src/mastra/voice-worker.ts).
 *
 * `createConsentTool` is imported from the ROOT `@mastra/livekit` entry — it is
 * server-safe (depends only on @mastra/core + zod) and never pulls in the LiveKit
 * agents runtime, so it's fine to attach to an agent defined in shared/server code.
 *
 * `items` restricts what the model may record to the declared policy keys (becomes
 * an enum). Keep this in sync with configuration.consentPolicy AND the agent's
 * instructions, which walk the caller through each item — there is no compile-time
 * check that the three agree.
 */
export const recordConsentTool = createConsentTool({
  items: ['summaryStorage'],
  description:
    "Record the caller's yes/no decision on whether a short summary of this call may be " +
    'stored. Call this immediately after the caller answers the consent question, with ' +
    "item 'summaryStorage' and granted set to their answer.",
  onGrant: recordConsentGrant,
});
