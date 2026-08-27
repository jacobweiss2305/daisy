import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { LlmObservation, ToolObservation } from './agent.ts';
import { TurnMetrics, type Outcome } from './metrics.ts';

/**
 * Optional turn telemetry over OTLP/HTTP JSON.
 *
 * When `daisy.telemetry.enabled` and an endpoint is set, each chat turn is
 * recorded as one trace: an agent root span with the prompt and final answer,
 * a `chat` span per model call, and an `execute_tool` span per tool with its
 * arguments and output. Where it goes, what headers it carries, and what
 * resource attributes it declares are all configuration, so any OTLP collector
 * or hosted backend works.
 *
 * This plugin is public, so nothing leaves the machine unless the user opts in:
 * the endpoint and credentials come from the user's own settings or the
 * standard OTEL_* variables, attribute values are clipped, and undelivered
 * batches wait in a small in-memory outbox rather than being retried forever.
 *
 * JSON rather than protobuf, built by hand: it is the encoding every collector
 * accepts, and it is all the SDK would add here.
 */

export const DAISY_VERSION = '0.1.0'; // keep in sync with package.json

export interface OtelSettings {
  enabled: boolean;
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
  resourceAttributes: Record<string, string>;
  maxAttrBytes: number;
}

export type OtelConfig = OtelSettings;

/**
 * Settings win; otherwise the standard OTLP environment variables do, so an
 * existing collector setup needs no extra configuration here.
 */
export function resolveOtel(s: OtelSettings): OtelConfig {
  // The signal-specific variable is sent as written; the generic one is a base
  // the exporter appends /v1/traces to. Same split as the OTel SDKs, so an
  // existing collector setup needs no translation here.
  const generic = env('OTEL_EXPORTER_OTLP_ENDPOINT');
  const endpoint = (
    s.endpoint.trim() ||
    env('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') ||
    (generic ? `${generic}/v1/traces` : '')
  ).replace(/\/+$/, '');
  const headers = Object.keys(s.headers).length
    ? s.headers
    : parseHeaders(env('OTEL_EXPORTER_OTLP_HEADERS'));
  const resourceAttributes = Object.keys(s.resourceAttributes).length
    ? s.resourceAttributes
    : parseHeaders(env('OTEL_RESOURCE_ATTRIBUTES'));

  return {
    enabled: s.enabled && endpoint.length > 0,
    endpoint,
    headers,
    serviceName: s.serviceName.trim() || 'daisy',
    resourceAttributes,
    maxAttrBytes: s.maxAttrBytes,
  };
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

/** The OTLP spec's `key=value,key2=value2` list, as used by the OTEL_* variables. */
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const pair of raw.split(',')) {
    const at = pair.indexOf('=');
    if (at < 1) continue;

    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (key && value) out[key] = value;
  }

  return out;
}

export function sanitizeName(name: string): string {
  const clean = name.replace(/[^\w.-]/g, '-').slice(0, 80);
  return /\w/.test(clean) ? clean : 'daisy';
}

/**
 * Resource attributes for one workspace. A `{workspace}` placeholder in any
 * value becomes the folder name, which is how a backend that groups by dataset
 * gets one per repo without this file knowing what a dataset is.
 */
export function resourceFor(
  config: OtelConfig,
  workspaceRoot: string,
  agent = 'daisy',
): Record<string, string> {
  const workspace = sanitizeName(path.basename(workspaceRoot) || 'workspace');
  const out: Record<string, string> = {
    'service.name': config.serviceName,
    'service.version': DAISY_VERSION,
  };

  for (const [key, value] of Object.entries(config.resourceAttributes)) {
    out[key] = value.replaceAll('{workspace}', workspace).replaceAll('{agent}', sanitizeName(agent));
  }

  return out;
}

export function spanId(): string {
  return hex(8);
}

/**
 * The agent loop's observations as spans on a trace. Every agent run records
 * the same way, so the loop's caller passes this rather than restating it.
 */
export function recordOn(
  trace: TurnTrace | null,
): (e: { kind: 'llm'; observation: LlmObservation } | { kind: 'tool'; observation: ToolObservation }) => void {
  return (e) => {
    if (!trace) return;
    if (e.kind === 'llm') trace.llm(spanId(), e.observation);
    else trace.tool(spanId(), e.observation);
  };
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function epochNano(epochMs: number): string {
  return (BigInt(Math.trunc(epochMs)) * 1_000_000n).toString();
}

/** Attribute values in the OTLP AnyValue shape. */
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
export interface TurnTraceInit {
  turnId: string;
  inputText: string;
  maxAttr: number;
  sessionId?: string | undefined;
  /** Which agent ran. The judge is a second agent, and its trace says so. */
  agent?: string | undefined;
  /** Extra root-span attributes, such as the trace this run reviews. */
  attributes?: Record<string, string> | undefined;
}

export class TurnTrace {
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly agent: string;

  private readonly turnId: string;
  private readonly sessionId: string;
  private readonly inputText: string;
  private readonly maxAttr: number;
  private readonly attributes: Record<string, string>;
  private readonly startedMs: number;
  private readonly spans: OtlpSpan[] = [];
  /** Folded as observations arrive, so a long turn costs no more than a short one. */
  private readonly metrics = new TurnMetrics();
  /**
   * How many spans have already gone out. A span must never travel twice: the
   * store hashes a batch to dedupe an exporter's retry, so the same span in two
   * different batches is two parts, and the per-batch sums count it twice.
   */
  private sent = 0;
  private finalText = '';
  private closed = false;

  constructor(init: TurnTraceInit) {
    this.traceId = hex(16);
    this.rootSpanId = spanId();
    this.turnId = init.turnId;
    this.sessionId = init.sessionId ?? '';
    this.inputText = init.inputText;
    this.maxAttr = init.maxAttr;
    this.agent = init.agent ?? 'daisy';
    this.attributes = init.attributes ?? {};
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
    this.metrics.tool(o);
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

  /**
   * The spans that finished since the last call, as their own export request,
   * or null when none have. The root is not among them: it is not over until
   * the turn is. The store infers a stand-in root from a parentless span and
   * lets the batch carrying the real one supersede it, which is what makes
   * sending children first work at all.
   */
  drain(resource: Record<string, string>): unknown {
    if (this.closed || this.sent >= this.spans.length) return null;
    return this.envelope(resource, this.take());
  }

  /**
   * The closing export request for this turn, or null if it has already been
   * produced: the root, plus whatever children have not gone out already.
   *
   * `outcome` is the caller's, because only the caller knows whether the loop
   * ended, threw, or was cancelled: from in here a turn that stopped early and
   * one that finished look the same.
   */
  body(resource: Record<string, string>, outcome: Outcome = 'complete'): unknown {
    if (this.closed) return null;
    this.closed = true;

    // Measurements ride on the root span rather than going out as a second
    // request: they are known the moment the turn ends and need no trace to
    // have landed first, which is the only reason the judge has a queue.
    //
    // The answer goes in because half of what is worth measuring is the gap
    // between what the turn claimed and what it did.
    const measurements = this.metrics.summarize(outcome, this.finalText).flatMap((m) => [
      this.attr(`zeroproof.scores.${m.name}`, m.value),
      this.attr(`zeroproof.describe.${m.name}`, m.description),
    ]);

    // Why each flag fired. Evidence is not a measurement and is capped
    // separately by the store, so the receipts cost no measurement names.
    const evidence = Object.entries(this.metrics.asEvidence()).map(([name, text]) =>
      this.attr(`zeroproof.evidence.${name}`, text),
    );

    const root: OtlpSpan = {
      traceId: this.traceId,
      spanId: this.rootSpanId,
      parentSpanId: '',
      name: `invoke_agent ${this.agent}`,
      kind: 1,
      startTimeUnixNano: epochNano(this.startedMs),
      endTimeUnixNano: epochNano(Date.now()),
      attributes: [
        this.attr('gen_ai.operation.name', 'invoke_agent'),
        this.attr('gen_ai.agent.name', this.agent),
        this.attr('daisy.turn_id', this.turnId),
        ...Object.entries(this.attributes).map(([key, value]) => this.attr(key, value)),
        ...(this.sessionId ? [this.attr('gen_ai.conversation.id', this.sessionId)] : []),
        // Raw text: a backend wraps a non-JSON string itself, so wrapping here double-wraps.
        this.attr('gen_ai.input.messages', this.inputText),
        this.attr('gen_ai.output.messages', JSON.stringify([{ role: 'assistant', content: this.finalText }])),
        ...measurements,
        ...evidence,
      ],
      events: [],
      // A turn that died is an error on the run itself, not only on whichever
      // child span happened to throw. The store counts root status as the run's.
      status: { code: outcome === 'error' ? 2 : 1 },
    };

    return this.envelope(resource, [root, ...this.take()]);
  }

  /** The spans not yet exported, marked as exported. */
  private take(): OtlpSpan[] {
    const next = this.spans.slice(this.sent);
    this.sent = this.spans.length;
    return next;
  }

  private envelope(resource: Record<string, string>, spans: OtlpSpan[]): unknown {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: Object.entries(resource).map(([key, value]) => this.attr(key, value)),
          },
          scopeSpans: [{ scope: { name: 'daisy' }, spans }],
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

/** Message attributes travel as arrays; pass arrays through, decode the rest. */
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

/** Keeps one attribute from growing a batch past whatever the backend accepts. */
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

const BATCH_CAP_BYTES = 8 * 1024 * 1024; // collectors commonly 413 above this
const OUTBOX_MAX = 32; // a streamed turn is many small batches, not one big one
const FLUSH_INTERVAL_MS = 5_000;
const SEND_TIMEOUT_MS = 10_000;

export interface OtelClientDeps {
  config: OtelConfig;
  /** Re-read on every send, so toggling the setting takes effect without a reload. */
  shouldSend: () => boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Fire-and-forget delivery of OTLP export requests to the configured
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
  /** Turns still running, and the workspace each is running in. */
  private readonly live = new Map<TurnTrace, string>();
  private readonly timer: NodeJS.Timeout;

  constructor(deps: OtelClientDeps) {
    this.config = deps.config;
    this.shouldSend = deps.shouldSend;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timer = setInterval(() => {
      this.flushLive();
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  updateConfig(config: OtelConfig): void {
    this.config = config;
  }

  /**
   * A trace for one agent run, sized by the settings as they stand. Null when
   * telemetry is off, so a caller writes `trace?.llm(...)` rather than
   * re-deciding whether to record.
   */
  trace(init: Omit<TurnTraceInit, 'maxAttr'>, workspaceRoot: string): TurnTrace | null {
    if (!this.config.enabled) return null;
    const trace = new TurnTrace({ ...init, maxAttr: this.config.maxAttrBytes });
    this.live.set(trace, workspaceRoot);
    return trace;
  }

  /** Queue a finished trace, resolved against the workspace the run happened in. */
  send(trace: TurnTrace | null, workspaceRoot: string, outcome: Outcome = 'complete'): void {
    if (!trace) return;
    this.live.delete(trace);
    this.submit(trace.body(resourceFor(this.config, workspaceRoot, trace.agent), outcome));
  }

  /**
   * Spans of turns still running. A trace assembles across batches on the
   * store's side, so a turn is watchable while it works instead of appearing
   * whole once it is over.
   */
  flushLive(): void {
    for (const [trace, root] of this.live) {
      this.submit(trace.drain(resourceFor(this.config, root, trace.agent)));
    }
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
    // A turn caught by a reload never gets its root, but the store keeps the
    // stand-in one, so what the agent had done by then is still readable.
    this.flushLive();
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
        const res = await this.fetchImpl(`${this.config.endpoint}/v1/traces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.config.headers },
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

    // Over budget: drop the oldest. A turn now arrives as several batches
    // ending with the one that carries its root, its answer and its
    // measurements, so dropping the newest would throw away the part that
    // makes the rest of them a run.
    let total = this.outbox.reduce((n, p) => n + p.bytes, 0);
    while (total > BATCH_CAP_BYTES && this.outbox.length > 1) {
      const dropped = this.outbox.shift();
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
