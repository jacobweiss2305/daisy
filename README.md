# Daisy

A coding agent in the VS Code sidebar. Daisy reads and writes files in your
workspace, runs shell commands, and talks to any OpenAI-compatible endpoint, so
the model can sit on your own GPU or behind a hosted API.

Around 550 lines of TypeScript, no runtime dependencies.

## Install

```bash
git clone https://github.com/jacobweiss2305/daisy
cd daisy
npm install
npm run build
```

Open the folder in VS Code and press F5. A second window opens with the extension
loaded. Daisy appears in the Secondary Side Bar on the right; open it with
`Ctrl+Alt+B` if that bar is hidden.

Requires VS Code 1.106 or newer, which is where extensions gained the ability to
put a view in the Secondary Side Bar.

To install her permanently instead of running a dev window:

```bash
npx @vscode/vsce package --no-dependencies
code --install-extension daisy-0.1.0.vsix
```

## Point her at a model

Defaults assume Ollama on `localhost:11434`:

```bash
ollama pull hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL
```

Pick the model from the dropdown at the top of the panel. It lists whatever the
endpoint reports, and the choice writes straight to `daisy.model`, so the panel
and the settings UI never disagree. Reload re-reads the list after you pull a new
model.

Model discovery tries `GET /v1/models` first and falls back to Ollama's
`/api/tags`, because Ollama returns `{"data": null}` from the OpenAI endpoint
while it is still indexing.

Any server speaking `POST /v1/chat/completions` with streaming and tool calls
works. `daisy.baseUrl` still lives in settings:

| Server | `baseUrl` |
| --- | --- |
| Ollama | `http://localhost:11434/v1` |
| llama.cpp | `http://localhost:8080/v1` |
| LM Studio | `http://localhost:1234/v1` |
| vLLM | `http://localhost:8000/v1` |

Set `daisy.apiKey` for hosted endpoints. Leave it empty for local ones.

## Using the panel

**Chats.** The top dropdown switches between conversations and New starts a fresh
one. Each is named after its first message and stored in workspace state, so they
are scoped to the folder you opened and survive a reload. The last 30 are kept.

**Attaching files.** Type `@` in the composer to search the workspace. Arrow keys
move, Enter or Tab accepts, Escape dismisses. On send, each mentioned file is read
and inlined ahead of your message as a `<file path="...">` block. Mentions that do
not resolve to a readable file inside the workspace are left as ordinary text, so
`me@example.com` stays an email address.

**Reasoning.** Models that think out loud stream into a collapsed Thinking block,
kept separate from the answer. Reasoning is never written back into the message
history, so it costs nothing on later turns. Both conventions are handled: a
`reasoning_content` field on the delta, and `<think>` tags inline in the content.

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
`daisy.maxSteps` (default 12).

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
The tests cover the parts that are not obviously correct by reading them: SSE
delta reassembly, splitting reasoning out of the token stream, the path guard,
mention expansion, and session storage.

That choice constrains the syntax. Node's strip-only mode rejects TypeScript
parameter properties, so constructors assign their fields explicitly. esbuild
would accept them; `node --test` will not.

## Model compatibility

Tool calls are read from the standard `tool_calls` field. Models that instead
emit tool calls as XML inside the content field will not work without a parser
for that format.

## License

MIT
