import { run } from './agent.ts';
import { parseHeaders } from './otel.ts';
import type { LlmConfig, Message } from './llm.ts';
import type { Limits } from './tools.ts';
import { sendVerdict, type SendReport } from './transport.ts';
import type { VerdictQueue } from './verdict-queue.ts';

/**
 * The per-turn judge.
 *
 * After each completed chat turn, a judge reviews it. It is the same agent
 * loop as the agent itself: same model, same tools, same workspace; only the
 * system prompt differs, and it tells the judge to verify the work (read
 * files, run tests) without changing anything, and to end with a short JSON
 * verdict.
 *
 * The verdict goes out as a small named measurement against the trace id of
 * the turn it reviewed: one POST of
 * `{traceId, scores: [{name, value|label, ...}]}` to `<endpoint>/scores`.
 * That is the whole protocol, and it does not depend on any particular
 * store: whatever receives it can keep it, ignore it, or pair it with the
 * stored trace of the turn. Nothing is sent unless judging is enabled and an
 * endpoint is set, and a failed send never affects the chat, which is over
 * by the time the judge runs.
 */

export interface JudgeSettings {
  enabled: boolean;
  /** Base URL of the score store. Verdicts are POSTed to `<endpoint>/scores`. */
  endpoint: string;
  headers: Record<string, string>;
  systemPrompt: string;
  /** Most tool rounds the judge may run before it is forced to a verdict. */
  maxLoops: number;
  /** Largest turn transcript handed to the judge. */
  maxTranscriptBytes: number;
  /** Attribution stored with each measurement. */
  source: string;
  /** Wait this long after the turn before the first send, so the turn's own
   *  trace can land in the store first. */
  delayMs: number;
}

export const DEFAULT_JUDGE_PROMPT = [
  'You are a judge reviewing one turn of a coding agent that worked in this same workspace.',
  'The agent has the same tools you do. Use them to verify the work before judging it:',
  'read the files it changed, and if the task implies it, run its tests or build.',
  'You must not modify the workspace: no writes, deletes, or commands that change anything.',
  'Judge only what the user asked for in that turn, not the state of the repo before it.',
  'End your reply with one JSON object and nothing after it:',
  '{"score": <0..1>, "pass_at": <0..1, the bar for good enough, default 0.7>, "summary": "<one or two sentences>", "issues": ["<what is wrong>"]}',
].join('\n');

/**
 * Settings win; otherwise the DAISY_JUDGE_* environment variables do, so an
 * existing store setup needs no extra configuration here.
 */
export function resolveJudge(s: JudgeSettings): JudgeSettings {
  const endpoint = (s.endpoint.trim() || env('DAISY_JUDGE_ENDPOINT')).replace(/\/+$/, '');
  const headers = Object.keys(s.headers).length ? s.headers : parseHeaders(env('DAISY_JUDGE_HEADERS'));

  return {
    ...s,
    enabled: s.enabled && endpoint.length > 0,
    endpoint,
    headers,
    systemPrompt: s.systemPrompt.trim() || DEFAULT_JUDGE_PROMPT,
  };
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

/** The turn the judge reviews. */
export interface TurnRecord {
  chatId: string;
  turnNumber: number;
  userText: string;
  /** Messages the turn added after the user's: assistant text, tool calls, tool results. */
  messages: Message[];
  /** Trace id of the turn in the store; the verdict is posted against it. */
  traceId: string;
  model: string;
}

const TOOL_OUTPUT_CAP = 1000;

/** The turn as the judge reads it: the request, then everything the agent did. */
export function transcript(turn: TurnRecord, maxBytes: number): string {
  const callNames = new Map<string, string>();
  const lines: string[] = [
    `Reviewing turn ${turn.turnNumber} of chat ${turn.chatId} (model ${turn.model}).`,
    '',
    'User request:',
    turn.userText,
    '',
    'What the agent did, in order:',
  ];

  for (const m of turn.messages) {
    if (m.role === 'assistant') {
      if (m.content.trim()) lines.push(`[assistant] ${m.content.trim()}`);
      for (const c of m.tool_calls ?? []) {
        callNames.set(c.id, c.function.name);
        lines.push(`[call] ${c.function.name} ${c.function.arguments}`);
      }
    } else if (m.role === 'tool') {
      const name = callNames.get(m.tool_call_id) ?? 'unknown';
      const output =
        m.content.length > TOOL_OUTPUT_CAP ? `${m.content.slice(0, TOOL_OUTPUT_CAP)}...` : m.content;
      lines.push(`[result ${name}] ${output}`);
    }
  }

  let text = lines.join('\n');
  if (Buffer.byteLength(text) > maxBytes) text = `${text.slice(0, maxBytes)}\n[truncated]`;
  return text;
}

export interface Verdict {
  score: number | null;
  passAt: number | null;
  max: number | null;
  summary: string | null;
  issues: string[];
  /** True when a JSON verdict object was found in the final text. */
  parsed: boolean;
  /** The judge's final text, kept so an unparsed verdict can be filed. */
  raw: string;
}

/** The JSON object the judge prompt asks for, however much prose surrounds it. */
export function parseVerdict(text: string): Verdict {
  const out: Verdict = { score: null, passAt: null, max: null, summary: null, issues: [], parsed: false, raw: text.trim() };
  // The verdict is what the judge ends with, so read backwards from the last
  // brace: prose or code earlier in the reply may contain braces of its own,
  // and a truncated object leaves its tail, not its head, unpaired.
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(text.slice(text.lastIndexOf('{', end), end + 1));
    } catch {
      continue;
    }
    if (typeof candidate !== 'object' || candidate === null) continue;
    const c = candidate as Record<string, unknown>;
    if (![ 'score', 'pass_at', 'passAt', 'summary', 'issues', 'max' ].some((k) => c[k] !== undefined)) continue;
    out.parsed = true;
    return fill(out, candidate);
  }
  return out;
}

function fill(out: Verdict, parsed: unknown): Verdict {
  const o = parsed as Record<string, unknown>;

  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  out.score = num(o.score);
  out.passAt = num(o.pass_at) ?? num(o.passAt);
  out.max = num(o.max);
  out.summary = typeof o.summary === 'string' && o.summary.trim() ? o.summary.trim() : null;
  if (Array.isArray(o.issues)) out.issues = o.issues.map((x) => String(x)).filter(Boolean).slice(0, 8);
  return out;
}

/** The measurement batch for one verdict. Null when the verdict carries nothing to record. */
export function scoresBody(traceId: string, v: Verdict, source: string): Record<string, unknown> | null {
  const scores: Record<string, unknown>[] = [];

  if (v.score != null) {
    const s: Record<string, unknown> = { name: 'score', value: v.score, source };
    if (v.passAt != null) s.pass_at = v.passAt;
    if (v.max != null) s.max = v.max;
    scores.push(s);
  }
  if (v.summary) scores.push({ name: 'summary', label: v.summary.slice(0, 200), source });
  v.issues.forEach((issue, i) => scores.push({ name: `issue.${i + 1}`, label: issue.slice(0, 200), source }));

  return scores.length ? { traceId, scores } : null;
}

export interface JudgeDeps {
  cfg: LlmConfig;
  root: string;
  limits: Limits;
  /** Resolved settings. */
  settings: JudgeSettings;
  /**
   * Where a verdict that the store has not taken yet goes to wait. When one
   * is given, the verdict is remembered BEFORE its first send, so a VS Code
   * reload in the middle of the judge no longer loses it: the next
   * activation sends it again. Optional so the function stays usable (and
   * testable) without a store.
   */
  queue?: VerdictQueue;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const SEND_TIMEOUT_MS = 10_000;
/** How long to keep re-posting in this session while the trace is still landing. */
const RETRY_DELAYS_MS = [3_000, 9_000];

/**
 * Review one turn: run the judge, parse its verdict, post it against the
 * turn's trace id. Delivery problems never throw; by the time this runs the
 * chat is over and the outcome is the judge's own business.
 *
 * When a queue is supplied, the verdict is written to it before the first
 * send. The in-session retries are the fast path for the usual case (the
 * trace lands a few seconds late). While the store still answers "not yet",
 * the queue keeps the entry for the next flush: the slow path for the case
 * that used to drop the verdict (a reload, a dead endpoint, a closed window).
 */
export async function judgeTurn(turn: TurnRecord, deps: JudgeDeps): Promise<Verdict | null> {
  const { settings } = deps;
  if (!settings.enabled) return null;

  const messages: Message[] = [{ role: 'user', content: transcript(turn, settings.maxTranscriptBytes) }];
  let finalText = '';

  try {
    for await (const event of run(messages, {
      cfg: deps.cfg,
      root: deps.root,
      system: settings.systemPrompt,
      limits: deps.limits,
      signal: new AbortController().signal,
      maxLoops: settings.maxLoops,
    })) {
      if (event.kind === 'text') finalText += event.text;
      else if (event.kind === 'tool') finalText = ''; // a new round starts; the verdict is the last one
    }
  } catch (e) {
    finalText = `judge failed: ${(e as Error).message}`;
  }

  const verdict = parseVerdict(finalText);
  let body = scoresBody(turn.traceId, verdict, settings.source);
  if (!body) {
    // Nothing to file as a score, but the review happened: keep what the
    // judge actually said so a bad verdict is readable, not silent.
    body = {
      traceId: turn.traceId,
      // The store clips a label to 200 chars, and the verdict is what the
      // judge ends with, so keep the tail of its reply.
      scores: [{ name: 'judge.raw', label: (verdict.raw || '(empty verdict)').slice(-190), source: settings.source }],
    };
  }

  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const text = JSON.stringify(body);

  // Remember before sending: if this process dies between the two lines, the
  // verdict is still on disk and the next activation finishes the job.
  deps.queue?.add({
    traceId: turn.traceId,
    body: text,
    enqueuedAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
  });

  await sleep(settings.delayMs);

  const report = await sendVerdict(
    {
      endpoint: settings.endpoint,
      headers: settings.headers,
      timeoutMs: SEND_TIMEOUT_MS,
      fetchImpl: deps.fetchImpl,
      sleepImpl: sleep,
    },
    turn.traceId,
    text,
    RETRY_DELAYS_MS.length + 1,
    RETRY_DELAYS_MS,
  );

  settleQueue(deps.queue, turn.traceId, text, report);
  return verdict;
}

/**
 * Settle the queue entry a live send just made:
 *
 *   delivered  the store has it; nothing left to do.
 *   refused    the store will keep refusing; keep it out of the queue so
 *              a startup flush does not spend its whole budget on one
 *              bad endpoint, and let the activation notice the refusals.
 *   pending    the store may still take it: keep the entry, count what the
 *              live path already tried, and let the backoff run from now.
 */
function settleQueue(
  queue: VerdictQueue | undefined,
  traceId: string,
  body: string,
  report: SendReport,
): void {
  if (!queue) return;
  if (report.outcome === "pending") {
    queue.add({ traceId, body, enqueuedAt: Date.now(), attempts: report.attempts, lastAttemptAt: Date.now() });
  } else {
    queue.remove(traceId);
  }
}
