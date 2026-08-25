# Daisy

A coding agent in the VS Code sidebar. Daisy reads and writes files in your
workspace, runs shell commands, and talks to any OpenAI-compatible endpoint, so
the model can sit on your own GPU or behind a hosted API.

About 1,000 lines of TypeScript plus a webview in plain JavaScript and CSS. No
runtime dependencies, and no test framework.

Requires VS Code 1.106 or newer, which is where extensions gained the ability to
put a view in the Secondary Side Bar.

## Install

```bash
git clone https://github.com/jacobweiss2305/daisy
cd daisy
npm install
npm run build
```

Open the folder in VS Code and press F5. A second window opens with the extension
loaded, and Daisy appears in the Secondary Side Bar on the right (`Ctrl+Alt+B` if
that bar is hidden).

To install her into your everyday VS Code instead of a dev window:

```bash
npx @vscode/vsce package --no-dependencies
code --install-extension daisy-0.1.0.vsix
```

That installs a snapshot, not your working tree. While changing the code, use the
dev window instead, where `npm run build` and a reload pick up edits:

```bash
code --extensionDevelopmentPath="$PWD" --new-window "$PWD"
```

## Pointing her at a model

The gear in the panel header holds the endpoint editor: name, base URL, and API
key. Each card shows what that endpoint is serving, or `not reachable` if it
isn't answering.

Endpoints are a list, and every reachable one contributes to what Daisy can use.
A server generally hosts one model, so choosing an endpoint chooses the model
with it. With more than one configured, a radio on each card picks the active
one.

Any server speaking `POST /v1/chat/completions` with streaming and tool calls
works:

| Server | Base URL |
| --- | --- |
| Ollama | `http://localhost:11434/v1` |
| llama.cpp | `http://localhost:8080/v1` |
| SGLang | `http://localhost:30000/v1` |
| LM Studio | `http://localhost:1234/v1` |
| vLLM | `http://localhost:8000/v1` |

Leave the key empty for local servers. Model discovery tries `GET /v1/models`
first and falls back to Ollama's `/api/tags`, because Ollama returns
`{"data": null}` from the OpenAI endpoint while it is still indexing.

An endpoint that does not answer is skipped rather than failing the list, so a
stopped local server does not hide your hosted ones. A selection that no longer
exists heals itself instead of failing on send.

## Using the panel

**Chats.** The title in the header opens the chat list: grouped by recency, with
message counts and delete on each row. `+` starts a fresh one. Chats live in
workspace state, so they are scoped to the folder you opened and survive a
reload. The last 30 are kept.

Starting a chat discards any earlier one you never typed in, so the list holds
conversations rather than a pile of empty rows.

**Attaching files.** Type `@` to search the workspace. Arrow keys move, Enter or
Tab accepts, Escape dismisses. On send, each mentioned file is read and inlined
ahead of your message as a `<file path="...">` block. Mentions that do not
resolve to a readable file inside the workspace stay ordinary text, so
`me@example.com` remains an email address.

**Reasoning.** Models that think out loud stream into a collapsed block, kept out
of the answer and out of the message history, so it costs nothing on later turns.
Both conventions are handled: a `reasoning_content` field on the delta, and
`<think>` tags inline in the content.

**Formatting.** Replies render as markdown. The renderer builds DOM nodes instead
of assigning HTML, so markup in a reply is text and there is nothing to sanitise.
Rendering is coalesced to one pass per animation frame, so a long reply does not
reparse on every token.

**Scrolling.** The transcript follows new output only while you are already at
the bottom. Scroll up mid-generation and it stays where you put it, with a jump
button to return.

**Activity.** Tool calls read as a line rather than a JSON dump: `Read
src/agent.ts`, `$ npm test`. Click one to see its output. A failed call opens its
output rather than hiding the error behind a click.

## Tools

| Tool | What it does |
| --- | --- |
| `read_file` | Read a UTF-8 file |
| `list_dir` | List a directory |
| `write_file` | Create or overwrite a file |
| `delete_file` | Delete a file or directory |
| `run_command` | Run a shell command in the workspace root |

Daisy runs these autonomously. Nothing prompts, and nothing is confirmed.

The only boundary is the path guard: every path is resolved against the workspace
root and rejected if it escapes, so file tools cannot reach `../../.ssh`.
Symlinks pointing outside the workspace are not followed up.

`run_command` is not bounded by that guard, or by anything else. It runs whatever
the model emits, in your workspace root, with your permissions. Work in a git
repo with a clean tree so `git diff` and `git checkout .` are available.

## Settings

| Setting | Default | What it controls |
| --- | --- | --- |
| `daisy.endpoints` | one Ollama entry | Servers Daisy can use |
| `daisy.endpoint` | first | Which one is active |
| `daisy.model` | derived | Set from the active endpoint, not by hand |
| `daisy.systemPrompt` | three lines | Sent ahead of every message |
| `daisy.maxFileBytes` | 65536 | Largest file body handed to the model |
| `daisy.commandTimeout` | 120 | Seconds a shell command may run |
| `daisy.maxOutputBytes` | 1048576 | Most output a command may produce |
| `daisy.fileSearchLimit` | 3000 | Files offered to `@` autocomplete |
| `daisy.sessionsKept` | 30 | Chats kept before the oldest are dropped |
| `daisy.warmupTimeout` | 300 | Seconds to retry an endpoint that is starting |

The four size and time limits are the ones that quietly change answers rather
than failing: a clipped file reads as a whole file to the model, and a killed
command reads as a broken one. Raise them when a repo or a build outgrows them.

The system prompt is editable in the gear, in settings, or through
`Daisy: Edit System Prompt` in the command palette. It is prepended per request
rather than stored in a chat, so an edit reaches existing chats too.

## How it works

```
chat.ts            webview panel and the host/view protocol
agent.ts           the loop: stream, run tools, feed results back
llm.ts             SSE parsing, tool call assembly, reasoning split, model lists
tools.ts           tool definitions, the workspace path guard, @ expansion
sessions.ts        chat storage, pruning, titles
media/main.js      panel behaviour
media/markdown.js  the reply renderer
```

The loop in `agent.ts` streams a response, appends it to the message list, and
runs whatever tools the model asked for. Tool output goes back as `role: "tool"`
messages and the loop repeats until the model stops calling tools. There is no
step cap; Stop aborts the turn, and the abort signal unwinds the request and any
warm-up backoff with it.

Tool failures come back as tool results rather than exceptions. A model that
passes a bad path sees the error and retries instead of the turn dying.

Three details that break streaming if you skip them. Tool call arguments arrive
as fragments across many SSE deltas and have to be reassembled by `index` before
they parse as JSON. Reasoning tags split across chunk boundaries, so the filter
holds back any partial tag until the next chunk resolves it. And a scale-to-zero
endpoint answers `503` with an empty body for minutes while it starts, so `502`,
`503`, and `504` retry with backoff while every other status fails at once.

## Tests

```bash
npm test
```

Node 24 runs the TypeScript directly, so there is no test framework to install.
39 tests cover the parts that are not obviously correct by reading them: SSE
delta reassembly, splitting reasoning out of the token stream, cold-start retry,
the path guard, mention expansion, chat storage and pruning, and the markdown
renderer.

The renderer is browser code, so its tests load `media/markdown.js` through a
small DOM shim and exercise the shipped file rather than a copy.

That choice constrains the syntax. Node's strip-only mode rejects TypeScript
parameter properties, so constructors assign their fields explicitly. esbuild
would accept them; `node --test` will not.

## Serving on Modal

`serving/qwen38_modal.py` runs Qwen3.8-27B on one H100 with vLLM.

```bash
modal secret create daisy-llm DAISY_API_KEY=$(openssl rand -hex 24)
modal deploy serving/qwen38_modal.py
```

It sets `min_containers=1`, so there is no cold start. That bills every hour of
the month whether or not anyone is typing. `min_containers=0` with a long
`scaledown_window` feels the same during a working session for a fraction of the
cost, at the price of one wait each morning.

Modal's managed Endpoints (`modal endpoint create`) are easier to stand up but
always scale to zero and expose no warm-container setting.
`serving/keepalive.py` holds one warm by pinging it every 60 seconds, which is
the only lever that product offers. It reads the endpoint URL and token from the
`daisy-proxy` secret, so neither is in this repo:

```bash
modal secret create daisy-proxy     MODAL_PROXY_TOKEN=wk-xxx.ws-yyy     DAISY_ENDPOINT=https://<workspace>--<endpoint>.modal.direct/v1/models
modal deploy serving/keepalive.py
```
 Managed Endpoints also serve through SGLang
rather than vLLM, and take a workspace proxy token as the API key. That token
must be scoped to the endpoint's environment or every request returns
`401 Webhook token not found`:

```bash
modal workspace proxy-tokens create
modal workspace proxy-tokens allow <wk-token-id> main
```

Stop either app with `modal app stop -y <app-name>`.

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
