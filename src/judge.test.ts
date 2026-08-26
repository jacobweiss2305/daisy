import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { judgeTurn, parseVerdict, resolveJudge, scoresBody, transcript, type JudgeSettings } from './judge.ts';
import { DEFAULT_LIMITS } from './tools.ts';
import type { Message } from './llm.ts';

const SETTINGS: JudgeSettings = {
  enabled: true,
  endpoint: 'http://store.test/v1',
  headers: { 'x-api-key': 'k' },
  systemPrompt: '',
  maxLoops: 3,
  maxTranscriptBytes: 8192,
  source: 'daisy-judge',
  delayMs: 0,
};

const TOOL_FRAME = JSON.stringify({
  choices: [
    {
      delta: {
        tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
      },
    },
  ],
});

function textFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

function sseResponse(...frames: string[]): Response {
  const payload = frames.map((f) => `data: ${f}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
  return new Response(new TextEncoder().encode(payload), { status: 200 });
}

function scratchRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'daisy-judge-'));
  writeFileSync(path.join(root, 'a.txt'), 'const x = 1;\n');
  return root;
}

test('resolveJudge: needs an endpoint; the env vars fill the gaps', () => {
  assert.equal(resolveJudge({ ...SETTINGS, endpoint: '  ' }).enabled, false);

  process.env.DAISY_JUDGE_ENDPOINT = 'http://env.test/v1';
  process.env.DAISY_JUDGE_HEADERS = 'x-api-key=from-env';
  try {
    const fromEnv = resolveJudge({ ...SETTINGS, endpoint: '', headers: {} });
    assert.equal(fromEnv.enabled, true);
    assert.equal(fromEnv.endpoint, 'http://env.test/v1');
    assert.deepEqual(fromEnv.headers, { 'x-api-key': 'from-env' });
    assert.equal(fromEnv.systemPrompt.length > 0, true);
  } finally {
    delete process.env.DAISY_JUDGE_ENDPOINT;
    delete process.env.DAISY_JUDGE_HEADERS;
  }
});

test('parseVerdict: bare json, json in prose, and nothing', () => {
  const bare = parseVerdict('{"score": 0.5, "pass_at": 0.7, "summary": "ok", "issues": ["x"]}');
  assert.equal(bare.score, 0.5);
  assert.equal(bare.passAt, 0.7);
  assert.equal(bare.summary, 'ok');
  assert.deepEqual(bare.issues, ['x']);

  const prose = parseVerdict('Looking good overall.\n\n```json\n{"score": 0.9, "issues": []}\n```');
  assert.equal(prose.score, 0.9);

  const bad = parseVerdict('I think it is fine.');
  assert.equal(bad.score, null);
  assert.equal(bad.raw, 'I think it is fine.');
  assert.equal(bad.parsed, false);

  // Prose that happens to contain braces is not a verdict.
  const curly = parseVerdict('edited the file at {index 5}, done.');
  assert.equal(curly.parsed, false);
});

test('scoresBody: named measurements against the trace id, null when empty', () => {
  const v = parseVerdict('{"score": 0.4, "pass_at": 0.7, "summary": "meh", "issues": ["a", "b"]}');
  assert.deepEqual(scoresBody('t1', v, 'j'), {
    traceId: 't1',
    scores: [
      { name: 'score', value: 0.4, pass_at: 0.7, source: 'j' },
      { name: 'summary', label: 'meh', source: 'j' },
      { name: 'issue.1', label: 'a', source: 'j' },
      { name: 'issue.2', label: 'b', source: 'j' },
    ],
  });
  assert.equal(scoresBody('t1', parseVerdict('no json here'), 'j'), null);
});

test('transcript: user request plus the turn, clipped to the budget', () => {
  const turn = {
    chatId: 'c',
    turnNumber: 1,
    userText: 'do it',
    model: 'm',
    traceId: 't',
    messages: [
      {
        role: 'assistant',
        content: 'working',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"command":"ls"}' } }],
      },
      { role: 'tool', content: 'x', tool_call_id: 'c1' },
      { role: 'assistant', content: 'done' },
    ] as Message[],
  };
  const t = transcript(turn, 8192);
  assert.ok(t.includes('User request:'));
  assert.ok(t.includes('do it'));
  assert.ok(t.includes('[call] run_command'));
  assert.ok(t.includes('[result run_command] x'));
  assert.ok(t.includes('[assistant] done'));

  const big = transcript({ ...turn, userText: 'a'.repeat(20000) }, 1024);
  assert.ok(Buffer.byteLength(big) <= 1024 + 32);
  assert.ok(big.endsWith('[truncated]'));
});

test('judgeTurn: reviews the turn with tools and posts the verdict against the turn trace id', async () => {
  const root = scratchRoot();
  const verdict = '{"score": 0.8, "pass_at": 0.7, "summary": "did the thing", "issues": []}';

  const llmCalls: string[] = [];
  const scoresPosts: { headers: Record<string, string>; body: unknown }[] = [];
  let scoresTries = 0;
  const sleeps: number[] = [];

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/chat/completions')) {
      llmCalls.push(String(init?.body));
      return sseResponse(llmCalls.length === 1 ? TOOL_FRAME : textFrame(verdict));
    }
    if (u.endsWith('/scores')) {
      scoresTries += 1;
      scoresPosts.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return scoresTries === 1
        ? new Response(JSON.stringify({ applied: [], unknown: ['abc'] }), { status: 207 })
        : new Response(JSON.stringify({ applied: [{ traceId: 'abc', names: ['score'] }] }), { status: 200 });
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;

  const turn = {
    chatId: 'chat1',
    turnNumber: 2,
    userText: 'fix a.txt',
    messages: [
      {
        role: 'assistant',
        content: 'Reading it.',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
      },
      { role: 'tool', content: 'const x = 1;', tool_call_id: 'c1' },
      { role: 'assistant', content: 'Done.' },
    ] as Message[],
    traceId: 'abc',
    model: 'qwen',
  };

  const out = await judgeTurn(turn, {
    cfg: { baseUrl: 'http://llm.test/v1', model: 'qwen', apiKey: '' },
    root,
    limits: DEFAULT_LIMITS,
    settings: SETTINGS,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(out?.score, 0.8);
  assert.equal(llmCalls.length, 2);
  assert.ok(llmCalls[0]!.includes('User request:'));
  assert.ok(llmCalls[0]!.includes('fix a.txt'));
  assert.ok(llmCalls[0]!.includes('[result read_file]'));
  assert.equal(scoresTries, 2);
  assert.deepEqual(sleeps, [0, 3000]);
  assert.deepEqual(scoresPosts[0]!.body, {
    traceId: 'abc',
    scores: [
      { name: 'score', value: 0.8, pass_at: 0.7, source: 'daisy-judge' },
      { name: 'summary', label: 'did the thing', source: 'daisy-judge' },
    ],
  });
  assert.equal(scoresPosts[0]!.headers['x-api-key'], 'k');
});

test('judgeTurn: an unparseable verdict is filed as judge.raw instead of dropped', async () => {
  const root = scratchRoot();
  const posted: { status: number; body: unknown }[] = [];

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/chat/completions')) return sseResponse(textFrame('It looks fine to me, but I will not emit JSON.'));
    if (u.endsWith('/scores')) {
      posted.push({ status: 200, body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;

  const turn = {
    chatId: 'c',
    turnNumber: 1,
    userText: 'do it',
    messages: [{ role: 'assistant', content: 'ok' }] as Message[],
    traceId: 'abc',
    model: 'qwen',
  };

  const out = await judgeTurn(turn, {
    cfg: { baseUrl: 'http://llm.test/v1', model: 'qwen', apiKey: '' },
    root,
    limits: DEFAULT_LIMITS,
    settings: SETTINGS,
    sleepImpl: async () => {},
  });

  assert.equal(out?.parsed, false);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0]!.body, {
    traceId: 'abc',
    scores: [
      { name: 'judge.raw', label: 'It looks fine to me, but I will not emit JSON.', source: 'daisy-judge' },
    ],
  });
});

test('judgeTurn: a judge whose model call fails is filed as judge.raw too', async () => {
  const root = scratchRoot();
  const posted: unknown[] = [];

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/chat/completions')) return new Response('503 Service Unavailable', { status: 503 });
    if (u.endsWith('/scores')) {
      posted.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;

  const turn = {
    chatId: 'c',
    turnNumber: 1,
    userText: 'do it',
    messages: [{ role: 'assistant', content: 'ok' }] as Message[],
    traceId: 'abc',
    model: 'qwen',
  };

  const out = await judgeTurn(turn, {
    cfg: { baseUrl: 'http://llm.test/v1', model: 'qwen', apiKey: '' },
    root,
    limits: DEFAULT_LIMITS,
    settings: { ...SETTINGS, maxLoops: 1, delayMs: 0 },
    sleepImpl: async () => {},
  });

  assert.equal(out?.parsed, false);
  assert.equal(posted.length, 1);
  const body = posted[0] as { scores: { name: string; label: string }[] };
  assert.equal(body.scores[0]!.name, 'judge.raw');
  assert.ok(body.scores[0]!.label.startsWith('judge failed:'));
});

test('judgeTurn: maxLoops forces a final answer even for a looping judge', async () => {
  const root = scratchRoot();
  const llmCalls: string[] = [];

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/chat/completions')) {
      llmCalls.push(String(init?.body));
      // A judge that never stops calling tools: it keeps answering with one.
      return sseResponse(TOOL_FRAME);
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  const turn = {
    chatId: 'chat1',
    turnNumber: 1,
    userText: 'do it',
    messages: [{ role: 'assistant', content: 'ok' }] as Message[],
    traceId: 'abc',
    model: 'qwen',
  };

  await judgeTurn(turn, {
    cfg: { baseUrl: 'http://llm.test/v1', model: 'qwen', apiKey: '' },
    root,
    limits: DEFAULT_LIMITS,
    settings: { ...SETTINGS, maxLoops: 2 },
    sleepImpl: async () => {},
  });

  // Two tool rounds, then one forced final call with no tools on offer.
  assert.equal(llmCalls.length, 3);
  assert.ok(llmCalls[0]!.includes('"tools"'));
  assert.ok(!llmCalls[2]!.includes('"tools"'));
});