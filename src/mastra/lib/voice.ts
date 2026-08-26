import { randomUUID } from 'node:crypto';

import type { ConnectionRequestArgs } from '@mastra/livekit';

/**
 * The LiveKit agent name, used for explicit dispatch.
 *
 * This MUST be identical everywhere it appears — the connection route, the
 * worker's `runLiveKitWorker`, and any `dispatchVoiceSession`. A mismatch does
 * not error: LiveKit simply never routes the job, so calls connect and then sit
 * in silence forever. Import this constant instead of writing the string again.
 *
 * Deliberately its own module: the Mastra server imports it for the connection
 * route, and the worker imports it too — but the server must never pull in the
 * worker's `@livekit/agents` runtime, so this cannot live in either.
 */
export const VOICE_AGENT_NAME = 'mastra-voice';

/** The Mastra agent key the voice worker runs. Must match `agents` in index.ts. */
export const VOICE_AGENT_ID = 'voiceAssistant';

/** Per-request cache slot so one connection resolves to exactly one resource id. */
const RESOURCE_ID_CACHE_KEY = 'voice__resolvedResourceId';

/**
 * The memory scope for a voice call, derived from the VERIFIED caller — never
 * from the request body.
 *
 * `liveKitConnectionRoute`'s default reads agentId/threadId/resourceId straight
 * out of the POST body. That is caller-controlled: anyone who names another
 * caller's resourceId reads that caller's memory (an IDOR on the memory store).
 * The shipped LiveKit example does exactly this and labels itself DEMO ONLY;
 * this template is published and degit-able, so it must not.
 *
 * - `resourceId` comes from the authenticated JWT subject. MastraJwtAuth's
 *   `authenticateToken` returns the verified payload, which the server stores on
 *   the request context under `user`, so `sub` here has been signature-checked.
 * - `threadId` is minted server-side per connection, so a caller cannot attach
 *   to someone else's conversation by guessing a thread id.
 *
 * NO AUTH CONFIGURED (MASTRA_JWT_SECRET unset, i.e. open local dev): there is no
 * verified identity, so this returns a fresh anonymous id per connection. That
 * is deliberately useless for memory continuity — the safe failure. It does NOT
 * fall back to the body, because a template that trusts the body in dev is a
 * template that ships the IDOR the moment someone deploys it. To exercise
 * persistent voice memory locally, set MASTRA_JWT_SECRET and send a real token.
 */
export function resolveVoiceResourceId({ context }: ConnectionRequestArgs): string {
  const requestContext = context.get('requestContext');

  // The route calls this once for `metadata` and again for `participantIdentity`.
  // Cache per request: the anonymous branch below mints a fresh id each call, so
  // without this the participant identity and the memory scope disagree within a
  // single connection.
  const cached = requestContext?.get(RESOURCE_ID_CACHE_KEY);
  if (typeof cached === 'string' && cached.length > 0) return cached;

  const user = requestContext?.get('user') as Record<string, unknown> | undefined;

  // `sub` is the standard JWT subject; id/userId cover custom auth providers.
  let resourceId = `anon-${randomUUID()}`;
  for (const claim of [user?.sub, user?.id, user?.userId]) {
    if (typeof claim === 'string' && claim.length > 0) {
      resourceId = claim;
      break;
    }
  }

  requestContext?.set(RESOURCE_ID_CACHE_KEY, resourceId);
  return resourceId;
}

/** Server-minted memory scope for one call. Nothing here is caller-controlled. */
export function resolveVoiceSessionMetadata(args: ConnectionRequestArgs) {
  return {
    agentId: VOICE_AGENT_ID,
    resourceId: resolveVoiceResourceId(args),
    threadId: randomUUID(),
  };
}
