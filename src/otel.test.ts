import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GATE_URL,
  OtelClient,
  TurnTrace,
  datasetFor,
  resolveOtel,
  sanitizeDataset,
  spanId,
  type OtelConfig,
} from './otel.ts';

/** The OTLP/HTTP JSON export request `TurnTrace.body()` produces. */
interface OtlpAttrValue {
  stringValue?: string;
  intValue?: string;
  boolValue?: boolean;
  doubleValue?: number;
}

interface OtlpAttr {
  key: string;
  value: OtlpAttrValue;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttr[];
  events: { name: string; time: string; attributes: OtlpAttr[] }[];
  status: { code: number };
}

interface OtlpBody {
  resourceSpans: {
    resource: { attributes: OtlpAttr[] };
    scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[];
  }[];
}

const SETTINGS = {
  enabled: true,
  apiKey: 'zp_test',
  baseUrl: 'https://gate.example',
  dataset: 'daisy',
  maxAttrBytes: 32768,
};

test('resolves the key from settings and trims it', () => {
  const cfg = resolveOtel(SETTINGS);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.apiKey, 'zp_test');
  assert.equal(cfg.baseUrl, 'https://gate.example');
  assert.equal(cfg.dataset, 'daisy');
});

test('stays off without a key, even when enabled', () => {
  assert.equal(resolveOtel({ ...SETTINGS, apiKey: '  ' }).enabled, false);
});

test('falls back to ZEROPROOF_API_KEY', () => {
  const saved = process.env['ZEROPROOF_API_KEY'];
  process.env['ZEROPROOF_API_KEY'] = 'zp_from_env';
  try {
    assert.equal(resolveOtel({ ...SETTINGS, apiKey: '' }).apiKey, 'zp_from_env');
  } finally {
    if (saved === undefined) delete process.env['ZEROPROOF_API_KEY'];
    else process.env['ZEROPROOF_API_KEY'] = saved;
  }
});

test('uses the gate URL when no base URL is set', () => {
  assert.equal(resolveOtel({ ...SETTINGS, baseUrl: '   ' }).baseUrl, GATE_URL);
});

test('sanitizes dataset names and falls back when nothing valid remains', () => {
  assert.equal(sanitizeDataset('my repo!'), 'my-repo-');
  assert.equal(sanitizeDataset('a'.repeat(120)).length, 80);
  assert.equal(sanitizeDataset('???'), 'daisy');
});

test('keys the dataset by account workspace so rollouts stay attributable', () => {
  const cfg = resolveOtel(SETTINGS);
  assert.equal(datasetFor(cfg, 'c:/work/my-proj'), 'daisy-my-proj');
  assert.equal(datasetFor(cfg, 'c:/work/a b'), 'daisy-a-b');
});

function oneLlmTrace(): TurnTrace {
  const trace = new TurnTrace('chat-1:1', 'fix the login bug', 32768);
  // After the root span's start, so the spans nest in time.
  const t0 = Date.now();
  trace.llm(spanId(), {
    model: 'qwen3.8-27b',
    startedMs: t0,
    durationMs: 500,
    inputMessages: [
      { role: 'system', content: 'you are daisy' },
      { role: 'user', content: 'fix the login bug' },
    ],
    outputText: 'on it',
    toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path":"src/login.ts"}' }],
    usage: { inputTokens: 12, outputTokens: 3 },
    status: 'ok',
  });
  trace.tool(spanId(), {
    name: 'read_file',
    startedMs: t0 + 500,
    durationMs: 5,
    args: '{"path":"src/login.ts"}',
    output: 'const x = 1;',
    failed: false,
  });
  return trace;
}

test('builds one trace per turn: agent root, llm, and tool spans', () => {
  const body = oneLlmTrace().body('daisy-proj') as OtlpBody;

  const tags = Object.fromEntries(
    (body.resourceSpans[0]?.resource.attributes ?? []).map((a) => [a.key, a.value.stringValue ?? '']),
  );
  assert.equal(tags['zeroproof.dataset'], 'daisy-proj');
  assert.equal(tags['service.name'], 'daisy');

  const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
  assert.equal(spans.length, 3);

  const root = spans[0];
  const llm = spans[1];
  const tool = spans[2];
  assert.ok(root);
  assert.ok(llm);
  assert.ok(tool);
  assert.equal(root.name, 'invoke_agent daisy');
  assert.equal(llm.name, 'chat qwen3.8-27b');
  assert.equal(tool.name, 'execute_tool read_file');

  // Children point at the root; the root has no parent.
  assert.equal(llm.parentSpanId, root.spanId);
  assert.equal(tool.parentSpanId, root.spanId);
  assert.equal(root.parentSpanId, '');

  // Timestamps are UTC nanosecond strings.
  for (const s of spans) {
    assert.match(s.startTimeUnixNano, /^\d{19}$/);
    assert.match(s.endTimeUnixNano, /^\d{19}$/);
  }
});

test('the body is only produced once', () => {
  const trace = oneLlmTrace();
  assert.notEqual(trace.body('daisy-proj'), null);
  assert.equal(trace.body('daisy-proj'), null);
});

function spansOf(trace: TurnTrace, dataset: string): OtlpSpan[] {
  const body = trace.body(dataset) as OtlpBody;
  return body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
}

test('clips oversized attribute values to the byte budget', () => {
  const trace = new TurnTrace('c:1', 'hi', 1024);
  trace.tool(spanId(), {
    name: 'run_command',
    startedMs: 0,
    durationMs: 1,
    args: '{}',
    output: 'x'.repeat(5000),
    failed: false,
  });

  const attrs = spansOf(trace, 'daisy-proj').at(-1)?.attributes ?? [];
  const result = attrs.find((a) => a.key === 'gen_ai.tool.call.result');
  const clipped = result?.value.stringValue ?? '';
  assert.ok(clipped.endsWith('[truncated]'));
  assert.ok(Buffer.byteLength(clipped) <= 1024);
  assert.ok(clipped.length < 5000);
});

test('a failed tool is recorded with an exception event', () => {
  const trace = new TurnTrace('c:1', 'hi', 32768);
  trace.tool(spanId(), {
    name: 'run_command',
    startedMs: 0,
    durationMs: 1,
    args: '{}',
    output: 'nope',
    failed: true,
  });

  const toolSpan = spansOf(trace, 'daisy-proj').at(-1);
  assert.equal(toolSpan?.status.code, 2);
  assert.equal(toolSpan?.events[0]?.name, 'exception');
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return (async (input: unknown, init?: RequestInit) =>
    handler(String(input), init ?? {})) as unknown as typeof fetch;
}

function client(
  fetchImpl: typeof fetch,
  enabled: { current: boolean },
  overrides: Partial<OtelConfig> = {},
): OtelClient {
  return new OtelClient({
    config: { ...resolveOtel(SETTINGS), ...overrides },
    shouldSend: () => enabled.current,
    fetchImpl,
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test('sends the batch to /v1/traces with the zp key', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const c = client(
    mockFetch(async (url, init) => {
      seen.push({ url, init });
      return new Response('{}', { status: 202 });
    }),
    { current: true },
  );

  c.submit(oneLlmTrace().body('daisy-proj'));
  await tick();

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, 'https://gate.example/v1/traces');

  const headers = seen[0]?.init.headers as Record<string, string> | undefined;
  assert.equal(headers?.['x-api-key'], 'zp_test');
  assert.equal(headers?.['content-type'], 'application/json');

  const body = JSON.parse(String(seen[0]?.init.body)) as { resourceSpans: unknown[] };
  assert.ok(Array.isArray(body.resourceSpans));
  await c.shutdown();
});

test('does not send when telemetry is turned off', async () => {
  let calls = 0;
  const c = client(
    mockFetch(async () => {
      calls += 1;
      return new Response('{}', { status: 202 });
    }),
    { current: false },
  );

  c.submit(oneLlmTrace().body('daisy-proj'));
  await tick();
  assert.equal(calls, 0);
  assert.equal(c.pending, 0);
  await c.shutdown();
});

test('retries 5xx on the next flush and drops permanent 4xx', async () => {
  let status = 503;
  const c = client(
    mockFetch(async () => new Response('boom', { status })),
    { current: true },
  );

  c.submit(oneLlmTrace().body('daisy-proj'));
  await tick();
  assert.equal(c.pending, 1, '5xx is kept for retry');

  status = 202;
  await c.flush();
  assert.equal(c.pending, 0, 'the retry lands once the gate is healthy');

  status = 401;
  c.submit(oneLlmTrace().body('daisy-proj'));
  await tick();
  assert.equal(c.pending, 0, 'a bad key is not retried forever');
  await c.shutdown();
});

test('ignores null bodies', async () => {
  let calls = 0;
  const c = client(
    mockFetch(async () => {
      calls += 1;
      return new Response('{}', { status: 202 });
    }),
    { current: true },
  );

  const trace = oneLlmTrace();
  trace.body('daisy-proj');
  c.submit(trace.body('daisy-proj')); // the second call yields null
  await tick();
  assert.equal(calls, 0);
  await c.shutdown();
});

// ---------------------------------------------------------------------------
// Round trip through the real gate parser, when this checkout sits next to
// the zeroproof repo. Skipped on a standalone daisy clone.
// ---------------------------------------------------------------------------

// argv[1] is this file when node --test runs it; import.meta is off-limits under the CJS tsconfig.
const gatePath = path.join(path.dirname(process.argv[1] ?? '.'), '..', '..', 'zeroproof', 'backend', 'lambda', 'token-gate', 'ingest.js');
// The gate parser loads the AWS SDK from its own node_modules; skip on a bare checkout.
const roundTrip =
  existsSync(gatePath) && existsSync(path.join(path.dirname(gatePath), 'node_modules')) ? test : test.skip;

roundTrip('a turn body flattens to one rollout row in the gate parser', async () => {
  const mod = (await import(pathToFileURL(gatePath).href)) as {
    extractRows?: (resourceSpans: unknown) => Record<string, unknown>[];
    default?: { extractRows?: (resourceSpans: unknown) => Record<string, unknown>[] };
  };
  const extractRows = mod.extractRows ?? mod.default?.extractRows;
  if (typeof extractRows !== 'function') throw new Error('gate parser import failed');

  const body = oneLlmTrace().body('daisy-proj') as OtlpBody;
  const rows = extractRows(body.resourceSpans);

  assert.equal(rows.length, 1);
  const row = rows[0] as Record<string, unknown>;
  assert.equal(row['prompt'], 'fix the login bug');
  assert.equal(row['final_text'], 'on it');
  assert.equal(row['scenario_id'], 'chat-1:1');
  const info = row['info'] as Record<string, unknown>;
  assert.equal(info['model'], 'qwen3.8-27b');
  assert.equal(info['input_tokens'], 12);
  assert.equal(info['output_tokens'], 3);
  assert.deepEqual(row['tool_trace'], [
    { tool: 'read_file', input: '{"path":"src/login.ts"}', output: 'const x = 1;' },
  ]);
});
