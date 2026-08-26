/**
 * Delivering a verdict to the score store.
 *
 * One place knows the wire shape (POST the body to `<endpoint>/scores`) and
 * one place reads the answer, so the live send and the queue's retries cannot
 * drift apart. Both call `sendVerdict`; only the number of attempts differs.
 */

export interface SendReport {
  /**
   *   delivered  the store has the verdict: it applied the batch, or it
   *              answered a 207 that does not still list the trace as
   *              waiting (applied to the other traces, or refused for a
   *              reason such as a malformed row). Either way, sending again
   *              changes nothing.
   *   pending    the store may still take it: the trace has not landed yet
   *              (a 207 that names the trace as unknown), or the store is
   *              not answering (5xx, 408, 429, a dropped connection).
   *   refused    a permanent 4xx: a bad key or a bad body keeps answering the
   *              same way, so retrying is pointless and the caller should
   *              drop the verdict and say so.
   */
  outcome: 'delivered' | 'pending' | 'refused';
  attempts: number;
  lastStatus: number | null;
}

export interface SendDeps {
  /** Base URL; `/scores` is appended. */
  endpoint: string;
  headers: Record<string, string>;
  timeoutMs?: number | undefined;
  fetchImpl?: ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | undefined;
  sleepImpl?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * The answer to one send, in the words the queue already thinks in. `status`
 * is 0 when the connection never completed.
 */
export function readOutcome(
  status: number,
  body: string,
  traceId: string,
): { outcome: SendReport['outcome']; detail: string } {
  if (status >= 200 && status < 300 && status !== 207) {
    return { outcome: 'delivered', detail: '' };
  }
  if (status === 207) {
    let unknown: unknown;
    try {
      unknown = (JSON.parse(body) as { unknown?: unknown }).unknown;
    } catch {
      unknown = undefined;
    }
    // A 207 lists the traces the store did not apply the batch to. Ours is
    // in that list: it has not landed yet, and a later send will find it.
    // Ours is not: it was applied, or it was refused for a reason (no such
    // trace on the account, a bad row) that will not change on a resend.
    if (Array.isArray(unknown) && unknown.includes(traceId)) {
      return { outcome: 'pending', detail: 'the trace has not landed yet' };
    }
    return { outcome: 'delivered', detail: 'the store did not apply it' };
  }
  // 4xx, other than 408/429, is a permanent refusal.
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { outcome: 'refused', detail: `refused (HTTP ${status})` };
  }
  return { outcome: 'pending', detail: status === 0 ? 'no response' : `HTTP ${status}` };
}

/**
 * Send `body` until the store answers for good, or until `maxAttempts` is
 * spent. Waits `retries[attempt-2]` before attempt n (the last entry repeats
 * when there are more attempts than delays). Never throws: a send that
 * cannot be made is a `pending` answer.
 */
export async function sendVerdict(
  deps: SendDeps,
  traceId: string,
  body: string,
  maxAttempts: number,
  retries: number[],
): Promise<SendReport> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${deps.endpoint.replace(/\/+$/, '')}/scores`;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const attempts = Math.max(1, maxAttempts);

  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      const i = attempt - 2;
      await sleep(retries[i] ?? retries[retries.length - 1] ?? 3000);
    }
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...deps.headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = res.status;
      const out = readOutcome(res.status, await res.text(), traceId);
      if (out.outcome !== 'pending') {
        return { outcome: out.outcome, attempts: attempt, lastStatus };
      }
    } catch {
      lastStatus = 0;
    }
  }
  return { outcome: 'pending', attempts, lastStatus };
}
