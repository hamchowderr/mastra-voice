import { fileURLToPath } from 'node:url';

import { createLiveKitWorker, runLiveKitWorker } from '@mastra/livekit/worker';

import { mastra } from './index';
import { VOICE_AGENT_ID, VOICE_AGENT_NAME } from './lib/voice';

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
    greeting: {
      text: "Hi, you're through to the voice assistant. How can I help?",
    },
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
