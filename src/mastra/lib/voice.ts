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
