import { describe, expect, it } from 'vitest';

import type { ConnectionRequestArgs } from '@mastra/livekit';

import {
  VOICE_AGENT_ID,
  VOICE_AGENT_NAME,
  resolveVoiceResourceId,
  resolveVoiceSessionMetadata,
} from './voice';

/**
 * Builds the shape `resolveVoiceResourceId` reads: `context.get('requestContext')`
 * returning a store with `get`/`set`. `body` is deliberately included and
 * deliberately never expected to be read — that is the invariant under test.
 */
function makeArgs(user?: Record<string, unknown>, body?: Record<string, unknown>) {
  const requestContext = new Map<string, unknown>();
  if (user) requestContext.set('user', user);
  const context = new Map<string, unknown>([['requestContext', requestContext]]);
  return { context, body } as unknown as ConnectionRequestArgs;
}

describe('resolveVoiceResourceId', () => {
  it('uses the verified JWT subject', () => {
    expect(resolveVoiceResourceId(makeArgs({ sub: 'user-42' }))).toBe('user-42');
  });

  it('falls back to id, then userId, for custom auth providers', () => {
    expect(resolveVoiceResourceId(makeArgs({ id: 'user-id' }))).toBe('user-id');
    expect(resolveVoiceResourceId(makeArgs({ userId: 'user-uid' }))).toBe('user-uid');
  });

  it('prefers sub over id and userId', () => {
    const args = makeArgs({ sub: 'from-sub', id: 'from-id', userId: 'from-userid' });
    expect(resolveVoiceResourceId(args)).toBe('from-sub');
  });

  it('ignores empty-string claims rather than adopting them as an identity', () => {
    const id = resolveVoiceResourceId(makeArgs({ sub: '', id: 'real-id' }));
    expect(id).toBe('real-id');
  });

  it('ignores non-string claims', () => {
    const id = resolveVoiceResourceId(makeArgs({ sub: 12345, id: 'real-id' }));
    expect(id).toBe('real-id');
  });

  // The IDOR guard. `liveKitConnectionRoute`'s default reads resourceId from the
  // POST body, which lets any caller name another caller's scope and read their
  // memory. This template must never do that, in dev or otherwise.
  it('NEVER takes the resource id from the request body', () => {
    const args = makeArgs(undefined, { resourceId: 'victim-user', agentId: 'x', threadId: 'y' });
    const id = resolveVoiceResourceId(args);
    expect(id).not.toBe('victim-user');
    expect(id).toMatch(/^anon-/);
  });

  it('falls back to a fresh anonymous id when no identity is verified', () => {
    const id = resolveVoiceResourceId(makeArgs());
    expect(id).toMatch(/^anon-[0-9a-f-]{36}$/);
  });

  it('mints a different anonymous id for each connection', () => {
    expect(resolveVoiceResourceId(makeArgs())).not.toBe(resolveVoiceResourceId(makeArgs()));
  });

  // The route calls this twice per connection — once for metadata, once for
  // participantIdentity. Without caching the anonymous branch would disagree
  // with itself inside a single connection.
  it('returns the same id for repeated calls within one request', () => {
    const args = makeArgs();
    expect(resolveVoiceResourceId(args)).toBe(resolveVoiceResourceId(args));
  });

  it('survives a missing requestContext without throwing', () => {
    const args = { context: new Map() } as unknown as ConnectionRequestArgs;
    expect(resolveVoiceResourceId(args)).toMatch(/^anon-/);
  });
});

describe('resolveVoiceSessionMetadata', () => {
  it('scopes the session to the configured agent', () => {
    expect(resolveVoiceSessionMetadata(makeArgs({ sub: 'u1' })).agentId).toBe(VOICE_AGENT_ID);
  });

  it('carries the resolved resource id', () => {
    expect(resolveVoiceSessionMetadata(makeArgs({ sub: 'u1' })).resourceId).toBe('u1');
  });

  it('mints the thread id server-side, never reusing one across connections', () => {
    const a = resolveVoiceSessionMetadata(makeArgs({ sub: 'u1' }));
    const b = resolveVoiceSessionMetadata(makeArgs({ sub: 'u1' }));
    expect(a.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.threadId).not.toBe(b.threadId);
  });

  it('does not let the body dictate the thread id', () => {
    const args = makeArgs({ sub: 'u1' }, { threadId: 'attacker-thread' });
    expect(resolveVoiceSessionMetadata(args).threadId).not.toBe('attacker-thread');
  });
});

describe('agent name constant', () => {
  // Three places must agree byte-for-byte: this constant, the LiveKit dispatch
  // rule's agentName, and whatever runLiveKitWorker registers. A mismatch does
  // not error — calls just connect to silence.
  it('is a non-empty string safe to use as a LiveKit agentName', () => {
    expect(VOICE_AGENT_NAME).toBe('mastra-voice');
    expect(VOICE_AGENT_NAME).toMatch(/^[a-z0-9-]+$/);
  });
});
