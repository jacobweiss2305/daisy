// A small markdown subset, rendered to DOM nodes rather than HTML. Model output
// is never parsed as markup, so there is nothing to sanitise.

const FENCE = /^```(\w*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^(?:---+|\*\*\*+|___+)\s*$/;
const ROW = /^\s*\|.*$/;
const SEP_CELL = /^:?-+:?$/;

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
const LINK = /^\[([^\]]+)\]\((.+)\)$/;

function renderMarkdown(source) {
  const out = document.createDocumentFragment();
  const lines = source.split('\n');
  let at = 0;

  while (at < lines.length) {
    const line = lines[at];

    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      at += 1;
      while (at < lines.length && !FENCE.test(lines[at])) {
        body.push(lines[at]);
        at += 1;
      }
      at += 1;
      out.append(codeBlock(body.join('\n'), fence[1]));
      continue;
    }

    if (ROW.test(line) && at + 1 < lines.length && isSeparator(lines[at + 1])) {
      const header = cellsOf(line);
      const aligns = cellsOf(lines[at + 1]).map(alignOf);
      at += 2;

      const body = [];
      while (at < lines.length && ROW.test(lines[at])) {
        body.push(cellsOf(lines[at]));
        at += 1;
      }

      out.append(table(header, aligns, body));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const el = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      inline(heading[2], el);
      out.append(el);
      at += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.append(document.createElement('hr'));
      at += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (at < lines.length && QUOTE.test(lines[at])) {
        body.push(QUOTE.exec(lines[at])[1]);
        at += 1;
      }
      const el = document.createElement('blockquote');
      el.append(renderMarkdown(body.join('\n')));
      out.append(el);
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = !BULLET.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');

      while (at < lines.length) {
        const match = ordered ? NUMBERED.exec(lines[at]) : BULLET.exec(lines[at]);
        if (!match) break;
        const item = document.createElement('li');
        inline(match[1], item);
        list.append(item);
        at += 1;
      }

      out.append(list);
      continue;
    }

    if (!line.trim()) {
      at += 1;
      continue;
    }

    // Taken unconditionally: a line no block claimed must still be consumed,
    // or a prefix that ends mid-block spins here forever.
    const paragraph = [lines[at]];
    at += 1;
    while (at < lines.length && lines[at].trim() && !blockStart(lines[at])) {
      paragraph.push(lines[at]);
      at += 1;
    }

    const el = document.createElement('p');
    inline(paragraph.join('\n'), el);
    out.append(el);
  }

  return out;
}

function blockStart(line) {
  return (
    ROW.test(line) ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line)
  );
}

/** `| a | b |` without the outer pipes, trimmed. */
function cellsOf(line) {
  let rest = line.trim();
  if (rest.startsWith('|')) rest = rest.slice(1);
  if (rest.endsWith('|')) rest = rest.slice(0, -1);
  return rest.split('|').map((cell) => cell.trim());
}

function isSeparator(line) {
  if (!ROW.test(line)) return false;
  const cells = cellsOf(line);
  return cells.length > 0 && cells.every((cell) => SEP_CELL.test(cell));
}

function alignOf(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return '';
}

function table(header, aligns, body) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';

  const el = document.createElement('table');

  const head = document.createElement('thead');
  head.append(rowOf(header, aligns, 'th'));
  el.append(head);

  if (body.length) {
    const rows = document.createElement('tbody');
    for (const cells of body) rows.append(rowOf(cells, aligns, 'td'));
    el.append(rows);
  }

  wrap.append(el);
  return wrap;
}

function rowOf(cells, aligns, tag) {
  const row = document.createElement('tr');

  cells.forEach((text, i) => {
    const cell = document.createElement(tag);
    if (aligns[i]) cell.style.textAlign = aligns[i];
    inline(text, cell);
    row.append(cell);
  });

  return row;
}

function codeBlock(text, language) {
  const pre = document.createElement('pre');
  pre.className = 'code';

  const code = document.createElement('code');
  code.textContent = text;
  if (language) code.dataset.language = language;

  pre.append(code);
  return pre;
}

/** Splits a run of text into emphasis, code, and link spans. */
function inline(text, parent) {
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parent.append(text.slice(last, match.index));

    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith('[')) {
      parent.append(link(token));
    } else {
      const em = document.createElement('em');
      em.textContent = token.slice(1, -1);
      parent.append(em);
    }

    last = match.index + token.length;
  }

  if (last < text.length) parent.append(text.slice(last));
}

/** Only http and https become anchors; anything else stays literal text. */
function link(token) {
  const [, label, href] = LINK.exec(token);

  if (!/^https?:\/\//i.test(href)) return token;

  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.textContent = label;
  return anchor;
}
