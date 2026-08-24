import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { TOOLS } from './tools.ts';

const root = tmpdir();
const tool = (name: string) => {
  const found = TOOLS.get(name);
  assert.ok(found, `missing tool ${name}`);
  return found;
};

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
