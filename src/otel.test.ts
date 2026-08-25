import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DAISY_VERSION,
  type OtelConfig,
  OtelClient,
  TurnTrace,
  parseHeaders,
  resolveOtel,
  resourceFor,
  sanitizeName,
  spanId,
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

const RESOURCE = { 'service.name': 'daisy', 'vendor.dataset': 'daisy-proj' };

const SETTINGS = {
  enabled: true,
  endpoint: 'https://collector.example',
  headers: { 'x-api-key': 'secret' },
  serviceName: 'daisy',
  resourceAttributes: { 'vendor.dataset': 'daisy-{workspace}' },
  maxAttrBytes: 32768,
};

test('takes the endpoint and headers from settings', () => {
  const cfg = resolveOtel(SETTINGS);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.endpoint, 'https://collector.example');
  assert.deepEqual(cfg.headers, { 'x-api-key': 'secret' });
});

test('stays off without an endpoint, even when enabled', () => {
  assert.equal(resolveOtel({ ...SETTINGS, endpoint: '  ' }).enabled, false);
});

test('trims a trailing slash off the endpoint', () => {
  assert.equal(resolveOtel({ ...SETTINGS, endpoint: 'https://c.example//' }).endpoint, 'https://c.example');
});

test('falls back to the standard OTLP environment variables', () => {
  const saved = {
    endpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
    headers: process.env['OTEL_EXPORTER_OTLP_HEADERS'],
  };
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'https://from-env.example';
  process.env['OTEL_EXPORTER_OTLP_HEADERS'] = 'authorization=Bearer t,x-scope=team';

  try {
    const cfg = resolveOtel({ ...SETTINGS, endpoint: '', headers: {} });
    assert.equal(cfg.endpoint, 'https://from-env.example');
    assert.deepEqual(cfg.headers, { authorization: 'Bearer t', 'x-scope': 'team' });
  } finally {
    for (const [key, value] of [
      ['OTEL_EXPORTER_OTLP_ENDPOINT', saved.endpoint],
      ['OTEL_EXPORTER_OTLP_HEADERS', saved.headers],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('parses header lists and skips malformed pairs', () => {
  assert.deepEqual(parseHeaders('a=1, b = two ,,=x,c='), { a: '1', b: 'two' });
  assert.deepEqual(parseHeaders(''), {});
});

test('keeps a value containing = intact', () => {
  assert.deepEqual(parseHeaders('authorization=Basic dXNlcjpwYXNz=='), {
    authorization: 'Basic dXNlcjpwYXNz==',
  });
});

test('sanitizes names and falls back when nothing valid remains', () => {
  assert.equal(sanitizeName('my repo!'), 'my-repo-');
  assert.equal(sanitizeName('a'.repeat(120)).length, 80);
  assert.equal(sanitizeName('???'), 'daisy');
});

test('substitutes the workspace into resource attributes', () => {
  const cfg = resolveOtel(SETTINGS);

  assert.deepEqual(resourceFor(cfg, 'c:/work/my-proj'), {
    'service.name': 'daisy',
    'service.version': DAISY_VERSION,
    'vendor.dataset': 'daisy-my-proj',
  });
  assert.equal(resourceFor(cfg, 'c:/work/a b')['vendor.dataset'], 'daisy-a-b');
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
  const body = oneLlmTrace().body(RESOURCE) as OtlpBody;

  const tags = Object.fromEntries(
    (body.resourceSpans[0]?.resource.attributes ?? []).map((a) => [a.key, a.value.stringValue ?? '']),
  );
  assert.equal(tags['vendor.dataset'], 'daisy-proj');
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
  assert.notEqual(trace.body(RESOURCE), null);
  assert.equal(trace.body(RESOURCE), null);
});

function spansOf(trace: TurnTrace, resource: Record<string, string> = RESOURCE): OtlpSpan[] {
  const body = trace.body(resource) as OtlpBody;
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

  const attrs = spansOf(trace).at(-1)?.attributes ?? [];
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

  const toolSpan = spansOf(trace).at(-1);
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

test('sends the batch to /v1/traces with the configured headers', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const c = client(
    mockFetch(async (url, init) => {
      seen.push({ url, init });
      return new Response('{}', { status: 202 });
    }),
    { current: true },
  );

  c.submit(oneLlmTrace().body(RESOURCE));
  await tick();

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, 'https://collector.example/v1/traces');

  const headers = seen[0]?.init.headers as Record<string, string> | undefined;
  assert.equal(headers?.['x-api-key'], 'secret');
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

  c.submit(oneLlmTrace().body(RESOURCE));
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

  c.submit(oneLlmTrace().body(RESOURCE));
  await tick();
  assert.equal(c.pending, 1, '5xx is kept for retry');

  status = 202;
  await c.flush();
  assert.equal(c.pending, 0, 'the retry lands once the gate is healthy');

  status = 401;
  c.submit(oneLlmTrace().body(RESOURCE));
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
  trace.body(RESOURCE);
  c.submit(trace.body(RESOURCE)); // the second call yields null
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

  const body = oneLlmTrace().body(RESOURCE) as OtlpBody;
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
