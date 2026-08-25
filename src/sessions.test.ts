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

test('the first read creates an empty session', () => {
  const sessions = new Sessions(memory());
  const first = sessions.active();

  assert.equal(sessions.list().length, 1);
  assert.deepEqual(first.messages, []);
});

test('active returns the same session until another is selected', () => {
  const sessions = new Sessions(memory());
  const first = sessions.active();
  first.messages.push({ role: 'user', content: 'keep me' });
  sessions.save(first);

  const second = sessions.create();

  assert.notEqual(first.id, second.id);
  assert.equal(sessions.active().id, second.id);
  assert.equal(sessions.select(first.id).id, first.id);
});

test('new sessions land at the top of the list', () => {
  const sessions = new Sessions(memory());
  sessions.create();
  const newest = sessions.create();

  assert.equal(sessions.list()[0]?.id, newest.id);
});

test('saving names the session after its first user message', () => {
  const sessions = new Sessions(memory());
  const session = sessions.active();

  session.messages.push({ role: 'user', content: '  fix   the parser  ' });
  sessions.save(session);

  assert.equal(sessions.list()[0]?.title, 'fix the parser');
});

test('titles collapse whitespace and clip long messages', () => {
  const long = 'x'.repeat(80);
  assert.equal(titleOf({ id: 'a', title: '', updatedAt: 0, messages: [{ role: 'user', content: long }] }).length, 47);
  assert.equal(titleOf({ id: 'a', title: '', updatedAt: 0, messages: [] }), 'New chat');
});

test('a new chat drops an earlier one that was never used', () => {
  const sessions = new Sessions(memory());
  const untouched = sessions.active();
  const second = sessions.create();

  assert.equal(sessions.list().length, 1);
  assert.equal(sessions.list()[0]?.id, second.id);
  assert.ok(!sessions.list().some((s) => s.id === untouched.id));
});

test('a chat with a message survives the next new chat', () => {
  const sessions = new Sessions(memory());
  const used = sessions.active();
  used.messages.push({ role: 'user', content: 'hello' });
  sessions.save(used);

  const fresh = sessions.create();

  assert.deepEqual(
    sessions.list().map((s) => s.id),
    [fresh.id, used.id],
  );
});

test('removing the active chat moves to another', () => {
  const sessions = new Sessions(memory());
  const first = sessions.active();
  first.messages.push({ role: 'user', content: 'keep me' });
  sessions.save(first);

  const second = sessions.create();
  sessions.remove(second.id);

  assert.equal(sessions.list().length, 1);
  assert.equal(sessions.active().id, first.id);
});

test('saving stamps the chat so it can be ordered by recency', () => {
  const sessions = new Sessions(memory());
  const session = sessions.active();
  session.messages.push({ role: 'user', content: 'x' });
  sessions.save(session);

  assert.ok((sessions.list()[0]?.updatedAt ?? 0) > 0);
});
