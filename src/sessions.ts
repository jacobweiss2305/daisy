import { randomUUID } from 'node:crypto';
import type { Message } from './llm.ts';

export interface Session {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
}

/** The slice of vscode.Memento this needs, kept structural so it can be tested plainly. */
export interface Store {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

const ALL = 'daisy.sessions';
const ACTIVE = 'daisy.active';
export const DEFAULT_KEPT = 30;

export class Sessions {
  private readonly store: Store;
  private readonly kept: number;

  constructor(store: Store, kept: number = DEFAULT_KEPT) {
    this.store = store;
    this.kept = kept;
  }

  list(): Session[] {
    return this.store.get<Session[]>(ALL, []);
  }

  active(): Session {
    const all = this.list();
    const id = this.store.get<string>(ACTIVE, '');
    return all.find((s) => s.id === id) ?? all[0] ?? this.create();
  }

  /** Starting a chat clears out any earlier one that was never used. */
  create(): Session {
    const session: Session = {
      id: randomUUID(),
      title: 'New chat',
      updatedAt: Date.now(),
      messages: [],
    };

    const used = this.list().filter(started);
    void this.store.update(ALL, [session, ...used].slice(0, this.kept));
    void this.store.update(ACTIVE, session.id);
    return session;
  }

  remove(id: string): void {
    const left = this.list().filter((s) => s.id !== id);
    void this.store.update(ALL, left);

    if (this.store.get<string>(ACTIVE, '') === id) {
      void this.store.update(ACTIVE, left[0]?.id ?? '');
    }
  }

  select(id: string): Session {
    void this.store.update(ACTIVE, id);
    return this.active();
  }

  save(session: Session): void {
    session.title = titleOf(session);
    session.updatedAt = Date.now();
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

/** A chat the user actually said something in. */
export function started(session: Session): boolean {
  return session.messages.some((m) => m.role === 'user');
}
