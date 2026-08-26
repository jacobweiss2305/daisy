import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeTurn, resolveJudge } from './judge.ts';
import { VerdictQueue } from './verdict-queue.ts';
import { DEFAULT_LIMITS } from './tools.ts';
import type { Store } from './sessions.ts';
import type { Message } from './llm.ts';

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

const SETTINGS = {
  enabled: true,
  endpoint: 'http://store.test/v1',
  headers: { 'x-api-key': 'k' },
  systemPrompt: '',
  maxLoops: 1,
  maxTranscriptBytes: 8192,
  source: 'daisy-judge',
  delayMs: 0,
};

const VERDICT = '{"score": 0.7, "pass_at": 0.7, "summary": "ok", "issues": []}';

function sseResponse(...frames: string[]): Response {
  const payload = frames.map((f) => `data: ${f}`).join('\n\n') + '\n\n' + 'data: [DONE]\n\n';
  return new Response(new TextEncoder().encode(payload), { status: 200 });
}

const turn = {
  chatId: 'c',
  turnNumber: 1,
  userText: 'do it',
  messages: [{ role: 'assistant', content: 'ok' }] as Message[],
  traceId: 'abc',
  model: 'qwen',
};

test('judgeTurn: the verdict is remembered before its first send and removed when delivered', async () => {
  const store = memStore();
  const queue = new VerdictQueue(store);
  const seen: number[] = [];

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/chat/completions')) {
      return sseResponse(JSON.stringify({ choices: [{ delta: { content: VERDICT } }] }));
    }
    if (u.endsWith('/scores')) {
      // The verdict must already be on disk while the send is in flight.
      seen.push(queue.size);
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected ${u}`);
  }) as unknown as typeof fetch;

  await judgeTurn(turn, {
    cfg: { baseUrl: 'http://llm.test/v1', model: 'qwen', apiKey: '' },
    root: process.cwd(),
    limits: DEFAULT_LIMITS,
    settings: SETTINGS,
    queue,
    sleepImpl: async () => {},
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0], 1, 'the verdict is stored before the send starts');
  assert.equal(queue.size, 0, 'and it is gone once the store has it');
});

test('judgeTurn: a verdict whose sends never land stays in the queue for the next activation', async () => {
  const store = memStore();
  const queue = new VerdictQueue(store);
  const posts: string[] = [];

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/chat/completions')) {
      return sseResponse(JSON.stringify({ choices: [{ delta: { content: VERDICT } }] }));
    }
    if (u.endsWith('/scores')) {
      posts.push(String(init?.body));
      // The store is down for the whole session.
      return new Response('down', { status: 503 });
    }
    throw new Error(`unexpected ${u}`);
  }) as unknown as typeof fetch;

  await judgeTurn(turn, {
    cfg: { baseUrl: 'http://llm.test/v1', model: 'qwen', apiKey: '' },
    root: process.cwd(),
    limits: DEFAULT_LIMITS,
    settings: SETTINGS,
    queue,
    sleepImpl: async () => {},
  });

  // The live path spent its retries and gave up for this session...
  assert.equal(posts.length, 3);
  // ...but the verdict is on disk, with the live path's attempts
  // counted, and it is the exact body that was posted.
  assert.equal(queue.size, 1);
  const pending = queue.list()[0]!;
  assert.equal(pending.traceId, 'abc');
  assert.equal(pending.body, posts[0]!);
  assert.equal(pending.attempts, 3);
});

test('a reloaded extension delivers the stored verdict: the reload survival', async () => {
  const store = memStore();
  const first = new VerdictQueue(store);
  first.add({
    traceId: 'abc',
    body: '{"traceId":"abc","scores":[{"name":"score","value":0.7,"source":"daisy-judge"}]}',
    enqueuedAt: Date.now() - 10_000,
    attempts: 1,
    lastAttemptAt: null,
  });

  // The process died. A new activation builds a new queue on the same store
  // and flushes.
  const next = new VerdictQueue(store);
  const posts: unknown[] = [];
  const r = await next.flush(
    {
      endpoint: 'http://store.test/v1',
      headers: { 'x-api-key': 'k' },
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        posts.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
      sleepImpl: async () => {},
    },
    Date.now(),
  );

  assert.deepEqual(r.delivered, ['abc']);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], {
    traceId: 'abc',
    scores: [{ name: 'score', value: 0.7, source: 'daisy-judge' }],
  });
  assert.equal(next.size, 0);
});

test('resolveJudge: the queue is orthogonal to judging being off', () => {
  assert.equal(resolveJudge({ ...SETTINGS, enabled: false }).enabled, false);
  assert.equal(resolveJudge({ ...SETTINGS }).enabled, true);
});
