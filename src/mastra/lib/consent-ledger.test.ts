import { describe, expect, it, vi } from 'vitest';

import type { ConsentGrant } from '@mastra/livekit';

import { hasConsent, recordConsentGrant } from './consent-ledger';

const grant = (over: Partial<ConsentGrant> = {}): ConsentGrant =>
  ({
    item: 'recording',
    granted: true,
    resourceId: 'caller-1',
    threadId: 'thread-1',
    ...over,
  }) as ConsentGrant;

describe('hasConsent — deny by default', () => {
  it('denies an item that was never answered', () => {
    expect(hasConsent('never-asked', 'recording')).toBe(false);
  });

  it('denies when the call was not memory-scoped (no resourceId)', () => {
    expect(hasConsent(undefined, 'recording')).toBe(false);
  });

  it('denies when the caller answered no', async () => {
    await recordConsentGrant(grant({ resourceId: 'caller-no', granted: false }));
    expect(hasConsent('caller-no', 'recording')).toBe(false);
  });

  it('grants only after an explicit yes', async () => {
    await recordConsentGrant(grant({ resourceId: 'caller-yes', granted: true }));
    expect(hasConsent('caller-yes', 'recording')).toBe(true);
  });
});

describe('consent scoping', () => {
  it('does not leak a grant across callers', async () => {
    await recordConsentGrant(grant({ resourceId: 'caller-a', granted: true }));
    expect(hasConsent('caller-a', 'recording')).toBe(true);
    expect(hasConsent('caller-b', 'recording')).toBe(false);
  });

  it('does not leak a grant across items', async () => {
    await recordConsentGrant(grant({ resourceId: 'caller-c', item: 'recording', granted: true }));
    expect(hasConsent('caller-c', 'recording')).toBe(true);
    expect(hasConsent('caller-c', 'data-sharing')).toBe(false);
  });

  it('lets a later answer revoke an earlier grant', async () => {
    await recordConsentGrant(grant({ resourceId: 'caller-d', granted: true }));
    expect(hasConsent('caller-d', 'recording')).toBe(true);
    await recordConsentGrant(grant({ resourceId: 'caller-d', granted: false }));
    expect(hasConsent('caller-d', 'recording')).toBe(false);
  });
});

describe('recordConsentGrant — unattributable grants', () => {
  it('warns and drops a grant with no resourceId rather than storing it unattributed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await recordConsentGrant(grant({ resourceId: undefined }));
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('resourceId');
    warn.mockRestore();
  });
});
