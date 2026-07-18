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
  //
  // NOTE (voice-l9r): @livekit/agents 1.5.x deprecates this text-based turn
  // detector in favor of the audio EOT `TurnDetector` (@livekit/agents/inference).
  // Migration is deferred, not overlooked: @mastra/livekit@0.3.0 still documents
  // 'multilingual' as supported and only constructs a custom TurnDetector INSIDE
  // the job context — a module-scope instance freezes its inference executor to
  // `undefined`, degrading the local v1-mini fallback. Deprecated != broken, and
  // the swap needs real-audio verification (voice-9jm.12). Revisit when
  // @mastra/livekit ships native audio-EOT support.
  turnDetection: 'multilingual',

  // Silero VAD (the default) — stated explicitly because it's a knob worth knowing.
  vad: 'silero',

  // Turn-taking tuning (voice-9jm.10). @mastra/livekit merges this over the
  // AgentSession defaults, and — importantly — forces preemptiveGeneration OFF
  // regardless of what's here: this template has memory, and a speculative turn
  // that completes before LiveKit discards it persists a user message AND a
  // never-spoken reply, duplicating thread history. So it's intentionally absent.
  turnHandling: {
    // Endpointing decides when the caller's turn is over. 'dynamic' adjusts the
    // wait from the turn detector's end-of-utterance prediction rather than a
    // fixed delay, so a caller who pauses mid-thought isn't cut off while a clean
    // stop is still picked up quickly. minDelay/maxDelay left at LiveKit's
    // defaults (500ms / 3000ms) — tune them against REAL audio in voice-9jm.12,
    // not by guesswork here.
    endpointing: { mode: 'dynamic' },
    // Interruption (barge-in) is on by default. These are the knobs to reach for:
    // minDuration ignores sub-500ms blips as interruptions; resumeFalseInterruption
    // resumes the reply if the "interruption" turns out to be silence. Left at
    // their defaults, named here as the tuning surface.
    interruption: { minDuration: 500, resumeFalseInterruption: true },
  },

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

    // Agent-initiated hang-up (voice-9jm.8). The agent ends the call itself by
    // calling the `endCall` tool (see tools/end-call.ts) as its final action; the
    // worker owns the actual hang-up. Enabling it here + matching the tool name is
    // all it takes — the worker watches each turn for the tool, waits for the
    // agent's closing words to finish playing, then disconnects (running onCallEnd
    // on the way out, exactly as a caller hang-up does). The tool name must match
    // createEndCallTool's id (both default to 'endCall').
    endCall: {
      // A guaranteed, NON-interruptible sign-off spoken after the agent's own
      // goodbye, right before hang-up — the caller can't talk over it. This is the
      // compliance-closing seam (e.g. a required recording/retention notice); kept
      // to a plain goodbye here since the AI disclosure already played at greeting.
      message: 'Thank you for calling. Goodbye.',
      // Recorded on the shutdown, visible in LiveKit logs.
      reason: 'assistant wrapped up the call',
      // drainMs defaults to 800ms (holds buffered audio at the caller so the tail of
      // the goodbye isn't clipped); maxWaitMs defaults to 30s (safety cap on waiting
      // for the closing words to finish). Defaults are right for a phone call —
      // named here only as the knobs to reach for.
    },
  },

  // ── Lifecycle hooks (voice-9jm.9): keep slow work off the caller's clock ──
  //
  // The LiveKit voice workshop's latency rule is the contract here: "manage as
  // much of the expensive work after the call has been over instead of having
  // tool calls that run during the experience... people will be impatient." So
  // the worker gives you three hooks on the latency-correct paths — two per turn
  // (toolFeedback DURING a tool, onTurnComplete AFTER the reply), and onCallEnd
  // once at the end (below). Nothing here may sit on the audio path.

  // Spoken WHILE a Mastra tool call runs, so a slow tool doesn't leave the caller
  // in silence. Return a short phrase to speak it (it also lands in the
  // transcript); return nothing to stay silent. Keep it to a few words — it's
  // filler, not the answer. Stays silent for instant / awkward-to-narrate tools
  // (consent capture, hang-up): narrating "let me record that" over a yes/no is
  // worse than saying nothing.
  toolFeedback: ({ toolName }) => {
    switch (toolName) {
      case 'getCurrentTime':
        return 'Let me check the time.';
      case 'evaluateMath':
        return 'Let me work that out.';
      default:
        // recordConsent / endCall and anything else: no filler.
        return undefined;
    }
  },

  // Fired once per turn AFTER the reply has streamed to TTS — FIRE-AND-FORGET.
  // The worker never awaits it, so anything here (CRM writes, analytics, logging)
  // can't delay the caller or the next turn. This is the seam for per-turn side
  // effects; the durable, attributable compliance write belongs at end-of-call /
  // the Dolt ledger (voice-9jm.22), not on every turn. `memory` is `false` when
  // memory is disabled — guard it before reading thread/resource.
  onTurnComplete: ({ result, memory }) => {
    const resource = memory ? memory.resource : undefined;
    // Template seam: swap this log for your CRM/analytics write. It runs off the
    // audio path, so a slow sink here never reaches the caller.
    console.info('[turn]', {
      resource,
      chars: result.text.length,
      tools: result.toolCalls.map((t) => t.toolName),
      interrupted: result.interrupted,
    });
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
      // call arrives. The real fix is a lighter subprocess import (does the
      // worker need editor/evals/mcp?) — tracked for a future pass.
      initializeProcessTimeout: 60_000,

      // Prewarm exactly ONE idle runner so the first call is answered warm
      // instead of paying the ~2GB / 60s boot on the caller's clock. LiveKit's
      // production default is min(cores, 4) idle runners — but each re-imports
      // the full ~2GB Mastra instance, so the default would pin up to ~8GB
      // resident before a single call. One hot runner is the right trade for
      // this heavy-import template; raise it only on a box with the RAM to spare.
      numIdleProcesses: 1,

      // Each runner's baseline is ~2GB (fastembed/onnx), which trips LiveKit's
      // 1000MB default job-memory advisory on EVERY run — burying any real
      // memory-pressure signal in noise. Raise the warn line above the known
      // baseline so a warning means genuine growth. jobMemoryLimitMB is left at
      // 0 (no hard cap): a hard limit here would OOM-kill a legitimately ~2GB
      // runner mid-call. Trim the import instead if memory actually matters.
      jobMemoryWarnMB: 3072,
    },
  });
}
