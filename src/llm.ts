export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: WireToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export type Chunk =
  | { kind: 'text'; text: string }
  | { kind: 'think'; text: string }
  | { kind: 'calls'; calls: ToolCall[] };

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface Endpoint {
  name: string;
  baseUrl: string;
  apiKey?: string;
}

export interface ModelRef {
  endpoint: string;
  model: string;
}

export function toWire(call: ToolCall): WireToolCall {
  return { id: call.id, type: 'function', function: { name: call.name, arguments: call.args } };
}

export async function* stream(
  cfg: LlmConfig,
  messages: Message[],
  tools: readonly unknown[],
  signal: AbortSignal,
  opts: StreamOptions = {},
): AsyncGenerator<Chunk> {
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    stream: true,
    ...(tools.length ? { tools } : {}),
  });

  const res = await send(cfg, body, signal, opts);

  if (!res.ok || !res.body) {
    const detail = (await res.text()).slice(0, 300).trim();
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
  }

  const calls: (ToolCall | undefined)[] = [];
  const think = new ThinkFilter();

  for await (const frame of sse(res.body)) {
    const delta = parseDelta(frame);
    if (!delta) continue;

    if (delta.reasoning_content) yield { kind: 'think', text: delta.reasoning_content };

    if (typeof delta.content === 'string') {
      const { visible, thinking } = think.push(delta.content);
      if (thinking) yield { kind: 'think', text: thinking };
      if (visible) yield { kind: 'text', text: visible };
    }

    for (const d of delta.tool_calls ?? []) {
      const at = d.index ?? 0;
      let call = calls[at];
      if (!call) {
        call = { id: '', name: '', args: '' };
        calls[at] = call;
      }
      if (d.id) call.id = d.id;
      if (d.function?.name) call.name = d.function.name;
      if (d.function?.arguments) call.args += d.function.arguments;
    }
  }

  const tail = think.flush();
  if (tail.visible) yield { kind: 'text', text: tail.visible };

  const settled = calls
    .filter((c): c is ToolCall => c !== undefined && c.name !== '')
    .map((c, i) => (c.id ? c : { ...c, id: `call_${i}` }));

  if (settled.length) yield { kind: 'calls', calls: settled };
}

interface Delta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

function parseDelta(frame: string): Delta | undefined {
  try {
    return JSON.parse(frame)?.choices?.[0]?.delta;
  } catch {
    return undefined;
  }
}

async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;

    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

    let split: number;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        if (payload) yield payload;
      }
    }
  }
}

const OPEN = '<think>';
const CLOSE = '</think>';

interface Split {
  visible: string;
  thinking: string;
}

/** Splits a token stream into visible text and reasoning, holding back tags cut across chunks. */
class ThinkFilter {
  private inside = false;
  private pending = '';

  push(text: string): Split {
    let rest = this.pending + text;
    let visible = '';
    let thinking = '';
    this.pending = '';

    for (;;) {
      const tag = this.inside ? CLOSE : OPEN;
      const at = rest.indexOf(tag);

      if (at !== -1) {
        if (this.inside) thinking += rest.slice(0, at);
        else visible += rest.slice(0, at);
        rest = rest.slice(at + tag.length);
        this.inside = !this.inside;
        continue;
      }

      const held = overlap(rest, tag);
      const ready = rest.slice(0, rest.length - held);
      if (this.inside) thinking += ready;
      else visible += ready;

      this.pending = rest.slice(rest.length - held);
      return { visible, thinking };
    }
  }

  /** A tag left half-open at end of stream was literal text, unless we were mid-reasoning. */
  flush(): Split {
    const rest = this.pending;
    this.pending = '';
    return this.inside ? { visible: '', thinking: '' } : { visible: rest, thinking: '' };
  }
}

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function overlap(s: string, tag: string): number {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

function base(cfg: LlmConfig): string {
  return cfg.baseUrl.replace(/\/$/, '');
}

function headers(cfg: LlmConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
}

interface ModelsBody {
  data?: { id?: string }[];
  models?: { name?: string }[];
}

/** Model ids from the OpenAI endpoint, falling back to Ollama's native list. */
export async function listModels(cfg: LlmConfig): Promise<string[]> {
  const standard = await names(`${base(cfg)}/models`, cfg, (b) => b.data?.map((m) => m.id));
  if (standard.length) return standard;

  const origin = new URL(base(cfg)).origin;
  return names(`${origin}/api/tags`, cfg, (b) => b.models?.map((m) => m.name));
}

async function names(
  url: string,
  cfg: LlmConfig,
  pick: (body: ModelsBody) => (string | undefined)[] | undefined,
): Promise<string[]> {
  const res = await fetch(url, { headers: headers(cfg) });
  if (!res.ok) return [];

  const picked = pick((await res.json()) as ModelsBody) ?? [];
  return [...new Set(picked.filter((n): n is string => !!n))].sort();
}

/** Every model across every configured endpoint. Unreachable endpoints are skipped. */
export async function listAll(endpoints: readonly Endpoint[]): Promise<ModelRef[]> {
  const perEndpoint = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const models = await listModels({
          baseUrl: endpoint.baseUrl,
          model: '',
          apiKey: endpoint.apiKey ?? '',
        });
        return models.map((model) => ({ endpoint: endpoint.name, model }));
      } catch {
        return [];
      }
    }),
  );

  return perEndpoint.flat();
}

// A scale-to-zero endpoint answers 503 with an empty body until a container is
// up, which can take minutes for a large model.
const COLD = new Set([502, 503, 504]);

export const DEFAULT_WARMUP_MS = 5 * 60_000;

export interface StreamOptions {
  /** How long to keep retrying a cold endpoint before giving up. */
  warmupMs?: number | undefined;
  onWait?: ((seconds: number) => void) | undefined;
}

async function send(
  cfg: LlmConfig,
  body: string,
  signal: AbortSignal,
  opts: StreamOptions,
): Promise<Response> {
  const limit = opts.warmupMs ?? DEFAULT_WARMUP_MS;
  const url = `${base(cfg)}/chat/completions`;
  const started = Date.now();
  let delay = 2_000;

  for (;;) {
    const res = await fetch(url, { method: 'POST', signal, headers: headers(cfg), body });
    const waited = Date.now() - started;

    if (!COLD.has(res.status) || waited > limit) return res;

    opts.onWait?.(Math.round(waited / 1_000));
    await pause(delay, signal);
    delay = Math.min(delay * 1.5, 15_000);
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);

    function stop(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }

    signal.addEventListener('abort', stop, { once: true });
  });
}
