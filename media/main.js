const vscode = acquireVsCodeApi();

const log = document.getElementById('log');
const form = document.getElementById('composer');
const prompt = document.getElementById('prompt');
const submit = document.getElementById('submit');
const stop = document.getElementById('stop');
const titleBtn = document.getElementById('title');
const titleText = document.getElementById('titleText');
const chats = document.getElementById('chats');
const startNew = document.getElementById('new');
const mentions = document.getElementById('mentions');
const queued = document.getElementById('queued');
const gear = document.getElementById('gear');
const settings = document.getElementById('settings');

const SEEDS = [
  'What does this project do?',
  'Find the riskiest code here and explain why',
  'Run the tests and fix what fails',
];

const cards = new Map();
let modelRefs = [];
let files = [];
let matches = [];
let highlighted = 0;
let openBubble = null;
let openThink = null;
let openRaw = '';
let frame = 0;
let busy = false;
let follow = true;
const queue = [];
let endpoints = [];
let activeEndpoint = '';
let systemPrompt = '';
let telemetry = {
  enabled: false,
  active: '',
  endpoint: '',
  headers: '',
  serviceName: 'daisy',
  resourceAttributes: '',
  pending: 0,
};
let chatList = [];
let running = [];
let activeChat = '';

startNew.addEventListener('click', () => {
  show('log');
  vscode.postMessage({ type: 'new' });
});

gear.addEventListener('click', () => show(settings.hidden ? 'settings' : 'log'));
titleBtn.addEventListener('click', () => show(chats.hidden ? 'chats' : 'log'));

/** Exactly one of the three panes is visible at a time. */
function show(view) {
  log.hidden = view !== 'log';
  settings.hidden = view !== 'settings';
  chats.hidden = view !== 'chats';

  if (view === 'settings') {
    // Opening settings is the moment to re-read what each endpoint serves.
    vscode.postMessage({ type: 'refresh' });
    renderSettings();
  }
  if (view === 'chats') renderChats();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();

  const text = prompt.value.trim();
  if (!text) return;

  prompt.value = '';
  grow();
  hideMentions();
  follow = true;

  if (busy) {
    enqueue(text);
    return;
  }

  send(text);
});

stop.addEventListener('click', () => {
  vscode.postMessage({ type: 'cancel' });
  clearQueue();
});

function send(text) {
  say('user', 'You').textContent = text;
  setBusy(true);
  vscode.postMessage({ type: 'send', text });
}

/** Messages typed mid-turn wait on the composer rather than interrupting the turn. */
function enqueue(text) {
  const row = document.createElement('div');
  row.className = 'queued';

  const body = document.createElement('span');
  body.textContent = text;

  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'drop';
  drop.title = 'Remove from queue';
  drop.textContent = '×';
  drop.addEventListener('click', () => {
    const at = queue.findIndex((q) => q.row === row);
    if (at !== -1) queue.splice(at, 1);
    row.remove();
  });

  row.append(body, drop);
  queued.append(row);
  queue.push({ text, row });
}

function clearQueue() {
  for (const item of queue) item.row.remove();
  queue.length = 0;
}

function next() {
  const item = queue.shift();
  if (!item) return;

  item.row.remove();
  send(item.text);
}

prompt.addEventListener('input', () => {
  grow();
  updateMentions();
});

prompt.addEventListener('keydown', (event) => {
  if (matches.length) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        highlighted = (highlighted + 1) % matches.length;
        return renderMentions();
      case 'ArrowUp':
        event.preventDefault();
        highlighted = (highlighted - 1 + matches.length) % matches.length;
        return renderMentions();
      case 'Enter':
      case 'Tab':
        event.preventDefault();
        return accept(matches[highlighted]);
      case 'Escape':
        event.preventDefault();
        return hideMentions();
    }
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

window.addEventListener('message', ({ data }) => {
  // Another chat's worker is still streaming; its output is stored in that
  // chat and shows when you open it.
  if (data.chat && data.chat !== activeChat) return;

  switch (data.type) {
    case 'text':
      openThink = null;
      if (!openBubble) {
        openBubble = say('assistant', 'Daisy');
        openRaw = '';
      }
      openRaw += data.text;
      draw();
      break;

    case 'think':
      closeBubble();
      if (!openThink) openThink = thinking();
      openThink.add(data.text);
      break;

    case 'tool':
      closeBubble();
      openThink = null;
      cards.set(data.id, activity(data));
      break;

    case 'result':
      cards.get(data.id)?.settle(data.output, data.failed);
      cards.delete(data.id);
      break;

    case 'status':
      closeBubble();
      openThink = null;
      say('status').textContent = data.text;
      break;

    case 'models':
      modelRefs = data.items;
      if (!settings.hidden) renderSettings();
      break;

    case 'chats':
      chatList = data.items;
      activeChat = data.active;
      running = data.running ?? [];
      titleText.textContent =
        data.items.find((c) => c.id === data.active)?.title ?? 'New chat';
      setBusy(running.includes(activeChat));
      if (!chats.hidden) renderChats();
      break;

    case 'history':
      show('log');
      log.replaceChildren();
      cards.clear();
      closeBubble();
      openThink = null;
      for (const item of data.items) {
        const el = say(item.role, item.role === 'user' ? 'You' : 'Daisy');
        if (item.role === 'assistant') el.append(renderMarkdown(item.text));
        else el.textContent = item.text;
      }
      if (!data.items.length) blank();
      break;

    case 'files':
      files = data.items;
      break;

    case 'config':
      endpoints = data.endpoints.map((e) => ({ ...e }));
      systemPrompt = data.systemPrompt;
      activeEndpoint = data.active;
      if (!settings.hidden) renderSettings();
      break;

    case 'telemetry':
      telemetry = data;
      if (!settings.hidden) renderSettings();
      break;

    case 'done':
      closeBubble();
      openThink = null;
      setBusy(false);
      next();
      break;
  }

  stick();
});

const NEAR = 40;

function atBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < NEAR;
}

/** Scrolling up during generation means you want to read, so stop chasing. */
log.addEventListener('scroll', () => {
  follow = atBottom();
  jump.hidden = follow;
});

function stick() {
  if (follow) log.scrollTop = log.scrollHeight;
  jump.hidden = follow;
}

/** A turn: small role label above the content. */
function say(role, who) {
  document.getElementById('blank')?.remove();

  const turn = document.createElement('div');
  turn.className = 'turn';

  if (who) {
    const tag = document.createElement('div');
    tag.className = 'who';
    tag.textContent = who;
    turn.append(tag);
  }

  const body = document.createElement('div');
  body.className = `msg ${role}`;
  turn.append(body);
  log.append(turn);
  return body;
}

function blank() {
  if (document.getElementById('blank')) return;

  const box = document.createElement('div');
  box.id = 'blank';

  const title = document.createElement('h1');
  title.textContent = 'Daisy';

  const copy = document.createElement('p');
  copy.textContent =
    'She reads and writes files in this folder and runs commands. Type @ to attach a file.';

  const seeds = document.createElement('div');
  seeds.className = 'seeds';

  for (const text of SEEDS) {
    const seed = document.createElement('button');
    seed.type = 'button';
    seed.textContent = text;
    seed.addEventListener('click', () => {
      prompt.value = text;
      grow();
      prompt.focus();
    });
    seeds.append(seed);
  }

  box.append(title, copy, seeds);
  log.append(box);
}

/** Turns a tool call into something a person reads: `Read src/agent.ts`. */
function describe(name, raw) {
  let args = {};
  try {
    args = JSON.parse(raw || '{}');
  } catch {
    args = {};
  }

  switch (name) {
    case 'read_file':
      return `Read ${args.path ?? ''}`;
    case 'write_file':
      return `Wrote ${args.path ?? ''}`;
    case 'delete_file':
      return `Deleted ${args.path ?? ''}`;
    case 'list_dir':
      return `Listed ${args.path || '.'}`;
    case 'run_command':
      return `$ ${args.command ?? ''}`;
    default:
      return `${name} ${raw}`.trim();
  }
}

function activity({ name, args }) {
  document.getElementById('blank')?.remove();

  const row = document.createElement('div');
  row.className = 'act running';

  const dot = document.createElement('span');
  dot.className = 'dot';

  const what = document.createElement('span');
  what.className = 'what';
  what.textContent = describe(name, args);

  row.append(dot, what);

  const out = document.createElement('pre');
  out.className = 'out';
  out.hidden = true;

  row.addEventListener('click', () => {
    out.hidden = !out.hidden;
  });

  log.append(row, out);

  return {
    settle(text, failed) {
      row.className = failed ? 'act failed' : 'act done';
      out.textContent = text || '(no output)';
      if (failed) out.hidden = false;
    },
  };
}

function thinking() {
  const el = document.createElement('details');
  el.className = 'think';

  const summary = document.createElement('summary');
  summary.textContent = 'Thinking';

  const body = document.createElement('pre');
  el.append(summary, body);
  log.append(el);

  return {
    add(text) {
      body.textContent += text;
    },
  };
}

/** One render a frame, so a long reply does not reparse per token. */
function draw() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (openBubble) openBubble.replaceChildren(renderMarkdown(openRaw));
    stick();
  });
}

function closeBubble() {
  if (frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  if (openBubble) openBubble.replaceChildren(renderMarkdown(openRaw));
  openBubble = null;
  openRaw = '';
}

function updateMentions() {
  const token = tokenAtCursor();
  if (!token) return hideMentions();

  const query = token.query.toLowerCase();
  matches = files.filter((path) => path.toLowerCase().includes(query)).slice(0, 8);
  if (!matches.length) return hideMentions();

  highlighted = 0;
  renderMentions();
}

/** The @token the caret sits in, if any. */
function tokenAtCursor() {
  const upto = prompt.value.slice(0, prompt.selectionStart);
  const found = /@([^\s@]*)$/.exec(upto);
  return found ? { query: found[1], start: found.index } : null;
}

function renderMentions() {
  mentions.replaceChildren(
    ...matches.map((path, i) => {
      const row = document.createElement('div');
      row.className = i === highlighted ? 'mention on' : 'mention';
      row.textContent = path;
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        accept(path);
      });
      return row;
    }),
  );
  mentions.hidden = false;
}

function hideMentions() {
  mentions.hidden = true;
  mentions.replaceChildren();
  matches = [];
}

function accept(path) {
  const token = tokenAtCursor();
  if (!token) return;

  const before = prompt.value.slice(0, token.start);
  const after = prompt.value.slice(prompt.selectionStart);
  prompt.value = `${before}@${path} ${after}`;

  const caret = before.length + path.length + 2;
  prompt.setSelectionRange(caret, caret);
  hideMentions();
  grow();
  prompt.focus();
}

/** Vendor prefixes eat width a sidebar does not have. */
function short(name) {
  return name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
}

function fill(select, entries, selected, empty) {
  if (!entries.length) {
    const placeholder = document.createElement('option');
    placeholder.textContent = empty;
    placeholder.disabled = true;
    placeholder.selected = true;
    select.replaceChildren(placeholder);
    return;
  }

  select.replaceChildren(
    ...entries.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = value === selected;
      return option;
    }),
  );
}

/** Endpoints are objects, so the settings UI would otherwise be raw JSON. */
function renderSettings() {
  settings.replaceChildren();

  const promptTitle = document.createElement('h2');
  promptTitle.textContent = 'System prompt';
  settings.append(promptTitle);

  const promptNote = document.createElement('p');
  promptNote.textContent = 'Sent ahead of every message, in this and existing chats.';
  settings.append(promptNote);

  const promptBox = document.createElement('textarea');
  promptBox.className = 'prompt-edit';
  promptBox.rows = 6;
  promptBox.value = systemPrompt;
  promptBox.addEventListener('input', () => {
    systemPrompt = promptBox.value;
  });
  settings.append(promptBox);

  appendTelemetry(settings);

  const title = document.createElement('h2');
  title.textContent = 'Endpoints';
  settings.append(title);

  const note = document.createElement('p');
  note.textContent = 'Any server speaking the OpenAI chat API. Leave the key empty for local ones.';
  settings.append(note);

  endpoints.forEach((endpoint, i) => {
    const card = document.createElement('div');
    card.className = endpoint.name === activeEndpoint ? 'endpoint on' : 'endpoint';

    if (endpoints.length > 1) {
      const use = document.createElement('label');
      use.className = 'use';

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'active-endpoint';
      radio.checked = endpoint.name === activeEndpoint;
      radio.addEventListener('change', () => {
        activeEndpoint = endpoint.name;
        renderSettings();
      });

      const caption = document.createElement('span');
      caption.textContent = 'Use this endpoint';

      use.append(radio, caption);
      card.append(use);
    }

    const serves = modelRefs.filter((m) => m.endpoint === endpoint.name).map((m) => short(m.model));
    const serving = document.createElement('div');
    serving.className = 'serving';
    serving.textContent = serves.length ? serves.join(', ') : 'not reachable';
    card.append(serving);

    for (const [key, label, type] of [
      ['name', 'Name', 'text'],
      ['baseUrl', 'Base URL', 'text'],
      ['apiKey', 'API key', 'password'],
    ]) {
      const field = document.createElement('label');

      const caption = document.createElement('span');
      caption.textContent = label;

      const input = document.createElement('input');
      input.type = type;
      input.value = endpoint[key] ?? '';
      input.placeholder = key === 'baseUrl' ? 'https://host/v1' : '';
      input.addEventListener('input', () => {
        endpoints[i][key] = input.value;
      });

      field.append(caption, input);
      card.append(field);
    }

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'quiet';
    drop.textContent = 'Remove';
    drop.addEventListener('click', () => {
      endpoints.splice(i, 1);
      renderSettings();
    });

    card.append(drop);
    settings.append(card);
  });

  const row = document.createElement('div');
  row.className = 'actions';

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'quiet';
  add.textContent = 'Add endpoint';
  add.addEventListener('click', () => {
    endpoints.push({ name: '', baseUrl: '', apiKey: '' });
    renderSettings();
  });

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = 'Save';
  save.addEventListener('click', () => {
    vscode.postMessage({
      type: 'saveConfig',
      endpoints,
      systemPrompt,
      active: activeEndpoint || endpoints[0]?.name || '',
      telemetry: {
        enabled: telemetry.enabled,
        endpoint: telemetry.endpoint,
        headers: telemetry.headers,
        serviceName: telemetry.serviceName,
        resourceAttributes: telemetry.resourceAttributes,
      },
    });
    show('log');
  });

  row.append(add, save);
  settings.append(row);
}

/** Optional OTLP traces: where they go, and whether they are going. */
function appendTelemetry(target) {
  const title = document.createElement('h2');
  title.textContent = 'Telemetry';
  target.append(title);

  const note = document.createElement('p');
  note.textContent =
    'Record each turn as an OTLP trace. Off by default; nothing leaves this machine until you turn it on and set an endpoint.';
  target.append(note);

  const card = document.createElement('div');
  card.className = telemetry.enabled ? 'endpoint on' : 'endpoint';

  const toggle = document.createElement('label');
  toggle.className = 'toggle';

  const on = document.createElement('input');
  on.type = 'checkbox';
  on.checked = telemetry.enabled;
  on.addEventListener('change', () => {
    telemetry.enabled = on.checked;
    card.className = telemetry.enabled ? 'endpoint on' : 'endpoint';
    refresh();
  });

  const toggleCaption = document.createElement('span');
  toggleCaption.textContent = 'Record turns as traces';
  toggle.append(on, toggleCaption);
  card.append(toggle);

  for (const [key, label, placeholder] of [
    ['endpoint', 'Endpoint', 'https://host'],
    ['headers', 'Headers', 'x-api-key=…'],
    ['serviceName', 'Service name', 'daisy'],
    ['resourceAttributes', 'Resource attributes', 'dataset=daisy-{workspace}'],
  ]) {
    const field = document.createElement('label');

    const caption = document.createElement('span');
    caption.textContent = label;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = telemetry[key] ?? '';
    input.placeholder = placeholder;
    input.addEventListener('input', () => {
      telemetry[key] = input.value;
      refresh();
    });

    field.append(caption, input);
    card.append(field);
  }

  const status = document.createElement('div');
  status.className = 'status';
  card.append(status);

  function refresh() {
    const endpoint = telemetry.active || telemetry.endpoint.trim();
    let text;
    if (!telemetry.enabled) text = 'Off — nothing leaves this machine.';
    else if (!endpoint) text = 'On, but no endpoint: set one here or OTEL_EXPORTER_OTLP_ENDPOINT.';
    else text = 'Sending to ' + endpoint;
    if (telemetry.enabled && telemetry.pending > 0) text += ' · ' + telemetry.pending + ' waiting to deliver';
    status.textContent = text;
    status.classList.toggle('on', telemetry.enabled && Boolean(endpoint));
  }
  refresh();

  target.append(card);
}

/** Chats as a browsable list: recency groups, turn counts, delete on the row. */
function renderChats() {
  chats.replaceChildren();

  const title = document.createElement('h2');
  title.textContent = 'Chats';
  chats.append(title);

  if (!chatList.length) {
    const none = document.createElement('p');
    none.textContent = 'No chats yet.';
    chats.append(none);
    return;
  }

  let bucket = '';
  for (const chat of chatList) {
    const group = groupOf(chat.updatedAt);
    if (group !== bucket) {
      bucket = group;
      const heading = document.createElement('div');
      heading.className = 'group';
      heading.textContent = group;
      chats.append(heading);
    }

    const live = running.includes(chat.id);

    const row = document.createElement('div');
    row.className = `chat${chat.id === activeChat ? ' on' : ''}${live ? ' live' : ''}`;

    const state = document.createElement('span');
    state.className = 'state';
    state.title = live ? 'Working' : 'Idle';

    const text = document.createElement('div');
    text.className = 'text';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = chat.title;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = live
      ? 'working'
      : `${chat.turns} ${chat.turns === 1 ? 'message' : 'messages'} · ${ago(chat.updatedAt)}`;

    text.append(name, meta);

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'drop';
    drop.title = 'Delete chat';
    drop.textContent = '×';
    drop.addEventListener('click', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'deleteChat', id: chat.id });
    });

    row.append(state, text, drop);
    row.addEventListener('click', () => {
      vscode.postMessage({ type: 'session', id: chat.id });
    });

    chats.append(row);
  }
}

function groupOf(at) {
  const days = daysAgo(at);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return 'Older';
}

function daysAgo(at) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return Math.max(0, Math.ceil((midnight.getTime() - at) / 86400000));
}

function ago(at) {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle('busy', value);
  titleBtn.classList.toggle('running', value);
  stop.hidden = !value;
}

function grow() {
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`;
}

const jump = document.createElement('button');
jump.type = 'button';
jump.id = 'jump';
jump.hidden = true;
jump.title = 'Jump to latest';
jump.textContent = '↓';
jump.addEventListener('click', () => {
  follow = true;
  stick();
});
form.append(jump);

blank();
grow();
vscode.postMessage({ type: 'ready' });
