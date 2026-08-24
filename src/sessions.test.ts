import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sessions, titleOf, type Store } from './sessions.ts';

function memory(): Store {
  const held = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T): T => (held.has(key) ? (held.get(key) as T) : fallback),
    update: (key, value) => {
      held.set(key, value);
      return Promise.resolve();
    },
  };
}

test('the first read creates a session seeded with the system prompt', () => {
  const sessions = new Sessions(memory(), 'be helpful');
  const first = sessions.active();

  assert.equal(sessions.list().length, 1);
  assert.deepEqual(first.messages, [{ role: 'system', content: 'be helpful' }]);
});

test('active returns the same session until another is selected', () => {
  const sessions = new Sessions(memory(), 'sys');
  const first = sessions.active();
  const second = sessions.create();

  assert.notEqual(first.id, second.id);
  assert.equal(sessions.active().id, second.id);
  assert.equal(sessions.select(first.id).id, first.id);
});

test('new sessions land at the top of the list', () => {
  const sessions = new Sessions(memory(), 'sys');
  sessions.create();
  const newest = sessions.create();

  assert.equal(sessions.list()[0]?.id, newest.id);
});

test('saving names the session after its first user message', () => {
  const sessions = new Sessions(memory(), 'sys');
  const session = sessions.active();

  session.messages.push({ role: 'user', content: '  fix   the parser  ' });
  sessions.save(session);

  assert.equal(sessions.list()[0]?.title, 'fix the parser');
});

test('titles collapse whitespace and clip long messages', () => {
  const long = 'x'.repeat(80);
  assert.equal(titleOf({ id: 'a', title: '', messages: [{ role: 'user', content: long }] }).length, 47);
  assert.equal(titleOf({ id: 'a', title: '', messages: [] }), 'New chat');
});
