import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const run = promisify(exec);

const MAX_READ = 64 * 1024;
const COMMAND_TIMEOUT = 120_000;

export type Args = Record<string, unknown>;

export interface Tool {
  spec: unknown;
  approve: boolean;
  run(args: Args, root: string): Promise<string>;
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
      approve: false,
      async run(args, root) {
        const body = await fs.readFile(resolve(root, str(args, 'path')), 'utf8');
        return body.length > MAX_READ ? `${body.slice(0, MAX_READ)}\n\n[truncated]` : body;
      },
    },
  ],
  [
    'list_dir',
    {
      spec: spec('list_dir', 'List a directory. Defaults to the workspace root.', { path: text }, []),
      approve: false,
      async run(args, root) {
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
      approve: true,
      async run(args, root) {
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
      approve: true,
      async run(args, root) {
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
      approve: true,
      async run(args, root) {
        const command = str(args, 'command');
        try {
          const { stdout, stderr } = await run(command, {
            cwd: root,
            timeout: COMMAND_TIMEOUT,
            maxBuffer: 1 << 20,
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
