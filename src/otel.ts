import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { LlmObservation, ToolObservation } from './agent.ts';

/**
 * Optional rollout telemetry for the Zero Proof token gate.
 *
 * When `daisy.telemetry.enabled`, each chat turn is recorded as one
 * OTLP/HTTP JSON trace in the shape the gate ingests: an agent root span
 * with the prompt and final answer, a `chat` span per model call, and an
 * `execute_tool` span per tool with its arguments and output. The gate
 * flattens each trace into one rollout row per (account, dataset, UTC day),
 * so a day of sessions becomes an analyzable dataset for building training
 * tasks.
 *
 * This plugin is public, so nothing leaves the machine unless the user opts
 * in: the key comes from the user's own settings (or ZEROPROOF_API_KEY),
 * attribute values are clipped, and undelivered batches wait in a small
 * in-memory outbox rather than being retried forever. The gate names each
 * part file after its content, so a resent batch overwrites the identical
 * object instead of double-counting.
 *
 * The gate only accepts OTLP/HTTP JSON (protobuf gets a 415), so the
 * envelope is built by hand — that is all the SDK would add here.
 */

export const GATE_URL = 'https://wch04mgo2k.execute-api.us-east-1.amazonaws.com';

export const DAISY_VERSION = '0.1.0'; // keep in sync with package.json

export interface OtelSettings {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  dataset: string;
  maxAttrBytes: number;
}

export interface OtelConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  dataset: string;
  maxAttrBytes: number;
}

/** The key comes from settings, falling back to ZEROPROOF_API_KEY. */
export function resolveOtel(s: OtelSettings): OtelConfig {
  const apiKey = s.apiKey.trim() || process.env['ZEROPROOF_API_KEY']?.trim() || '';
  return {
    enabled: s.enabled && apiKey.length > 0,
    apiKey,
    baseUrl: (s.baseUrl.trim() || GATE_URL).replace(/\/+$/, ''),
    dataset: sanitizeDataset(s.dataset.trim() || 'daisy'),
    maxAttrBytes: s.maxAttrBytes,
  };
}

/** The gate's rule for dataset names, with a fallback for names that sanitize to nothing. */
export function sanitizeDataset(name: string): string {
  const clean = name.replace(/[^\w.-]/g, '-').slice(0, 80);
  return /\w/.test(clean) ? clean : 'daisy';
}

/** One dataset per (account, workspace), so rollouts stay attributable to a repo. */
export function datasetFor(config: OtelConfig, workspaceRoot: string): string {
  return `${config.dataset}-${sanitizeDataset(path.basename(workspaceRoot) || 'workspace')}`;
}

export function spanId(): string {
  return hex(8);
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function epochNano(epochMs: number): string {
  return (BigInt(Math.trunc(epochMs)) * 1_000_000n).toString();
}

/** Attribute values the gate reads, in the OTLP AnyValue shape. */
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

/**
 * Records the spans of one chat turn and returns the OTLP export request
 * for it from `body()`. The second call returns null, so a turn can be
 * submitted exactly once.
 */
export class TurnTrace {
  readonly traceId: string;
  readonly rootSpanId: string;

  private readonly scenarioId: string;
  private readonly inputText: string;
  private readonly maxAttr: number;
  private readonly startedMs: number;
  private readonly spans: OtlpSpan[] = [];
  private finalText = '';
  private closed = false;

  constructor(scenarioId: string, inputText: string, maxAttr: number) {
    this.traceId = hex(16);
    this.rootSpanId = spanId();
    this.scenarioId = scenarioId;
    this.inputText = inputText;
    this.maxAttr = maxAttr;
    this.startedMs = Date.now();
  }

  llm(spanId: string, o: LlmObservation): void {
    if (this.closed) return;
    // The final answer is the model's last utterance before it stopped calling tools.
    if (o.outputText) this.finalText = o.outputText;

    const output = o.toolCalls.length
      ? [
          {
            role: 'assistant',
            content: o.outputText,
            tool_calls: o.toolCalls.map((c) => ({
              id: c.id,
              function: { name: c.name, arguments: c.args },
            })),
          },
        ]
      : [{ role: 'assistant', content: o.outputText }];

    this.add(
      spanId,
      this.rootSpanId,
      `chat ${o.model}`,
      o.startedMs,
      {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': o.model,
        'gen_ai.provider.name': 'openai-compatible',
        'gen_ai.input.messages': JSON.stringify(asArray(o.inputMessages)),
        'gen_ai.output.messages': JSON.stringify(output),
        ...(o.usage?.inputTokens !== undefined ? { 'gen_ai.usage.input_tokens': o.usage.inputTokens } : {}),
        ...(o.usage?.outputTokens !== undefined ? { 'gen_ai.usage.output_tokens': o.usage.outputTokens } : {}),
      },
      o.durationMs,
      o.status === 'error' ? o.error : undefined,
    );
  }

  tool(spanId: string, o: ToolObservation): void {
    if (this.closed) return;
    this.add(
      spanId,
      this.rootSpanId,
      `execute_tool ${o.name}`,
      o.startedMs,
      {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': o.name,
        'gen_ai.tool.call.arguments': o.args,
        'gen_ai.tool.call.result': o.output,
        'gen_ai.tool.status': o.failed ? 'error' : 'success',
      },
      o.durationMs,
      o.failed ? 'tool failed' : undefined,
    );
  }

  body(dataset: string): unknown {
    if (this.closed) return null;
    this.closed = true;

    const root: OtlpSpan = {
      traceId: this.traceId,
      spanId: this.rootSpanId,
      parentSpanId: '',
      name: 'invoke_agent daisy',
      kind: 1,
      startTimeUnixNano: epochNano(this.startedMs),
      endTimeUnixNano: epochNano(Date.now()),
      attributes: [
        this.attr('gen_ai.operation.name', 'invoke_agent'),
        this.attr('gen_ai.agent.name', 'daisy'),
        this.attr('zeroproof.scenario_id', this.scenarioId),
        // Raw text: the gate wraps a non-JSON string itself, without this it double-wraps.
        this.attr('gen_ai.input.messages', this.inputText),
        this.attr('gen_ai.output.messages', JSON.stringify([{ role: 'assistant', content: this.finalText }])),
      ],
      events: [],
      status: { code: 1 },
    };

    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              this.attr('service.name', 'daisy'),
              this.attr('service.version', DAISY_VERSION),
              this.attr('zeroproof.dataset', dataset),
            ],
          },
          scopeSpans: [{ scope: { name: 'daisy' }, spans: [root, ...this.spans] }],
        },
      ],
    };
  }

  private add(
    spanId: string,
    parentSpanId: string,
    name: string,
    startedMs: number,
    raw: Record<string, unknown>,
    durationMs: number,
    error: string | undefined,
  ): void {
    const endMs = startedMs + durationMs;
    const span: OtlpSpan = {
      traceId: this.traceId,
      spanId,
      parentSpanId,
      name,
      kind: 1,
      startTimeUnixNano: epochNano(startedMs),
      endTimeUnixNano: epochNano(endMs),
      attributes: [],
      events: error
        ? [{ name: 'exception', time: epochNano(endMs), attributes: [this.attr('exception.message', error)] }]
        : [],
      status: { code: error ? 2 : 1 },
    };

    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined) span.attributes.push(this.attr(key, value));
    }
    this.spans.push(span);
  }

  private attr(key: string, value: unknown): OtlpAttr {
    let v: OtlpAttrValue;
    if (typeof value === 'string') v = { stringValue: clip(value, this.maxAttr) };
    else if (typeof value === 'number')
      v = Number.isFinite(value) ? { doubleValue: value } : { stringValue: clip(String(value), this.maxAttr) };
    else if (typeof value === 'boolean') v = { boolValue: value };
    else v = { stringValue: clip(JSON.stringify(value) ?? String(value), this.maxAttr) };
    return { key, value: v };
  }
}

/** The gate reads message attributes as arrays; pass arrays through, decode the rest. */
function asArray(value: unknown): unknown {
  if (Array.isArray(value)) return value;

  if (typeof value !== 'string') return { _raw: JSON.stringify(value) };
  try {
    const v: unknown = JSON.parse(value);
    return Array.isArray(v) ? v : { _raw: value };
  } catch {
    return { _raw: value };
  }
}

/** Keeps one attribute from growing a batch past the gate's 8 MB batch cap. */
function clip(value: string, max: number): string {
  if (Buffer.byteLength(value) <= max) return value;

  const suffix = '\n[truncated]';
  const budget = max - Buffer.byteLength(suffix);
  let out = '';
  let bytes = 0;
  for (const ch of value) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > budget) break;
    out += ch;
    bytes += n;
  }
  return out + suffix;
}

const BATCH_CAP_BYTES = 8 * 1024 * 1024; // the gate 413s above this
const OUTBOX_MAX = 8;
const FLUSH_INTERVAL_MS = 5_000;
const SEND_TIMEOUT_MS = 10_000;

export interface OtelClientDeps {
  config: OtelConfig;
  /** Re-read on every send, so toggling the setting takes effect without a reload. */
  shouldSend: () => boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Fire-and-forget delivery of OTLP export requests to the gate's
 * `/v1/traces`. Batches that cannot be delivered are kept in a bounded
 * in-memory outbox and retried by the next flush; nothing is retried in
 * the background, and a turned-off telemetry drops no data quietly — it
 * simply keeps the outbox.
 */
export class OtelClient {
  private config: OtelConfig;
  private readonly shouldSend: () => boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly outbox: { body: string; bytes: number }[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor(deps: OtelClientDeps) {
    this.config = deps.config;
    this.shouldSend = deps.shouldSend;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  updateConfig(config: OtelConfig): void {
    this.config = config;
  }

  /** Queue one OTLP export request body and try to deliver the outbox. */
  submit(body: unknown): void {
    if (!this.shouldSend() || body === null) return;
    const text = JSON.stringify(body);
    this.enqueue([{ body: text, bytes: Buffer.byteLength(text) }], false);
    void this.flush();
  }

  /** Batches still waiting to be delivered. */
  get pending(): number {
    return this.outbox.length;
  }

  flush(): Promise<number> {
    return this.deliver();
  }

  async shutdown(): Promise<number> {
    clearInterval(this.timer);
    return this.deliver();
  }

  private async deliver(): Promise<number> {
    if (!this.outbox.length || !this.shouldSend()) return 0;

    const queue = this.outbox.splice(0, this.outbox.length);
    let sent = 0;

    for (let i = 0; i < queue.length; i += 1) {
      const part = queue[i];
      if (!part) continue;

      let outcome: 'sent' | 'dropped' | 'retry';
      try {
        const res = await this.fetchImpl(`${this.config.baseUrl}/v1/traces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': this.config.apiKey },
          body: part.body,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        // 4xx is permanent (bad key, too big, wrong encoding); 5xx and 408/429 may pass next time.
        outcome = res.ok ? 'sent' : res.status >= 500 || res.status === 408 || res.status === 429 ? 'retry' : 'dropped';
      } catch {
        outcome = 'retry';
      }

      if (outcome === 'sent') {
        sent += 1;
      } else if (outcome === 'retry') {
        this.enqueue(queue.slice(i), true);
        break;
      }
    }

    return sent;
  }

  private enqueue(entries: { body: string; bytes: number }[], front: boolean): void {
    if (front) this.outbox.unshift(...entries);
    else this.outbox.push(...entries);

    // Over budget: drop the newest first, then the oldest past the count cap.
    let total = this.outbox.reduce((n, p) => n + p.bytes, 0);
    while (total > BATCH_CAP_BYTES && this.outbox.length > 1) {
      const dropped = this.outbox.pop();
      if (!dropped) break;
      total -= dropped.bytes;
    }
    while (this.outbox.length > OUTBOX_MAX) {
      const dropped = this.outbox.shift();
      if (!dropped) break;
      total -= dropped.bytes;
    }
  }
}
