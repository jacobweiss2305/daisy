/**
 * Verdicts that have not reached the score store yet.
 *
 * The judge runs after the turn, in the background, and the extension host
 * dies on every VS Code reload. A verdict in flight at that moment used to be
 * lost with the process. This queue keeps the answer to "what did the judge
 * say" in the workspace's state:
 *
 *   1. the verdict is written here BEFORE its first send,
 *   2. it is removed only when the store has it (delivered, or permanently
 *      refused: both are final answers),
 *   3. on activation, whatever is left is sent again.
 *
 * The store keys measurements by (trace, name) and a resend replaces the
 * first, so a retry is a correction, never a duplicate.
 *
 * The persistence is the same structural Memento slice sessions.ts uses,
 * which keeps this file free of vscode and testable plainly.
 */
import type { Store } from './sessions.ts';
import { sendVerdict, type SendDeps, type SendReport } from './transport.ts';

const KEY = 'daisy.judge.pending';
/** Most pending verdicts kept; beyond this the oldest drops. */
const MAX_ITEMS = 50;
/** A verdict older than this is abandoned: the turn it judged is long cold. */
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** A verdict retried this many times is abandoned, whatever the store says. */
const MAX_ATTEMPTS = 40;

export interface PendingVerdict {
  traceId: string;
  /** The exact JSON body the judge built, unchanged on the way back out. */
  body: string;
  enqueuedAt: number;
  attempts: number;
  /** When the last send that still needs a follow-up went out. */
  lastAttemptAt: number | null;
}

export interface FlushReport {
  /** Traces whose verdict reached the store this flush. */
  delivered: string[];
  /** Traces the store refused permanently; nothing more can be done. */
  refused: { traceId: string; detail: string }[];
  /** Verdicts too old or too often retried to keep trying. */
  expired: number;
  /** Queue size afterwards (still-pending and still-backoffed). */
  remaining: number;
}

/**
 * Wait after attempt n, growing with the attempts so a dead endpoint is not
 * hammered, capped so a healed one is still found.
 */
export function backoffMs(attempts: number): number {
  return Math.min(6 * 3600 * 1000, 15_000 * 2 ** Math.max(0, attempts - 1));
}

export class VerdictQueue {
  private readonly store: Store;
  /** One in-flight send per trace, so two flushes cannot race the same verdict. */
  private readonly inflight = new Set<string>();

  constructor(store: Store) {
    this.store = store;
  }

  list(): PendingVerdict[] {
    const items = this.store.get<unknown>(KEY, []);
    return Array.isArray(items) ? (items as PendingVerdict[]) : [];
  }

  get size(): number {
    return this.list().length;
  }

  /** Remember a verdict. Re-enqueuing a trace replaces its earlier entry. */
  add(item: PendingVerdict): void {
    const left = this.list().filter((v) => v.traceId !== item.traceId);
    left.push(item);
    void this.store.update(KEY, left.slice(-MAX_ITEMS));
  }

  remove(traceId: string): void {
    void this.store.update(KEY, this.list().filter((v) => v.traceId !== traceId));
  }

  private write(items: PendingVerdict[]): void {
    void this.store.update(KEY, items);
  }

  /**
   * Send one stored verdict and settle its bookkeeping in place.
   *
   *   delivered -> the verdict is with the store; drop it.
   *   refused   -> the store will keep refusing; drop it, and say so, so the
   *                user fixes the endpoint or key instead of watching the
   *                queue spin.
   *   pending   -> keep it, one attempt counted, next try after the backoff.
   */
  async send(
    item: PendingVerdict,
    deps: SendDeps,
    now: number,
    maxAttempts: number,
    retries: number[],
  ): Promise<SendReport> {
    const report = await sendVerdict(deps, item.traceId, item.body, maxAttempts, retries);
    if (report.outcome === 'pending') {
      this.add({ ...item, attempts: item.attempts + 1, lastAttemptAt: now });
    } else {
      this.remove(item.traceId);
    }
    return report;
  }

  /**
   * Send every stored verdict that is due. Called on activation; cheap when
   * the queue is empty, which it is on every ordinary startup.
   */
  async flush(
    deps: SendDeps,
    now: number = Date.now(),
    onDelivered?: (item: PendingVerdict) => void,
  ): Promise<FlushReport> {
    const report: FlushReport = { delivered: [], refused: [], expired: 0, remaining: 0 };
    let items = this.list();

    // Drop the cold and the hopeless first, so a backlog cannot outlive its
    // usefulness or an endpoint that never answers be retried forever.
    const kept: PendingVerdict[] = [];
    for (const item of items) {
      if (now - item.enqueuedAt > MAX_AGE_MS || item.attempts >= MAX_ATTEMPTS) {
        report.expired += 1;
        continue;
      }
      kept.push(item);
    }
    if (report.expired > 0) this.write(kept);
    items = kept;

    for (const item of items) {
      if (this.inflight.has(item.traceId)) continue;
      // Backed off: the last send was recent enough that the store has not
      // had a fair chance; wait rather than burn an attempt.
      if (item.lastAttemptAt != null && now - item.lastAttemptAt < backoffMs(item.attempts)) {
        continue;
      }

      this.inflight.add(item.traceId);
      let result;
      try {
        // One try per flush: if the store is down when VS Code starts, the
        // next start takes over with a longer backoff, and the attempt count
        // grows one at a time.
        result = await this.send(item, deps, now, 1, [0]);
      } catch (e) {
        // sendVerdict does not throw, but a corrupt body could make JSON
        // handling elsewhere; treat it as "still pending" rather than losing
        // the verdict.
        result = { outcome: 'pending', attempts: 1, lastStatus: 0 };
      } finally {
        this.inflight.delete(item.traceId);
      }

      if (result.outcome === 'delivered') {
        report.delivered.push(item.traceId);
        try {
          onDelivered?.(item);
        } catch {
          // The caller's status line is best-effort; the verdict is already in.
        }
      } else if (result.outcome === 'refused') {
        report.refused.push({
          traceId: item.traceId,
          detail: result.lastStatus == null ? 'no response' : `HTTP ${result.lastStatus}`,
        });
      }
    }

    report.remaining = this.size;
    return report;
  }
}
