import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerdictQueue, backoffMs } from './verdict-queue.ts';
import type { Store } from './sessions.ts';

/** An in-memory Memento stand-in, the same shape sessions.test.ts would give. */
function memStore(): Store {
  const m = new Map<string, unknown>();
  return {
    get: (k, fb) => (m.has(k) ? (m.get(k) as never) : fb),
    update: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
  };
}

const T0 = Date.parse('2026-08-25T12:00:00Z');

const item = (over: Partial<Parameters<VerdictQueue['add']>[0]> = {}): Parameters<VerdictQueue['add']>[0] => ({
  traceId: 't1',
  body: '{"traceId":"t1","scores":[]}',
  enqueuedAt: T0,
  attempts: 0,
  lastAttemptAt: null,
  ...over,
});

test('backoffMs: grows with the attempts and stops at the cap', () => {
  const a = backoffMs(1);
  assert.ok(backoffMs(2) > a && backoffMs(3) > backoffMs(2));
  assert.ok(backoffMs(30) <= 6 * 3600 * 1000);
});

test('add replaces the earlier entry for the same trace', () => {
  const q = new VerdictQueue(memStore());
  q.add(item({ attempts: 1 }));
  q.add(item({ attempts: 2 }));
  assert.equal(q.size, 1);
  assert.equal(q.list()[0]!.attempts, 2);
});

test('remove deletes only the named trace', () => {
  const q = new VerdictQueue(memStore());
  q.add(item());
  q.add(item({ traceId: 't2' }));
  q.remove('t1');
  assert.deepEqual(q.list().map((v) => v.traceId), ['t2']);
});

test('a corrupt store entry is read as empty rather than crashing', () => {
  const store = memStore();
  void store.update('daisy.judge.pending', 'not an array');
  const q = new VerdictQueue(store);
  assert.equal(q.size, 0);
});

test('flush: a delivered verdict leaves the queue', async () => {
  const q = new VerdictQueue(memStore());
  q.add(item());
  const r = await q.flush(
    {
      endpoint: 'http://store.test/v1',
      headers: {},
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      sleepImpl: async () => {},
    },
    T0 + 60_000,
  );
  assert.deepEqual(r.delivered, ['t1']);
  assert.equal(q.size, 0);
});

test('flush: a still-pending verdict stays, with one attempt counted', async () => {
  const q = new VerdictQueue(memStore());
  q.add(item());
  await q.flush(
    {
      endpoint: 'http://store.test/v1',
      headers: {},
      fetchImpl: (async () => new Response('down', { status: 503 })) as typeof fetch,
      sleepImpl: async () => {},
    },
    T0 + 60_000,
  );
  assert.equal(q.size, 1);
  assert.equal(q.list()[0]!.attempts, 1);
  assert.ok(q.list()[0]!.lastAttemptAt == T0 + 60_000);
});

test('flush: a backed-off verdict is not sent again too soon', async () => {
  const q = new VerdictQueue(memStore());
  q.add(item({ attempts: 1, lastAttemptAt: T0 }));
  let sent = 0;
  const r = await q.flush(
    {
      endpoint: 'http://store.test/v1',
      headers: {},
      fetchImpl: (async () => {
        sent += 1;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
      sleepImpl: async () => {},
    },
    T0 + 1000, // one second after the last attempt; the backoff is longer
  );
  assert.equal(sent, 0);
  assert.equal(r.remaining, 1);
});

test('flush: a permanently refused verdict is dropped and named', async () => {
  const q = new VerdictQueue(memStore());
  q.add(item());
  const r = await q.flush(
    {
      endpoint: 'http://store.test/v1',
      headers: {},
      fetchImpl: (async () => new Response('bad key', { status: 401 })) as typeof fetch,
      sleepImpl: async () => {},
    },
    T0 + 60_000,
  );
  assert.equal(q.size, 0);
  assert.equal(r.refused.length, 1);
  assert.equal(r.refused[0]!.traceId, 't1');
});

test('flush: a verdict older than a week is expired, not sent', async () => {
  const q = new VerdictQueue(memStore());
  q.add(item());
  let sent = 0;
  const r = await q.flush(
    {
      endpoint: 'http://store.test/v1',
      headers: {},
      fetchImpl: (async () => {
        sent += 1;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
      sleepImpl: async () => {},
    },
    T0 + 8 * 24 * 3600 * 1000,
  );
  assert.equal(sent, 0);
  assert.equal(r.expired, 1);
  assert.equal(q.size, 0);
});

test('the queue survives a "reload": a fresh instance on the same store picks it up', async () => {
  const store = memStore();
  const first = new VerdictQueue(store);
  first.add(item());
  // The process dies here. The next activation builds a new queue on the same state.
  const next = new VerdictQueue(store);
  assert.equal(next.size, 1);
  const r = await next.flush(
    {
      endpoint: 'http://store.test/v1',
      headers: {},
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      sleepImpl: async () => {},
    },
    T0 + 60_000,
  );
  assert.deepEqual(r.delivered, ['t1']);
  assert.equal(next.size, 0);
});
