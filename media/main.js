const vscode = acquireVsCodeApi();

const log = document.getElementById('log');
const form = document.getElementById('composer');
const prompt = document.getElementById('prompt');
const submit = document.getElementById('submit');
const model = document.getElementById('model');
const refresh = document.getElementById('refresh');
const session = document.getElementById('session');
const startNew = document.getElementById('new');
const mentions = document.getElementById('mentions');

const cards = new Map();
let files = [];
let matches = [];
let highlighted = 0;
let openBubble = null;
let openThink = null;
let busy = false;

refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
startNew.addEventListener('click', () => vscode.postMessage({ type: 'new' }));
model.addEventListener('change', () => vscode.postMessage({ type: 'model', name: model.value }));
session.addEventListener('change', () => vscode.postMessage({ type: 'session', id: session.value }));

form.addEventListener('submit', (event) => {
  event.preventDefault();

  if (busy) {
    vscode.postMessage({ type: 'cancel' });
    return;
  }

  const text = prompt.value.trim();
  if (!text) return;

  bubble('user').textContent = text;
  prompt.value = '';
  hideMentions();
  setBusy(true);
  vscode.postMessage({ type: 'send', text });
});

prompt.addEventListener('input', updateMentions);

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
      if (!openBubble) openBubble = bubble('assistant');
      openBubble.textContent += data.text;
      break;

    case 'think':
      openBubble = null;
      if (!openThink) openThink = thinkBlock();
      openThink.append(data.text);
      break;

    case 'tool':
      openBubble = null;
      openThink = null;
      cards.set(data.id, toolCard(data));
      break;

    case 'result':
      cards.get(data.id)?.settle(data.output, data.failed);
      cards.delete(data.id);
      break;

    case 'approve':
      openBubble = null;
      openThink = null;
      requestApproval(data);
      break;

    case 'status':
      openBubble = null;
      openThink = null;
      bubble('status').textContent = data.text;
      break;

    case 'models':
      fill(model, options(data.items, data.selected), data.selected, 'no models found');
      break;

    case 'sessions':
      fill(
        session,
        data.items.map((s) => ({ value: s.id, label: s.title })),
        data.active,
        'no chats',
      );
      break;

    case 'history':
      log.replaceChildren();
      cards.clear();
      openBubble = null;
      openThink = null;
      for (const item of data.items) bubble(item.role).textContent = item.text;
      break;

    case 'files':
      files = data.items;
      break;

    case 'done':
      openBubble = null;
      openThink = null;
      setBusy(false);
      break;
  }

  log.scrollTop = log.scrollHeight;
});

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
  prompt.focus();
}

function options(items, selected) {
  const all = !selected || items.includes(selected) ? items : [selected, ...items];
  return all.map((name) => ({ value: name, label: name }));
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

function bubble(role) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  log.append(el);
  return el;
}

function thinkBlock() {
  const el = document.createElement('details');
  el.className = 'think';

  const summary = document.createElement('summary');
  summary.textContent = 'Thinking';

  const body = document.createElement('pre');
  el.append(summary, body);
  log.append(el);

  return {
    append(text) {
      body.textContent += text;
    },
  };
}

function toolCard({ name, args }) {
  const el = document.createElement('details');
  el.className = 'tool';

  const summary = document.createElement('summary');
  summary.textContent = `${name} ${oneLine(args)}`;

  const output = document.createElement('pre');
  output.textContent = 'running';

  el.append(summary, output);
  log.append(el);

  return {
    settle(text, failed) {
      el.classList.toggle('failed', failed);
      output.textContent = text || '(empty)';
    },
  };
}

function requestApproval({ id, name, args }) {
  const el = document.createElement('div');
  el.className = 'approve';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `Allow ${name}?`;

  const detail = document.createElement('pre');
  detail.textContent = indent(args);

  const row = document.createElement('div');
  row.className = 'row';

  for (const [label, ok] of [
    ['Allow', true],
    ['Deny', false],
  ]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'approval', id, ok });
      el.className = 'msg status';
      el.textContent = `${name} ${ok ? 'allowed' : 'denied'}`;
    });
    row.append(button);
  }

  el.append(title, detail, row);
  log.append(el);
}

function setBusy(value) {
  busy = value;
  submit.textContent = value ? 'Stop' : 'Send';
}

function indent(args) {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

function oneLine(args) {
  const flat = args.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}...` : flat;
}

vscode.postMessage({ type: 'ready' });
