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
