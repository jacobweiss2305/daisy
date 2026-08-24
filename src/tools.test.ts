import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expandMentions, TOOLS } from './tools.ts';

const root = tmpdir();
const tool = (name: string) => {
  const found = TOOLS.get(name);
  assert.ok(found, `missing tool ${name}`);
  return found;
};

const scratch = () => mkdtemp(join(tmpdir(), 'daisy-'));

test('rejects paths that escape the workspace', async () => {
  for (const path of ['../secrets', 'a/../../secrets', '/etc/passwd']) {
    await assert.rejects(() => tool('read_file').run({ path }, root), /outside workspace/);
  }
});

test('rejects arguments of the wrong type', async () => {
  await assert.rejects(() => tool('read_file').run({ path: 42 }, root), /must be a string/);
});

test('requires approval for everything that mutates', () => {
  const approved = [...TOOLS].filter(([, t]) => t.approve).map(([name]) => name);
  assert.deepEqual(approved.sort(), ['delete_file', 'run_command', 'write_file']);
});

test('inlines the contents of an @-mentioned file', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'note.txt'), 'hello', 'utf8');

  const out = await expandMentions('explain @note.txt please', dir);

  assert.ok(out.includes('<file path="note.txt">\nhello\n</file>'));
  assert.ok(out.endsWith('explain @note.txt please'));
});

test('inlines each mentioned file once', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'a.txt'), 'A', 'utf8');

  const out = await expandMentions('@a.txt and @a.txt again', dir);

  assert.equal(out.split('<file path="a.txt">').length - 1, 1);
});

test('leaves mentions that escape the workspace as plain text', async () => {
  const dir = await scratch();
  const text = 'read @../../.ssh/id_rsa';

  assert.equal(await expandMentions(text, dir), text);
});

test('leaves a mention with no matching file alone', async () => {
  const dir = await scratch();
  const text = 'ping me@example.com';

  assert.equal(await expandMentions(text, dir), text);
});
