import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listModels, stream, type Chunk, type LlmConfig } from './llm.ts';

const CFG: LlmConfig = { baseUrl: 'http://test/v1', model: 'm', apiKey: '' };

function respond(deltas: unknown[]): void {
  const body = deltas
    .map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`)
    .join('');
  globalThis.fetch = (async () =>
    new Response(new TextEncoder().encode(`${body}data: [DONE]\n\n`))) as typeof fetch;
}

async function collect(deltas: unknown[]): Promise<Chunk[]> {
  respond(deltas);
  const out: Chunk[] = [];
  for await (const c of stream(CFG, [], [], new AbortController().signal)) out.push(c);
  return out;
}

const text = (chunks: Chunk[]): string =>
  chunks.filter((c) => c.kind === 'text').map((c) => c.text).join('');

const thinking = (chunks: Chunk[]): string =>
  chunks.filter((c) => c.kind === 'think').map((c) => c.text).join('');

test('strips reasoning spans split across chunk boundaries', async () => {
  const chunks = await collect([
    { content: 'a<thi' },
    { content: 'nk>hidden</thi' },
    { content: 'nk>b' },
  ]);
  assert.equal(text(chunks), 'ab');
});

test('emits reasoning on its own channel', async () => {
  const chunks = await collect([
    { content: 'a<thi' },
    { content: 'nk>why not</thi' },
    { content: 'nk>b' },
  ]);
  assert.equal(thinking(chunks), 'why not');
  assert.equal(text(chunks), 'ab');
});

test('passes through a reasoning_content field', async () => {
  const chunks = await collect([{ reasoning_content: 'step one' }, { content: 'done' }]);
  assert.equal(thinking(chunks), 'step one');
  assert.equal(text(chunks), 'done');
});

test('keeps an unterminated tag as literal text', async () => {
  assert.equal(text(await collect([{ content: 'compare a <b' }])), 'compare a <b');
});

test('assembles tool call arguments fragmented across deltas', async () => {
  const chunks = await collect([
    { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] },
  ]);
  assert.deepEqual(chunks.at(-1), {
    kind: 'calls',
    calls: [{ id: 'c1', name: 'write_file', args: '{"path":"a.txt"}' }],
  });
});

test('keeps parallel tool calls separate by index', async () => {
  const chunks = await collect([
    {
      tool_calls: [
        { index: 0, id: 'a', function: { name: 'read_file', arguments: '{}' } },
        { index: 1, id: 'b', function: { name: 'list_dir', arguments: '{}' } },
      ],
    },
  ]);
  const last = chunks.at(-1);
  assert.equal(last?.kind === 'calls' && last.calls.length, 2);
});

function serve(routes: Record<string, unknown>): void {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    const body = Object.entries(routes).find(([path]) => url.endsWith(path))?.[1];
    return body === undefined
      ? new Response('nope', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

test('lists models from the OpenAI endpoint', async () => {
  serve({ '/v1/models': { data: [{ id: 'qwen3.8' }, { id: 'llama3.1:8b' }] } });
  assert.deepEqual(await listModels(CFG), ['llama3.1:8b', 'qwen3.8']);
});

test('falls back to the Ollama list when the OpenAI endpoint is empty', async () => {
  serve({
    '/v1/models': { object: 'list', data: null },
    '/api/tags': { models: [{ name: 'llama3.1:8b' }] },
  });
  assert.deepEqual(await listModels(CFG), ['llama3.1:8b']);
});

test('returns nothing when neither endpoint answers', async () => {
  serve({});
  assert.deepEqual(await listModels(CFG), []);
});
