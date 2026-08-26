import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOutcome, sendVerdict } from './transport.ts';

const D = {
  endpoint: 'http://store.test/v1',
  headers: { 'x-api-key': 'k' },
};

test('readOutcome: the verdict protocol, one rule per answer', () => {
  assert.equal(readOutcome(200, '{"applied":[]}', 't1').outcome, 'delivered');

  // 207 that names the trace as unknown: the trace has not landed yet.
  assert.equal(readOutcome(207, '{"unknown":["t1","t2"]}', 't1').outcome, 'pending');
  // ...but one that does not name it is final: applied to the others, or refused.
  assert.equal(readOutcome(207, '{"unknown":["t2"]}', 't1').outcome, 'delivered');
  assert.equal(readOutcome(207, 'not json', 't1').outcome, 'delivered');

  // 4xx (not 408/429) is a permanent refusal.
  assert.equal(readOutcome(401, '', 't1').outcome, 'refused');
  assert.equal(readOutcome(400, '{"error":"No measurements in the request"}', 't1').outcome, 'refused');
  // 408/429 and 5xx may pass next time.
  assert.equal(readOutcome(429, '', 't1').outcome, 'pending');
  assert.equal(readOutcome(500, '', 't1').outcome, 'pending');
  // A dropped connection is a no-response, not an answer.
  assert.equal(readOutcome(0, '', 't1').outcome, 'pending');
});

test('sendVerdict: delivered on the first try posts once', async () => {
  const posts: unknown[] = [];
  const deps = {
    ...D,
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
    sleepImpl: async () => {},
  };
  const r = await sendVerdict(deps, 't1', '{"traceId":"t1"}', 3, [100, 200]);
  assert.deepEqual(r, { outcome: 'delivered', attempts: 1, lastStatus: 200 });
  assert.equal(posts.length, 1);
});

test('sendVerdict: a 207 unknown-trace is retried, then delivered', async () => {
  let tries = 0;
  const sleeps: number[] = [];
  const deps = {
    ...D,
    fetchImpl: (async () => {
      tries += 1;
      return tries === 1
        ? new Response(JSON.stringify({ unknown: ['t1'] }), { status: 207 })
        : new Response('{}', { status: 200 });
    }) as typeof fetch,
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  const r = await sendVerdict(deps, 't1', '{}', 3, [100, 200]);
  assert.deepEqual(r, { outcome: 'delivered', attempts: 2, lastStatus: 200 });
  assert.deepEqual(sleeps, [100]);
});

test('sendVerdict: the attempt cap ends in pending, waiting the given delays', async () => {
  const sleeps: number[] = [];
  const deps = {
    ...D,
    fetchImpl: (async () => new Response('down', { status: 503 })) as typeof fetch,
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  const r = await sendVerdict(deps, 't1', '{}', 3, [100, 200]);
  assert.deepEqual(r, { outcome: 'pending', attempts: 3, lastStatus: 503 });
  assert.deepEqual(sleeps, [100, 200]);
});

test('sendVerdict: a permanent 4xx stops at once and is refused', async () => {
  let tries = 0;
  const deps = {
    ...D,
    fetchImpl: (async () => {
      tries += 1;
      return new Response('bad key', { status: 401 });
    }) as typeof fetch,
    sleepImpl: async () => {},
  };
  const r = await sendVerdict(deps, 't1', '{}', 3, [100, 200]);
  assert.deepEqual(r, { outcome: 'refused', attempts: 1, lastStatus: 401 });
  assert.equal(tries, 1);
});

test('sendVerdict: a dropped connection is retried like a 5xx', async () => {
  let tries = 0;
  const deps = {
    ...D,
    fetchImpl: (async () => {
      tries += 1;
      if (tries === 1) throw new Error('socket closed');
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
    sleepImpl: async () => {},
  };
  const r = await sendVerdict(deps, 't1', '{}', 2, [100]);
  assert.deepEqual(r, { outcome: 'delivered', attempts: 2, lastStatus: 200 });
});
