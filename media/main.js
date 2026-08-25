const vscode = acquireVsCodeApi();

const log = document.getElementById('log');
const form = document.getElementById('composer');
const prompt = document.getElementById('prompt');
const submit = document.getElementById('submit');
const session = document.getElementById('session');
const startNew = document.getElementById('new');
const mentions = document.getElementById('mentions');
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
let endpoints = [];
let picked = { endpoint: '', model: '' };

startNew.addEventListener('click', () => vscode.postMessage({ type: 'new' }));

gear.addEventListener('click', () => {
  settings.hidden = !settings.hidden;
  log.hidden = !settings.hidden;
  if (settings.hidden) return;

  // Opening settings is the moment to re-read what each endpoint serves.
  vscode.postMessage({ type: 'refresh' });
  renderSettings();
});
session.addEventListener('change', () => vscode.postMessage({ type: 'session', id: session.value }));

form.addEventListener('submit', (event) => {
  event.preventDefault();

  if (busy) {
    vscode.postMessage({ type: 'cancel' });
    return;
  }

  const text = prompt.value.trim();
  if (!text) return;

  say('user', 'You').textContent = text;
  prompt.value = '';
  grow();
  hideMentions();
  setBusy(true);
  vscode.postMessage({ type: 'send', text });
});

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
      picked = data.selected;
      if (!settings.hidden) renderSettings();
      break;

    case 'sessions':
      fill(
        session,
        data.items.map((s) => ({ value: s.id, label: s.title })),
        data.active,
        'New chat',
      );
      break;

    case 'history':
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

    case 'endpoints':
      endpoints = data.items.map((e) => ({ ...e }));
      if (!settings.hidden) renderSettings();
      break;

    case 'done':
      closeBubble();
      openThink = null;
      setBusy(false);
      break;
  }

  log.scrollTop = log.scrollHeight;
});

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
    log.scrollTop = log.scrollHeight;
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

  const modelTitle = document.createElement('h2');
  modelTitle.textContent = 'Model';
  settings.append(modelTitle);

  const choose = document.createElement('select');
  choose.className = 'chooser';

  if (!modelRefs.length) {
    const none = document.createElement('option');
    none.textContent = 'no models found';
    none.disabled = true;
    none.selected = true;
    choose.append(none);
  } else {
    const spread = new Set(modelRefs.map((r) => r.endpoint)).size > 1;
    modelRefs.forEach((ref, i) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = spread ? `${short(ref.model)} · ${ref.endpoint}` : short(ref.model);
      option.selected = ref.endpoint === picked.endpoint && ref.model === picked.model;
      choose.append(option);
    });
  }

  choose.addEventListener('change', () => {
    const ref = modelRefs[Number(choose.value)];
    if (!ref) return;
    picked = ref;
    vscode.postMessage({ type: 'model', ref });
  });

  settings.append(choose);

  const title = document.createElement('h2');
  title.textContent = 'Endpoints';
  settings.append(title);

  const note = document.createElement('p');
  note.textContent = 'Any server speaking the OpenAI chat API. Leave the key empty for local ones.';
  settings.append(note);

  endpoints.forEach((endpoint, i) => {
    const card = document.createElement('div');
    card.className = 'endpoint';

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
    vscode.postMessage({ type: 'saveEndpoints', items: endpoints });
    settings.hidden = true;
    log.hidden = false;
  });

  row.append(add, save);
  settings.append(row);
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle('busy', value);
  submit.title = value ? 'Stop' : 'Send';
}

function grow() {
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`;
}

blank();
grow();
vscode.postMessage({ type: 'ready' });
