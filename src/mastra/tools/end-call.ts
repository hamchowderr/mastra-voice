import { createEndCallTool } from '@mastra/livekit';

import { noteComplianceEvent } from '../lib/compliance-ledger';

/**
 * Agent-initiated hang-up — the agent-visible half. Attach this tool to the agent
 * that answers the call and set `configuration.endCall` on the worker (see
 * src/mastra/voice-worker.ts); both default to the tool name `'endCall'`, and they
 * MUST match — that's the name the worker watches for each turn to hang up.
 *
 * The tool only SIGNALS intent — from inside `agent.stream()` it can't reach the
 * LiveKit room. The worker owns the hang-up: it waits for the agent's closing words
 * to finish playing, holds a short drain so buffered audio at the caller isn't
 * clipped, then disconnects — running `onCallEnd` on the way out, exactly as a
 * caller hang-up does. So the goodbye must be SAID before this tool is called; the
 * agent instructions enforce that ordering (voice-9jm.18), and `defaultOptions.
 * stopWhen` structurally stops the loop the instant it fires so the model can't
 * speak past its goodbye.
 *
 * `createEndCallTool` is imported from the ROOT `@mastra/livekit` entry — server-safe
 * (only @mastra/core + zod), never pulls in the LiveKit agents runtime, so it's fine
 * on an agent defined in shared/server code.
 */
export const endCallTool = createEndCallTool({
  onEndCall: ({ reason, resourceId, threadId }) => {
    // Bookkeeping only — this does NOT hang up (the worker does, once the closing
    // words finish). Runs inside the turn, so keep it quick.
    console.info('[endCall] agent ended call', { reason, resourceId, threadId });
    // Buffer the agent-initiated hang-up as the call's outcome, for this call's
    // single Dolt compliance commit at onCallEnd (voice-9jm.22). No-ops when Dolt
    // is unconfigured. (A caller-initiated hang-up simply leaves no 'hangup' row.)
    noteComplianceEvent(threadId, {
      event: 'hangup',
      detail: reason ?? 'agent ended call',
      at: new Date(),
    });
  },
});
