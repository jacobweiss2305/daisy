import { stream, toWire, type LlmConfig, type Message, type ToolCall } from './llm.ts';
import { SPECS, TOOLS, type Args } from './tools.ts';

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'think'; text: string }
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'result'; id: string; output: string; failed: boolean };

export interface AgentDeps {
  cfg: LlmConfig;
  root: string;
  signal: AbortSignal;
  onWait?: (seconds: number) => void;
}

/** Streams one turn to completion, appending every exchange to `messages`.
 *  Runs until the model stops calling tools; cancel with the abort signal. */
export async function* run(messages: Message[], deps: AgentDeps): AsyncGenerator<AgentEvent> {
  for (;;) {
    let text = '';
    let calls: ToolCall[] = [];

    for await (const chunk of stream(deps.cfg, messages, SPECS, deps.signal, deps.onWait)) {
      if (chunk.kind === 'text') {
        text += chunk.text;
        yield { kind: 'text', text: chunk.text };
      } else if (chunk.kind === 'think') {
        yield { kind: 'think', text: chunk.text };
      } else {
        calls = chunk.calls;
      }
    }

    messages.push(
      calls.length
        ? { role: 'assistant', content: text, tool_calls: calls.map(toWire) }
        : { role: 'assistant', content: text },
    );

    if (!calls.length) return;

    for (const call of calls) {
      yield { kind: 'tool', call };
      const { output, failed } = await execute(call, deps);
      messages.push({ role: 'tool', content: output, tool_call_id: call.id });
      yield { kind: 'result', id: call.id, output, failed };
    }
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
    return { output: await tool.run(args, deps.root), failed: false };
  } catch (e) {
    return { output: `error: ${(e as Error).message}`, failed: true };
  }
}
