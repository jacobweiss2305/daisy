// A small markdown subset, rendered to DOM nodes rather than HTML. Model output
// is never parsed as markup, so there is nothing to sanitise.

const FENCE = /^```(\w*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^(?:---+|\*\*\*+|___+)\s*$/;

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

    const paragraph = [];
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
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line)
  );
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
