import { stream, toWire, type LlmConfig, type Message, type ToolCall } from './llm.ts';
import { SPECS, TOOLS, type Args, type Limits } from './tools.ts';

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'think'; text: string }
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'result'; id: string; output: string; failed: boolean };

export interface LlmObservation {
  model: string;
  startedMs: number;
  durationMs: number;
  inputMessages: Message[];
  outputText: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined;
  status: 'ok' | 'error';
  error?: string | undefined;
}

export interface ToolObservation {
  name: string;
  startedMs: number;
  durationMs: number;
  args: string;
  output: string;
  failed: boolean;
}

export interface AgentDeps {
  cfg: LlmConfig;
  root: string;
  system: string;
  limits: Limits;
  signal: AbortSignal;
  warmupMs?: number | undefined;
  /** Bound on tool rounds. When reached, the model is called once more without
   *  tools so it can give a final answer instead of looping. */
  maxLoops?: number | undefined;
  onWait?: ((seconds: number) => void) | undefined;
  onObserve?:
    | ((event: { kind: 'llm'; observation: LlmObservation } | { kind: 'tool'; observation: ToolObservation }) => void)
    | undefined;
}

/** Streams one turn to completion, appending every exchange to `messages`.
 *  Runs until the model stops calling tools; cancel with the abort signal. */
export async function* run(messages: Message[], deps: AgentDeps): AsyncGenerator<AgentEvent> {
  let loops = 0;
  for (;;) {
    let text = '';
    let calls: ToolCall[] = [];
    let usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined;

    const withTools = deps.maxLoops == null || loops < deps.maxLoops;

    const sent: Message[] = [
      { role: 'system', content: deps.system },
      ...messages.filter((m) => m.role !== 'system'),
    ];

    const llmStarted = Date.now();
    try {
      for await (const chunk of stream(deps.cfg, sent, withTools ? SPECS : [], deps.signal, {
        warmupMs: deps.warmupMs,
        onWait: deps.onWait,
        onUsage: (u) => {
          usage = u;
        },
      })) {
        if (chunk.kind === 'text') {
          text += chunk.text;
          yield { kind: 'text', text: chunk.text };
        } else if (chunk.kind === 'think') {
          yield { kind: 'think', text: chunk.text };
        } else {
          calls = chunk.calls;
        }
      }
    } catch (e) {
      deps.onObserve?.({
        kind: 'llm',
        observation: {
          model: deps.cfg.model,
          startedMs: llmStarted,
          durationMs: Date.now() - llmStarted,
          inputMessages: sent,
          outputText: text,
          toolCalls: calls,
          usage,
          status: 'error',
          error: (e as Error).message,
        },
      });
      throw e;
    }
    deps.onObserve?.({
      kind: 'llm',
      observation: {
        model: deps.cfg.model,
        startedMs: llmStarted,
        durationMs: Date.now() - llmStarted,
        inputMessages: sent,
        outputText: text,
        toolCalls: calls,
        usage,
        status: 'ok',
      },
    });

    messages.push(
      calls.length
        ? { role: 'assistant', content: text, tool_calls: calls.map(toWire) }
        : { role: 'assistant', content: text },
    );

    // A server that returns tool calls when none were offered is misbehaving;
    // end the turn rather than act on them.
    if (!calls.length || !withTools) return;

    for (const call of calls) {
      yield { kind: 'tool', call };
      const toolStarted = Date.now();
      const { output, failed } = await execute(call, deps);
      deps.onObserve?.({
        kind: 'tool',
        observation: {
          name: call.name,
          startedMs: toolStarted,
          durationMs: Date.now() - toolStarted,
          args: call.args,
          output,
          failed,
        },
      });
      messages.push({ role: 'tool', content: output, tool_call_id: call.id });
      yield { kind: 'result', id: call.id, output, failed };
    }
    loops += 1;
  }
}

/** Every failure returns as a tool result so the model can correct instead of the turn dying. */
async function execute(
  call: ToolCall,
  deps: AgentDeps,
): Promise<{ output: string; failed: boolean }> {
  const tool = TOOLS.get(call.name);
  if (!tool) return { output: `unknown tool: ${call.name}`, failed: true };

  let args: Args;
  try {
    const parsed: unknown = call.args.trim() ? JSON.parse(call.args) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    args = parsed as Args;
  } catch (e) {
    return { output: `bad arguments: ${(e as Error).message}`, failed: true };
  }

  try {
    const ctx = { root: deps.root, limits: deps.limits };
    return { output: await tool.run(args, ctx), failed: false };
  } catch (e) {
    return { output: `error: ${(e as Error).message}`, failed: true };
  }
}
