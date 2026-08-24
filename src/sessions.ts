import { randomUUID } from 'node:crypto';
import type { Message } from './llm.ts';

export interface Session {
  id: string;
  title: string;
  messages: Message[];
}

/** The slice of vscode.Memento this needs, kept structural so it can be tested plainly. */
export interface Store {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

const ALL = 'daisy.sessions';
const ACTIVE = 'daisy.active';
const KEEP = 30;

export class Sessions {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  list(): Session[] {
    return this.store.get<Session[]>(ALL, []);
  }

  active(): Session {
    const all = this.list();
    const id = this.store.get<string>(ACTIVE, '');
    return all.find((s) => s.id === id) ?? all[0] ?? this.create();
  }

  create(): Session {
    const session: Session = {
      id: randomUUID(),
      title: 'New chat',
      messages: [],
    };
    void this.store.update(ALL, [session, ...this.list()].slice(0, KEEP));
    void this.store.update(ACTIVE, session.id);
    return session;
  }

  select(id: string): Session {
    void this.store.update(ACTIVE, id);
    return this.active();
  }

  save(session: Session): void {
    session.title = titleOf(session);
    void this.store.update(
      ALL,
      this.list().map((s) => (s.id === session.id ? session : s)),
    );
  }
}

/** Names a session after its first user message. */
export function titleOf(session: Session): string {
  const first = session.messages.find((m) => m.role === 'user');
  if (!first) return 'New chat';

  const line = first.content.replace(/\s+/g, ' ').trim();
  if (!line) return 'New chat';
  return line.length > 44 ? `${line.slice(0, 44)}...` : line;
}
