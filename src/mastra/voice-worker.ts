import { fileURLToPath } from 'node:url';

import { createLiveKitWorker, runLiveKitWorker } from '@mastra/livekit/worker';

import { mastra } from './index';
import { VOICE_AGENT_ID, VOICE_AGENT_NAME } from './lib/voice';
import { hasConsent } from './lib/consent-ledger';
import type { Memory } from '@mastra/memory';

/**
 * LiveKit voice worker — the realtime audio loop.
 *
 * A standalone Node process, separate from the Mastra HTTP server. LiveKit owns
 * the audio loop (VAD, streaming STT, turn detection, barge-in, TTS); Mastra owns
 * the reply, tools, and memory. The two talk over the LiveKit room.
 *
 * NOT bundled by `mastra build` — nothing imports this file, so it builds and runs
 * on its own. Run it with tsx against source (see the worker:* scripts in
 * package.json); bundling would drag in LiveKit's native deps (onnxruntime, …).
 *
 * Who runs it:
 *   Dev:  npm run worker:dev    (hot reload)
 *   Prod: npm run worker:start  (`dev` is hot-reload only — never ship it)
 *
 * One-time before first run: `npm run worker:download-files` fetches the Silero
 * VAD + turn-detector ONNX models. In Docker, bake this into the image so cold
 * starts don't pay for it.
 *
 * Only ONE worker flavor can run at a time — they all register under the same
 * agentName, so LiveKit would round-robin calls between them.
 */
export default createLiveKitWorker({
  mastra,
  // Same key the connection route names in its dispatch metadata.
  agent: VOICE_AGENT_ID,

  // Routed through LiveKit Cloud inference — no separate Deepgram/Cartesia
  // accounts, just the LIVEKIT_* credentials. Pass plugin instances instead of
  // strings to bring your own providers.
  stt: 'deepgram/nova-3',
  tts: 'cartesia/sonic-3',

  // Semantic end-of-turn, run locally on CPU against the live transcript, so a
  // caller who pauses mid-thought isn't cut off. 'english' is the lighter model.
  turnDetection: 'multilingual',

  // Silero VAD (the default) — stated explicitly because it's a knob worth knowing.
  vad: 'silero',

  configuration: {
    // AI-disclosure greeting — lawful by default. EU AI Act Art. 50 requires
    // telling a person they're interacting with an AI at the first interaction;
    // California SB 243 (and similar) require periodic re-disclosure on long
    // calls. The greeting is spoken via TTS with NO model round-trip, so this
    // costs zero LLM latency. For a per-tenant disclosure, pass a resolver as
    // `text` instead of a string — the flags below still apply to what it returns.
    greeting: {
      // Discloses up front that the caller is speaking with an AI.
      text: "Hi, you're speaking with an AI voice assistant. How can I help you today?",
      // The caller cannot barge over the disclosure — it must actually be heard.
      allowInterruptions: false,
      // Hold post-greeting work (persistence, onSessionStart) until it plays out,
      // so the disclosure fully completes before anything else runs.
      awaitPlayout: true,
      // Persist the spoken disclosure to the memory thread as proof it was given
      // (default true; explicit here — this is the compliance evidence trail).
      persist: true,
      // Re-disclose ~every 3 minutes on long calls, prefixed onto the next turn's
      // reply at a turn boundary (never mid-sentence). Use ~45_000 for demos.
      repeatEvery: 3 * 60_000,
      repeatText: 'Quick reminder — you are speaking with an AI assistant.',
    },

    // Consent policy — DECLARE only; the worker enforces nothing on its own. Each item
    // is independently required and independently granted (no global "consented" flag).
    // Captured at runtime by the recordConsent tool on the agent (see tools/consent.ts),
    // and enforced in onCallEnd below. Keep these keys in sync with that tool's `items`
    // and the agent's instructions — there is no compile-time check that they agree.
    consentPolicy: {
      summaryStorage: { required: true, purpose: 'storing a summary of this call' },
    },
  },

  // ENFORCE the consent policy at end-of-call. Runs off the audio path, awaited inside
  // LiveKit's shutdown window. Deny-by-default: only store the end-of-call summary when
  // summaryStorage isn't required, or the caller actually granted it.
  onCallEnd: async ({ memory, memoryInstance, configuration }) => {
    const req = configuration?.consentPolicy?.summaryStorage;
    const required = req === true || (typeof req === 'object' && req?.required !== false);
    const resourceId = memory ? memory.resource : undefined;
    const threadId = memory ? memory.thread : undefined;

    if (required && !hasConsent(resourceId, 'summaryStorage')) {
      console.info('[consent] summaryStorage not granted — skipping the end-of-call summary.');
      return;
    }
    if (!threadId || !memoryInstance) return;

    // Consent-gated action: distill the finished call into a stored summary.
    // memoryInstance is typed as the base MastraMemory; the concrete instance here is
    // the @mastra/memory Memory (from createDefaultMemory), which adds summarizeThread.
    await (memoryInstance as Memory).summarizeThread({
      threadId,
      resourceId,
      model: 'anthropic/claude-haiku-4-5',
      instructions: "Summarize this voice call: the caller's intent, what was done, and any follow-ups.",
    });
  },
});

// Only run the CLI when this file is the process entry, not when the LiveKit
// runtime imports it to read the default export above.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runLiveKitWorker({
    entry: import.meta.url,
    // Same constant the connection route dispatches to — a mismatch here means
    // calls connect and then sit in silence, with no error anywhere.
    agentName: VOICE_AGENT_NAME,
    serverOptions: {
      // LiveKit runs each job in a supervised subprocess that re-imports this
      // file — and therefore the whole Mastra instance: fastembed/onnx (~2GB
      // resident), pg, mcp, editor, evals, all transpiled through tsx. That
      // does not finish inside the 10s default, so every runner died with
      // "runner initialization timed out" and the worker registered but could
      // never answer a call. Raised, not worked around: this is the knob for
      // exactly this case. Measured cold on Windows; trim it only against a
      // real cold start, since a runner that dies here is invisible until a
      // call arrives.
      initializeProcessTimeout: 60_000,
    },
  });
}
