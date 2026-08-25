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

The gear in the panel header holds both the model chooser and the endpoint
editor: name, base URL, and API key, with add and remove. Opening it re-reads
what each endpoint serves. `daisy.endpoints` holds objects, so the settings UI
falls back to raw JSON for it, which is why the panel has its own form.

Daisy talks to several servers at once. `daisy.endpoints` is a list, and the
dropdown shows every model from every reachable one, labelled by endpoint when
more than one answers. Picking one writes both `daisy.endpoint` and `daisy.model`,
so switching between a local model and a hosted one is a single click.

```json
"daisy.endpoints": [
  { "name": "ollama", "baseUrl": "http://localhost:11434/v1", "apiKey": "" },
  { "name": "modal",  "baseUrl": "https://…modal.direct/v1", "apiKey": "wk-….ws-…" }
]
```

An endpoint that does not answer is skipped rather than failing the list, so a
stopped local server does not hide your hosted models. Reload re-reads them all.

Model discovery tries `GET /v1/models` first and falls back to Ollama's
`/api/tags`, because Ollama returns `{"data": null}` from the OpenAI endpoint
while it is still indexing.

Any server speaking `POST /v1/chat/completions` with streaming and tool calls
works:

| Server | `baseUrl` |
| --- | --- |
| Ollama | `http://localhost:11434/v1` |
| llama.cpp | `http://localhost:8080/v1` |
| SGLang | `http://localhost:30000/v1` |
| LM Studio | `http://localhost:1234/v1` |
| vLLM | `http://localhost:8000/v1` |

Modal's managed endpoints work as a hosted option. They serve through SGLang and
take a workspace proxy token (`wk-….ws-…`) as the API key. The token must be
scoped to the endpoint's environment, otherwise every request returns
`401 Webhook token not found`:

```bash
modal workspace proxy-tokens create
modal workspace proxy-tokens allow <wk-token-id> main
```

Scale-to-zero endpoints answer `503` with an empty body until a container is up,
which took about three and a half minutes for a bf16 27B. Daisy retries `502`,
`503`, and `504` with backoff for up to five minutes and reports how long it has
been waiting. Every other status fails immediately, so a real error still
surfaces at once.

## Serving on Modal

`serving/qwen38_modal.py` runs Qwen3.8-27B on one H100 with vLLM, behind the same
OpenAI-compatible API.

```bash
modal secret create daisy-llm DAISY_API_KEY=$(openssl rand -hex 24)
modal deploy serving/qwen38_modal.py
```

It sets `min_containers=1`, so a container stays up and there is no cold start.
That bills 730 hours a month whether or not anyone is typing. `min_containers=0`
with a long `scaledown_window` gives the same warm feel during a working session
for roughly a quarter of the cost, and costs one wait each morning.

Modal's managed Endpoints (`modal endpoint create`) are the easier path but always
scale to zero, and expose no warm-container setting, which is why this app exists.
They also serve through SGLang rather than vLLM.

Stop it with `modal app stop -y daisy-qwen38`.

## The system prompt

`daisy.systemPrompt` is yours to change. `Daisy: Edit System Prompt` in the
command palette opens it in a multi-line editor.

It is not stored in a chat's history, it is prepended to each request, so an edit
applies to every existing chat immediately rather than only to new ones. Blank it
to fall back to the default.

## Using the panel

**Chats.** The top dropdown switches between conversations and New starts a fresh
one. Each is named after its first message and stored in workspace state, so they
are scoped to the folder you opened and survive a reload. The last 30 are kept.

**Attaching files.** Type `@` in the composer to search the workspace. Arrow keys
move, Enter or Tab accepts, Escape dismisses. On send, each mentioned file is read
and inlined ahead of your message as a `<file path="...">` block. Mentions that do
not resolve to a readable file inside the workspace are left as ordinary text, so
`me@example.com` stays an email address.

**Formatting.** Replies render as markdown: fenced code blocks, inline code,
headings, lists, quotes, and http links. The renderer builds DOM nodes instead of
assigning HTML, so markup in a reply is text and there is nothing to sanitise.
Rendering is coalesced to one pass per animation frame, so a long reply does not
reparse on every token.

**Reasoning.** Models that think out loud stream into a collapsed Thinking block,
kept separate from the answer. Reasoning is never written back into the message
history, so it costs nothing on later turns. Both conventions are handled: a
`reasoning_content` field on the delta, and `<think>` tags inline in the content.

## Settings

| Setting | Default | What it controls |
| --- | --- | --- |
| `daisy.endpoints` | ollama | Servers offered in the model dropdown |
| `daisy.endpoint` | first | Which one serves the selected model |
| `daisy.model` | | Selected model |
| `daisy.systemPrompt` | see below | Instructions sent with every message |
| `daisy.maxFileBytes` | 65536 | Largest file body handed to the model |
| `daisy.commandTimeout` | 120 | Seconds a shell command may run |
| `daisy.maxOutputBytes` | 1048576 | Most output a command may produce |
| `daisy.fileSearchLimit` | 3000 | Files offered to `@` autocomplete |
| `daisy.sessionsKept` | 30 | Chats kept before the oldest are dropped |
| `daisy.warmupTimeout` | 300 | Seconds to retry an endpoint that is starting |

The four size and time limits are the ones that quietly change answers rather
than just failing: a clipped file reads as a whole file to the model, and a
killed command reads as a broken one. Raise them when a repo or a build outgrows
them.

## Tools

| Tool | What it does |
| --- | --- |
| `read_file` | Read a UTF-8 file |
| `list_dir` | List a directory |
| `write_file` | Create or overwrite a file |
| `delete_file` | Delete a file or directory |
| `run_command` | Run a shell command in the workspace root |

Daisy runs these autonomously. Nothing prompts, and nothing is confirmed.

The only boundary is the path guard: every path is resolved against the
workspace root and rejected if it escapes, so file tools cannot reach
`../../.ssh`. Symlinks pointing outside the workspace are not followed up.

`run_command` is not bounded by that guard, or by anything else. It runs whatever
the model emits, in your workspace root, with your permissions. Work in a git
repo with a clean tree so `git diff` and `git checkout .` are available.

## How it works

```
chat.ts    webview panel and host/view protocol
agent.ts   the loop: stream, run tools, feed results back
llm.ts     SSE parsing, tool call assembly, reasoning-tag stripping
tools.ts   tool definitions and the workspace path guard
media/markdown.js  the reply renderer
```

The loop in `agent.ts` streams a response, appends it to the message list, and
runs whatever tools the model asked for. Tool output goes back as `role: "tool"`
messages and the loop repeats until the model stops calling tools. There is no
step cap; Stop aborts the turn.

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

Servers disagree about absent fields. vLLM omits them; SGLang sends an explicit
`null` for `content`, `reasoning_content`, and `tool_calls`. Both are handled,
and a regression test pins the null-heavy shape using frames captured from a
Modal endpoint serving Qwen3.8-27B.

## License

MIT
