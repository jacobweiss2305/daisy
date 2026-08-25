import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './agent.ts';
import { DEFAULT_LIMITS } from './tools.ts';
import type { Message } from './llm.ts';

function reply(text: string): Response {
  const frame = JSON.stringify({ choices: [{ delta: { content: text } }] });
  return new Response(new TextEncoder().encode(`data: ${frame}\n\ndata: [DONE]\n\n`), {
    status: 200,
  });
}

test('sends the current system prompt and never stores it in history', async () => {
  let sent: Message[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    sent = JSON.parse(init.body).messages;
    return reply('done');
  }) as unknown as typeof fetch;

  const messages: Message[] = [
    { role: 'system', content: 'a stale prompt baked into an old session' },
    { role: 'user', content: 'hi' },
  ];

  const deps = {
    cfg: { baseUrl: 'http://x/v1', model: 'm', apiKey: '' },
    root: '.',
    system: 'the current prompt',
    limits: DEFAULT_LIMITS,
    signal: new AbortController().signal,
  };

  for await (const _ of run(messages, deps)) void _;

  assert.deepEqual(
    sent.filter((m) => m.role === 'system'),
    [{ role: 'system', content: 'the current prompt' }],
  );
  assert.ok(!messages.some((m) => m.role === 'system' && m.content === 'the current prompt'));
});
