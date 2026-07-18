import { randomUUID } from 'node:crypto';

import { doltConfigured, ensureDatabase, query, commit } from './dolt';

/**
 * # Compliance ledger — the durable, versioned audit trail for regulated calls
 *
 * The regulated voice flavor produces records that must be PROVABLE after the
 * fact: the AI-disclosure was given (voice-9jm.6), each consent was captured
 * (voice-9jm.7), and how the call ended (voice-9jm.8). The in-process consent
 * store (`consent-ledger.ts`) is enough to ENFORCE policy within a single call,
 * but it is not an audit trail — it evaporates on restart.
 *
 * This module is the audit trail. It follows the vault's two-DB split: Postgres
 * owns framework data (threads / memory / traces); Dolt owns product & compliance
 * data. Every write ends in a Dolt commit, so each call's compliance record is
 * tamper-evident, diffable, and time-travelable — `git log` for consent.
 *
 * ## How it's wired (all OFF the caller's clock)
 *
 * Events are buffered per call as they happen (consent grant → `recordConsentGrant`;
 * hang-up → the endCall tool's `onEndCall`), then flushed ONCE at `onCallEnd` as a
 * single attributed Dolt commit (see src/mastra/voice-worker.ts). Nothing here runs
 * on the audio path — the flush happens inside LiveKit's shutdown window.
 *
 * ## Dormant by default
 *
 * The template ships with Dolt present but unconfigured (DOLT_* unset). Every entry
 * point below no-ops when `doltConfigured` is false, so the default template runs
 * without a Dolt service and CI/eval never touch it. Bring up the compose `dolt`
 * service + set DOLT_* to turn the ledger on. Swap this module for your own system
 * of record (a compliance DB, an append-only log service) if Dolt isn't your tool.
 */

/** One buffered compliance event within a call. `at` is stamped when it happened. */
export type ComplianceEvent =
  | { event: 'disclosure'; detail: string; at: Date }
  | { event: 'consent'; item: string; granted: boolean; at: Date }
  | { event: 'hangup'; detail?: string; at: Date };

/** Identifying context for a call, resolved from the memory mapping at flush time. */
export interface CallIdentity {
  /** The call thread — unique per call; the buffer key. */
  threadId: string;
  /** The caller (memory resource), when the call is memory-scoped. */
  resourceId?: string;
  /** The LiveKit room, for cross-referencing logs. */
  roomName?: string;
}

// Per-call buffers, keyed by threadId (unique per call). A call accumulates its
// events here during the call, then flushes and clears them at onCallEnd.
const buffers = new Map<string, ComplianceEvent[]>();

/**
 * Buffer one compliance event for a call. Cheap and synchronous — safe to call
 * from inside a turn (it does no I/O). Dropped silently when the call isn't
 * memory-scoped (`threadId` empty), since an unattributable record is worthless.
 */
export function noteComplianceEvent(threadId: string | undefined, event: ComplianceEvent): void {
  if (!threadId) return;
  const existing = buffers.get(threadId);
  if (existing) existing.push(event);
  else buffers.set(threadId, [event]);
}

let schemaReady = false;

/**
 * Create the append-only compliance table if it isn't there yet. Idempotent;
 * runs once per process. `ensureDatabase()` first, so a fresh Dolt volume works.
 */
async function ensureComplianceSchema(): Promise<void> {
  if (schemaReady) return;
  await ensureDatabase();
  await query(`
    CREATE TABLE IF NOT EXISTS voice_compliance (
      id           VARCHAR(64)  NOT NULL PRIMARY KEY,
      call_thread  VARCHAR(255) NOT NULL,
      resource_id  VARCHAR(255),
      room_name    VARCHAR(255),
      event        VARCHAR(32)  NOT NULL,
      item         VARCHAR(64),
      granted      TINYINT,
      detail       TEXT,
      occurred_at  DATETIME     NOT NULL,
      INDEX idx_call_thread (call_thread),
      INDEX idx_resource (resource_id)
    )
  `);
  schemaReady = true;
}

/** Result of a flush, so the caller can log what landed (or that Dolt was off). */
export interface ComplianceFlushResult {
  /** True only when rows were actually written and committed to Dolt. */
  committed: boolean;
  /** Number of events written. */
  count: number;
  /** The Dolt commit hash, when committed. */
  commit?: string;
}

/**
 * Flush a call's buffered compliance events to Dolt as ONE attributed commit, then
 * clear the buffer. No-ops (and clears) when Dolt isn't configured or the call had
 * no events. Never throws for a caller reason — the worker awaits this inside the
 * shutdown window, and a compliance-store hiccup must not crash teardown; failures
 * are surfaced via the return value / a thrown error the worker logs.
 *
 * One commit per call gives a clean audit unit: `dolt_log` has a row per completed
 * call, and `dolt diff` shows exactly what that call recorded.
 */
export async function flushComplianceLedger(
  identity: CallIdentity,
  directedBy = 'system',
): Promise<ComplianceFlushResult> {
  const events = buffers.get(identity.threadId);
  buffers.delete(identity.threadId);

  if (!doltConfigured || !events || events.length === 0) {
    return { committed: false, count: 0 };
  }

  await ensureComplianceSchema();

  for (const e of events) {
    await query(
      `INSERT INTO voice_compliance
         (id, call_thread, resource_id, room_name, event, item, granted, detail, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        identity.threadId,
        identity.resourceId ?? null,
        identity.roomName ?? null,
        e.event,
        e.event === 'consent' ? e.item : null,
        e.event === 'consent' ? (e.granted ? 1 : 0) : null,
        e.event === 'disclosure' ? e.detail : e.event === 'hangup' ? (e.detail ?? null) : null,
        e.at,
      ],
    );
  }

  const summary = `voice compliance: ${events.length} event(s) for call ${identity.threadId}`;
  const hash = await commit(summary, {
    author: 'Voice Compliance Worker <compliance@otaku.local>',
    directedBy,
    autonomy: 'autonomous',
  });

  return { committed: true, count: events.length, commit: hash.slice(0, 8) };
}
