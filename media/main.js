const vscode = acquireVsCodeApi();

const log = document.getElementById('log');
const form = document.getElementById('composer');
const prompt = document.getElementById('prompt');
const submit = document.getElementById('submit');
const model = document.getElementById('model');
const refresh = document.getElementById('refresh');

const cards = new Map();
let openBubble = null;
let busy = false;

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
  setBusy(true);
  vscode.postMessage({ type: 'send', text });
});

refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

model.addEventListener('change', () => vscode.postMessage({ type: 'model', name: model.value }));

prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

window.addEventListener('message', ({ data }) => {
  switch (data.type) {
    case 'text':
      if (!openBubble) openBubble = bubble('assistant');
      openBubble.textContent += data.text;
      break;

    case 'tool':
      openBubble = null;
      cards.set(data.id, toolCard(data));
      break;

    case 'result':
      cards.get(data.id)?.settle(data.output, data.failed);
      cards.delete(data.id);
      break;

    case 'approve':
      openBubble = null;
      requestApproval(data);
      break;

    case 'status':
      openBubble = null;
      bubble('status').textContent = data.text;
      break;

    case 'models':
      fillModels(data.items, data.selected);
      break;

    case 'done':
      openBubble = null;
      setBusy(false);
      break;
  }

  log.scrollTop = log.scrollHeight;
});

function fillModels(items, selected) {
  const options = !selected || items.includes(selected) ? items : [selected, ...items];

  if (!options.length) {
    const empty = document.createElement('option');
    empty.textContent = 'no models found';
    empty.disabled = true;
    empty.selected = true;
    model.replaceChildren(empty);
    return;
  }

  model.replaceChildren(
    ...options.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      option.selected = name === selected;
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

  for (const [label, ok] of [['Allow', true], ['Deny', false]]) {
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
