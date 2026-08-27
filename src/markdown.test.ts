import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Enough of the DOM for the renderer to build a tree we can read back. */
class Fake {
  tag: string;
  children: (Fake | string)[] = [];
  dataset: Record<string, string> = {};
  className = '';
  href = '';
  style: Record<string, string> = {};

  constructor(tag: string) {
    this.tag = tag;
  }

  append(...items: (Fake | string)[]): void {
    this.children.push(...items);
  }

  set textContent(value: string) {
    this.children = [value];
  }
}

const documentShim = {
  createElement: (tag: string): Fake => new Fake(tag),
  createDocumentFragment: (): Fake => new Fake('#fragment'),
};

const source = readFileSync(join(process.cwd(), 'media', 'markdown.js'), 'utf8');
const render = new Function('document', `${source}\nreturn renderMarkdown;`)(documentShim) as (
  text: string,
) => Fake;

/** `p[hello code[x]]`, so element tags cannot be confused with literal angle brackets. */
function show(node: Fake | string): string {
  if (typeof node === 'string') return node;
  const inner = node.children.map(show).join('');
  return node.tag === '#fragment' ? inner : `${node.tag}[${inner}]`;
}

const md = (text: string): string => show(render(text));

test('renders fenced code as a pre/code pair, keeping the body verbatim', () => {
  assert.equal(md('```ts\nconst a = 1;\n```'), 'pre[code[const a = 1;]]');
});

test('renders inline code, bold, and italic', () => {
  assert.equal(md('use `run` and **stop** or *maybe*'), 'p[use code[run] and strong[stop] or em[maybe]]');
});

test('renders bullet and numbered lists', () => {
  assert.equal(md('- one\n- two'), 'ul[li[one]li[two]]');
  assert.equal(md('1. one\n2. two'), 'ol[li[one]li[two]]');
});

test('renders headings and rules', () => {
  assert.equal(md('# Title'), 'h3[Title]');
  assert.equal(md('---'), 'hr[]');
});

test('renders blockquotes by parsing their contents', () => {
  assert.equal(md('> quoted **bit**'), 'blockquote[p[quoted strong[bit]]]');
});

test('links only http and https, leaving other schemes as text', () => {
  assert.equal(md('[docs](https://example.com)'), 'p[a[docs]]');
  assert.equal(md('[x](javascript:alert(1))'), 'p[[x](javascript:alert(1))]');
});

test('treats markup in model output as text, not elements', () => {
  const out = md('<script>alert(1)</script> and <img onerror=x>');

  assert.ok(out.includes('<script>alert(1)</script>'));
  assert.ok(!out.includes('script['));
  assert.ok(!out.includes('img['));
});

test('separates paragraphs on blank lines', () => {
  assert.equal(md('one\n\ntwo'), 'p[one]p[two]');
});

test('does not swallow a paragraph that runs into a list', () => {
  assert.equal(md('intro\n- a'), 'p[intro]ul[li[a]]');
});

test('renders an unterminated fence rather than dropping it', () => {
  assert.equal(md('```\nhalf written'), 'pre[code[half written]]');
});

const HEAD = '| File | What |\n| --- | --- |\n';

test('renders a table with a header and body', () => {
  assert.equal(
    md(`${HEAD}| a.ts | new |\n| b.ts | hooks |`),
    'div[table[thead[tr[th[File]th[What]]]tbody[tr[td[a.ts]td[new]]tr[td[b.ts]td[hooks]]]]]',
  );
});

test('formats inside table cells', () => {
  assert.equal(
    md(`${HEAD}| \`src/otel.ts\` | **new** |`),
    'div[table[thead[tr[th[File]th[What]]]tbody[tr[td[code[src/otel.ts]]td[strong[new]]]]]]',
  );
});

test('honours column alignment', () => {
  const root = render('| l | c | r |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |');
  const table = root.children[0] as Fake;
  const head = (table.children[0] as Fake).children[0] as Fake;
  const cells = (head.children[0] as Fake).children as Fake[];

  assert.deepEqual(
    cells.map((c) => c.style.textAlign ?? ''),
    ['', 'center', 'right'],
  );
});

test('renders a header-only table', () => {
  assert.equal(md(HEAD.trimEnd()), 'div[table[thead[tr[th[File]th[What]]]]]');
});

test('leaves pipes alone when no separator row follows', () => {
  assert.equal(md('a | b | c'), 'p[a | b | c]');
});

test('does not treat a rule as a table separator', () => {
  assert.equal(md('---'), 'hr[]');
});

test('renders a row that never gets its separator as text', () => {
  assert.equal(md('| File | What |'), 'p[| File | What |]');
});

/**
 * The webview re-renders on every frame while a reply streams, so the parser
 * is handed every prefix of the document, not just the finished one. A prefix
 * that ends mid-block used to leave `at` where it was and spin.
 */
test('terminates on every prefix of a document', () => {
  const doc = '# Title\n\nprose\n\n| File | What |\n|---|---|\n| a | b |\n\n- item\n- item\n\n> quote\n\n```js\nx\n```\n';
  for (let cut = 1; cut <= doc.length; cut += 1) md(doc.slice(0, cut));
});
