# Local Agent

A chat sidebar for VS Code that reads and writes files in your workspace and runs
shell commands. It talks to any OpenAI-compatible endpoint, so the model can be
running on your own GPU or behind a hosted API.

Around 550 lines of TypeScript, no runtime dependencies.

## Install

```bash
git clone https://github.com/jacobweiss2305/vscode-local-agent
cd vscode-local-agent
npm install
npm run build
```

Open the folder in VS Code and press F5. A second window opens with the extension
loaded. The agent icon appears in the activity bar; drag the view to the right if
you want it there.

## Point it at a model

Defaults assume Ollama on `localhost:11434`:

```bash
ollama pull hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL
```

Any server speaking `POST /v1/chat/completions` with streaming and tool calls
works. Change `localAgent.baseUrl` and `localAgent.model` in settings:

| Server | `baseUrl` |
| --- | --- |
| Ollama | `http://localhost:11434/v1` |
| llama.cpp | `http://localhost:8080/v1` |
| LM Studio | `http://localhost:1234/v1` |
| vLLM | `http://localhost:8000/v1` |

Set `localAgent.apiKey` for hosted endpoints. Leave it empty for local ones.

## Tools

| Tool | Approval |
| --- | --- |
| `read_file` | no |
| `list_dir` | no |
| `write_file` | yes |
| `delete_file` | yes |
| `run_command` | yes |

Anything that changes your machine waits for a button press in the panel. Every
path is resolved against the workspace root and rejected if it escapes, so the
model cannot reach `../../.ssh`. Symlinks pointing outside the workspace are not
followed up, which is a real gap if you have them.

`run_command` gives a language model a shell on your machine. The approval prompt
shows the exact command before it runs. Read it.

## How it works

```
chat.ts    webview panel, approval round trips
agent.ts   the loop: stream, run tools, feed results back
llm.ts     SSE parsing, tool call assembly, reasoning-tag stripping
tools.ts   tool definitions and the workspace path guard
```

The loop in `agent.ts` streams a response, appends it to the message list, and
runs whatever tools the model asked for. Tool output goes back as `role: "tool"`
messages and the loop repeats until the model stops calling tools or hits
`localAgent.maxSteps` (default 12).

Tool failures come back as tool results rather than exceptions. A model that
passes a bad path sees the error and retries instead of the turn dying.

Two details that break streaming if you skip them. Tool call arguments arrive as
fragments across many SSE deltas and have to be reassembled by `index` before
they parse as JSON. Reasoning models emit `<think>` spans that must be stripped
from the visible text, and the tags themselves split across chunk boundaries, so
`ThinkFilter` holds back any partial tag suffix until the next chunk resolves it.

## Tests

```bash
npm test
```

Node 24 runs the TypeScript directly, so there is no test framework to install.
The tests cover the two things that are not obviously correct by reading them:
reassembling tool call arguments split across SSE deltas, and the path guard.

## Model compatibility

Tool calls are read from the standard `tool_calls` field. Models that instead
emit tool calls as XML inside the content field will not work without a parser
for that format.

## License

MIT
