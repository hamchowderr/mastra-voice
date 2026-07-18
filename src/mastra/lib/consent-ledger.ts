import type { ConsentGrant } from '@mastra/livekit';

import { noteComplianceEvent } from './compliance-ledger';

/**
 * # Consent ledger — the "capture → enforce" store for runtime consent
 *
 * `configuration.consentPolicy` on the worker only DECLARES which consents a call
 * needs; `createConsentTool` CAPTURES the caller's decision each time they answer;
 * this module is where those decisions are stored and read back to ENFORCE them
 * (e.g. gating the end-of-call summary in `onCallEnd`).
 *
 * ## Storage
 *
 * This default is an **in-process map**: enough to enforce within a single call —
 * the grant is captured mid-call and read at that same call's `onCallEnd`, in the
 * same worker process. It is intentionally NOT durable across restarts and is NOT
 * an audit trail.
 *
 * For a durable, attributable, tamper-evident compliance record, route each grant
 * to the versioned Dolt ledger — see the `recordConsentGrant` sink below and issue
 * voice-9jm.22. Swap this whole module for your own system of record (DB / CRM);
 * the package is explicit that consent must live "in a durable, compliant place
 * rather than an opaque plugin store".
 */

const grants = new Map<string, boolean>();
const key = (resourceId: string, item: string) => `${resourceId}::${item}`;

/**
 * Persist one consent decision. Wired as the consent tool's `onGrant`, so it runs
 * inside the turn — keep it quick.
 *
 * Footgun (documented by @mastra/livekit): without a `resourceId` the grant can't
 * be attributed to a caller, so it never counts even though they answered. Warn
 * loudly instead of silently dropping it.
 */
export async function recordConsentGrant(grant: ConsentGrant): Promise<void> {
  if (!grant.resourceId) {
    console.warn(
      `[consent] "${grant.item}" grant has no resourceId — NOT persisted; this consent ` +
        `will not count even though the caller answered. Ensure the call is memory-scoped.`,
    );
    return;
  }
  grants.set(key(grant.resourceId, grant.item), grant.granted);
  // Durable audit sink: buffer the decision for this call's single Dolt compliance
  // commit at onCallEnd (voice-9jm.22). Synchronous + cheap; no-ops when Dolt is
  // unconfigured, so this stays off the caller's clock and safe in the default template.
  noteComplianceEvent(grant.threadId, {
    event: 'consent',
    item: grant.item,
    granted: grant.granted,
    at: new Date(),
  });
}

/**
 * Read a grant back for enforcement. Defaults to `false` (not granted) when the
 * caller never answered or the call wasn't memory-scoped — deny by default.
 */
export function hasConsent(resourceId: string | undefined, item: string): boolean {
  if (!resourceId) return false;
  return grants.get(key(resourceId, item)) === true;
}
