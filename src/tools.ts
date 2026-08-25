import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const run = promisify(exec);

export type Args = Record<string, unknown>;

export interface Limits {
  /** Longest file body handed to the model before it is clipped. */
  fileBytes: number;
  /** How long a shell command may run. */
  commandTimeoutMs: number;
  /** Most output a shell command may produce. */
  outputBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  fileBytes: 64 * 1024,
  commandTimeoutMs: 120_000,
  outputBytes: 1024 * 1024,
};

export interface Context {
  root: string;
  limits: Limits;
}

export interface Tool {
  spec: unknown;
  run(args: Args, ctx: Context): Promise<string>;
}

function spec(name: string, description: string, properties: Args, required: string[]): unknown {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required },
    },
  };
}

function str(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string`);
  return value;
}

/** Resolves a workspace-relative path, refusing anything that escapes the root. */
function resolve(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`path outside workspace: ${rel}`);
  }
  return abs;
}

const text = { type: 'string' } as const;

export const TOOLS: ReadonlyMap<string, Tool> = new Map<string, Tool>([
  [
    'read_file',
    {
      spec: spec('read_file', 'Read a UTF-8 file.', { path: text }, ['path']),
      async run(args, { root, limits }) {
        const body = await fs.readFile(resolve(root, str(args, 'path')), 'utf8');
        return clip(body, limits.fileBytes);
      },
    },
  ],
  [
    'list_dir',
    {
      spec: spec('list_dir', 'List a directory. Defaults to the workspace root.', { path: text }, []),
      async run(args, { root }) {
        const rel = typeof args['path'] === 'string' ? args['path'] : '.';
        const entries = await fs.readdir(resolve(root, rel), { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join('\n') || '(empty)';
      },
    },
  ],
  [
    'write_file',
    {
      spec: spec('write_file', 'Create or overwrite a file.', { path: text, content: text }, [
        'path',
        'content',
      ]),
      async run(args, { root }) {
        const target = resolve(root, str(args, 'path'));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, str(args, 'content'), 'utf8');
        return `wrote ${path.relative(root, target)}`;
      },
    },
  ],
  [
    'delete_file',
    {
      spec: spec('delete_file', 'Delete a file or directory.', { path: text }, ['path']),
      async run(args, { root }) {
        const target = resolve(root, str(args, 'path'));
        await fs.rm(target, { recursive: true, force: true });
        return `deleted ${path.relative(root, target)}`;
      },
    },
  ],
  [
    'run_command',
    {
      spec: spec('run_command', 'Run a shell command in the workspace root.', { command: text }, [
        'command',
      ]),
      async run(args, { root, limits }) {
        const command = str(args, 'command');
        try {
          const { stdout, stderr } = await run(command, {
            cwd: root,
            timeout: limits.commandTimeoutMs,
            maxBuffer: limits.outputBytes,
          });
          return join(stdout, stderr) || '(no output)';
        } catch (e) {
          const failure = e as { stdout?: string; stderr?: string; message?: string };
          return join(failure.stdout, failure.stderr, failure.message) || 'command failed';
        }
      },
    },
  ],
]);

export const SPECS: readonly unknown[] = [...TOOLS.values()].map((t) => t.spec);

function join(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join('\n').trim();
}

const MENTION = /@([^\s@]+)/g;

/** Inlines the contents of @-mentioned files ahead of the user's text. */
export async function expandMentions(text: string, ctx: Context): Promise<string> {
  const { root, limits } = ctx;
  const paths = [...new Set([...text.matchAll(MENTION)].map((m) => m[1]).filter(Boolean))];
  const blocks: string[] = [];

  for (const rel of paths) {
    try {
      const body = await fs.readFile(resolve(root, rel as string), 'utf8');
      const clipped = clip(body, limits.fileBytes);
      blocks.push(`<file path="${rel}">\n${clipped}\n</file>`);
    } catch {
      // an unreadable mention stays plain text
    }
  }

  return blocks.length ? `${blocks.join('\n\n')}\n\n${text}` : text;
}

function clip(body: string, max: number): string {
  return body.length > max ? `${body.slice(0, max)}

[truncated]` : body;
}
