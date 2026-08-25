import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LIMITS, expandMentions, TOOLS } from './tools.ts';

const root = tmpdir();
const ctx = { root, limits: DEFAULT_LIMITS };
const tool = (name: string) => {
  const found = TOOLS.get(name);
  assert.ok(found, `missing tool ${name}`);
  return found;
};

const scratch = () => mkdtemp(join(tmpdir(), 'daisy-'));

test('rejects paths that escape the workspace', async () => {
  for (const path of ['../secrets', 'a/../../secrets', '/etc/passwd']) {
    await assert.rejects(() => tool('read_file').run({ path }, ctx), /outside workspace/);
  }
});

test('rejects arguments of the wrong type', async () => {
  await assert.rejects(() => tool('read_file').run({ path: 42 }, ctx), /must be a string/);
});

test('inlines the contents of an @-mentioned file', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'note.txt'), 'hello', 'utf8');

  const out = await expandMentions('explain @note.txt please', { root: dir, limits: DEFAULT_LIMITS });

  assert.ok(out.includes('<file path="note.txt">\nhello\n</file>'));
  assert.ok(out.endsWith('explain @note.txt please'));
});

test('inlines each mentioned file once', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'a.txt'), 'A', 'utf8');

  const out = await expandMentions('@a.txt and @a.txt again', { root: dir, limits: DEFAULT_LIMITS });

  assert.equal(out.split('<file path="a.txt">').length - 1, 1);
});

test('leaves mentions that escape the workspace as plain text', async () => {
  const dir = await scratch();
  const text = 'read @../../.ssh/id_rsa';

  assert.equal(await expandMentions(text, { root: dir, limits: DEFAULT_LIMITS }), text);
});

test('leaves a mention with no matching file alone', async () => {
  const dir = await scratch();
  const text = 'ping me@example.com';

  assert.equal(await expandMentions(text, { root: dir, limits: DEFAULT_LIMITS }), text);
});
