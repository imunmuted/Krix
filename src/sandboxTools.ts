import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execFileSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import {
  formatOptimizedResponse, formatError, getToolAnnotations, sanitizeCommand, sanitizePath,
  getSessionContext, updateSessionContext, deleteSessionContext, makeRegistrar, getAuthKeyForSession,
  sandboxRootPath, assertValidOwnerRepo, assertValidRef, assertValidPackageSpec
} from './security.js';
import {
  assertSandboxAllowed, getIsolation, runProc, runShell, spawnShell, spawnPersistentShell, killTree,
  buildSandboxEnv, ensureSandboxRoot, sandboxHome, sandboxTmp, scrubbedEnvForGit,
  sbxStat, sbxReadText, sbxWriteText, sbxMkdirp, sbxRemoveFile, sbxRemoveTree, assertInsideRealRoot,
  type RunResult
} from './sandboxProc.js';
import fsp from 'node:fs/promises';

interface ActiveProcess {
  pid: number;
  command: string;
  proc: ChildProcess;
  startTime: Date;
  status: 'running' | 'exited';
  exitCode: number | null;
  exitedAt: Date | null;
  stdout: string;
  stderr: string;
}

const OUT_CAP = 100000;
const BG_BUF_CAP = 200000;
const EXITED_TTL_MS = 10 * 60 * 1000;
const MAX_BG_PROCS = 8;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;

const processTables = new Map<string, Map<number, ActiveProcess>>();
function procTable(sessionId: string): Map<number, ActiveProcess> {
  const key = getAuthKeyForSession(sessionId);
  let t = processTables.get(key);
  if (!t) { t = new Map(); processTables.set(key, t); }
  return t;
}

const processTablePruneTimer = setInterval(() => {
  const now = Date.now();
  for (const table of processTables.values()) {
    for (const [pid, item] of table) {
      if (item.status === 'exited' && item.exitedAt && now - item.exitedAt.getTime() > EXITED_TTL_MS) table.delete(pid);
    }
  }
}, 5 * 60 * 1000);
processTablePruneTimer.unref();

function appendCapped(buf: string, chunk: string, cap: number = BG_BUF_CAP): string {
  const next = buf + chunk;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

interface CachedOutput { content: string; createdAt: number; }
const outputCache = new Map<string, Map<string, CachedOutput>>();
const OUTPUT_CACHE_TTL_MS = 15 * 60 * 1000;
const OUTPUT_CACHE_MAX_PER_SESSION = 10;

function cacheOutput(sessionId: string, content: string): string {
  let bucket = outputCache.get(sessionId);
  if (!bucket) { bucket = new Map(); outputCache.set(sessionId, bucket); }
  if (bucket.size >= OUTPUT_CACHE_MAX_PER_SESSION) {
    const oldest = [...bucket.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) bucket.delete(oldest[0]);
  }
  const id = crypto.randomBytes(6).toString('hex');
  bucket.set(id, { content, createdAt: Date.now() });
  return id;
}

function getCachedOutput(sessionId: string, id: string): string | undefined {
  return outputCache.get(sessionId)?.get(id)?.content;
}

const outputCachePruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [sid, bucket] of outputCache) {
    for (const [id, entry] of bucket) {
      if (now - entry.createdAt > OUTPUT_CACHE_TTL_MS) bucket.delete(id);
    }
    if (bucket.size === 0) outputCache.delete(sid);
  }
}, 5 * 60 * 1000);
outputCachePruneTimer.unref();

function truncWithCache(sessionId: string, s: string, cap: number = OUT_CAP): string {
  const clean = s.trim();
  if (!clean) return '';
  if (clean.length <= cap) return clean;
  const id = cacheOutput(sessionId, clean);
  return `${clean.slice(0, cap)}\n…[+${clean.length - cap} chars truncated — call sandbox_output({ outputId: "${id}", offset: ${cap} }) to continue reading; cached 15min]`;
}

function execResponse(sessionId: string, r: RunResult) {
  const out: Record<string, any> = {};
  const o = truncWithCache(sessionId, r.stdout || '');
  const e = truncWithCache(sessionId, r.stderr || '');
  if (o) out.stdout = o;
  if (e) out.stderr = e;
  if (r.spawnError) out.error = r.spawnError;
  if (r.timedOut) out.timedOut = true;
  if (r.truncated) out.outputTruncated = true;
  if (r.code !== 0) out.exit = r.code ?? r.signal ?? -1;
  return formatOptimizedResponse(Object.keys(out).length ? out : { stdout: '(ok, no output)' });
}

// ---------------------------------------------------------------------------------------------
// Sandbox directories
// ---------------------------------------------------------------------------------------------

async function sandboxRoot(sessionId: string): Promise<string> {
  assertSandboxAllowed();
  const dir = sandboxRootPath(sessionId);
  await ensureSandboxRoot(dir);
  return dir;
}

async function workDir(sessionId: string): Promise<string> {
  const root = await sandboxRoot(sessionId);
  const ctx = getSessionContext(sessionId);
  for (const candidate of [ctx.cwd, ctx.sandboxDir]) {
    if (!candidate) continue;
    try {
      const abs = sanitizePath(candidate, root);
      if ((await sbxStat(root, abs)).kind === 'directory') return abs;
    } catch {}
  }
  return root;
}

async function resolveDir(sessionId: string, dir?: string): Promise<string> {
  if (!dir) return workDir(sessionId);
  const root = await sandboxRoot(sessionId);
  const target = sanitizePath(dir, root);
  await assertInsideRealRoot(root, target);
  await sbxMkdirp(root, target);
  return target;
}

/** Resolve a file inside the caller's sandbox (used by sandbox_files). Never escapes the sandbox root. */
export async function resolveSandboxFile(sessionId: string, filePath: string, dir?: string): Promise<{ root: string; abs: string }> {
  const root = await sandboxRoot(sessionId);
  const base = await resolveDir(sessionId, dir);
  const abs = sanitizePath(filePath, base);
  await assertInsideRealRoot(root, abs);
  return { root, abs };
}

function envFor(sessionId: string, root: string): NodeJS.ProcessEnv {
  return buildSandboxEnv(root, getSessionContext(sessionId).env);
}

// ---------------------------------------------------------------------------------------------
// Persistent shell
// ---------------------------------------------------------------------------------------------

interface PersistentShell { proc: ChildProcess; buf: string; busy: boolean; }
const persistentShells = new Map<string, PersistentShell>();
const SHELL_HANG_MS = 60000;
const SHELL_BUF_CAP = 4 * 1024 * 1024;

function shellKey(sessionId: string): string {
  return `${getAuthKeyForSession(sessionId)}::${sessionId}`;
}

const shellCreation = new Map<string, Promise<PersistentShell>>();

async function getShell(sessionId: string): Promise<PersistentShell> {
  const key = shellKey(sessionId);
  const existing = persistentShells.get(key);
  if (existing && existing.proc.exitCode === null && !existing.proc.killed) return existing;

  const inFlight = shellCreation.get(key);
  if (inFlight) return inFlight;

  const creation = (async () => {
    const root = await sandboxRoot(sessionId);
    const cwd = await workDir(sessionId);
    const proc = spawnPersistentShell({ cwd, env: envFor(sessionId, root) });
    const shell: PersistentShell = { proc, buf: '', busy: false };
    proc.on('exit', () => { if (persistentShells.get(key) === shell) persistentShells.delete(key); });
    persistentShells.set(key, shell);
    return shell;
  })();
  shellCreation.set(key, creation);
  try {
    return await creation;
  } finally {
    shellCreation.delete(key);
  }
}

function killShell(key: string): void {
  const shell = persistentShells.get(key);
  if (shell) { killTree(shell.proc); persistentShells.delete(key); }
}

/** POSIX single-quote escaping for embedding a value in a shell command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface ShellResult { stdout: string; exit: number; timedOut: boolean; truncated: boolean; died: boolean }

async function runInShell(sessionId: string, command: string, timeoutMs: number): Promise<ShellResult> {
  const key = shellKey(sessionId);
  const shell = await getShell(sessionId);
  if (shell.busy) throw new Error('A previous command is still running in this persistent shell — wait for it to finish, or use background:true for long-running commands.');

  shell.busy = true;
  shell.buf = '';
  const marker = `__KRIX_DONE_${crypto.randomBytes(8).toString('hex')}__`;

  return new Promise<ShellResult>((resolve) => {
    let settled = false;
    const done = (r: ShellResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      shell.proc.stdout?.removeListener('data', onData);
      shell.proc.removeListener('exit', onExit);
      shell.busy = false;
      resolve(r);
    };
    const timer = setTimeout(() => {
      killShell(key);
      done({ stdout: shell.buf, exit: -1, timedOut: true, truncated: false, died: false });
    }, timeoutMs);

    const onExit = (code: number | null) => done({ stdout: shell.buf, exit: code ?? -1, timedOut: false, truncated: false, died: true });
    const onData = (d: Buffer) => {
      shell.buf += d.toString();
      if (shell.buf.length > SHELL_BUF_CAP + 1024) {
        killShell(key);
        done({ stdout: shell.buf.slice(0, SHELL_BUF_CAP), exit: -1, timedOut: false, truncated: true, died: true });
        return;
      }
      const idx = shell.buf.indexOf(`${marker}:`);
      if (idx === -1) return;
      const rest = shell.buf.slice(idx + marker.length + 1);
      const nl = rest.indexOf('\n');
      if (nl === -1) return;
      const exit = parseInt(rest.slice(0, nl), 10);
      let before = shell.buf.slice(0, idx);
      if (before.endsWith('\n')) before = before.slice(0, -1);
      done({ stdout: before, exit: Number.isFinite(exit) ? exit : 0, timedOut: false, truncated: false, died: false });
    };

    shell.proc.stdout?.on('data', onData);
    shell.proc.once('exit', onExit);
    // The command travels base64-encoded and is eval'd: heredocs, trailing comments/backslashes and
    // syntax errors can never corrupt the protocol or kill the shell, and stdin is detached so a
    // command that reads input cannot swallow the completion marker.
    const b64 = Buffer.from(command, 'utf8').toString('base64');
    shell.proc.stdin?.write(`eval "$(printf '%s' '${b64}' | base64 -d)" </dev/null 2>&1\nprintf '\\n%s:%s\\n' '${marker}' "$?"\n`);
  });
}

export async function destroySandbox(sessionId: string, options: { deleteContext?: boolean } = { deleteContext: true }): Promise<void> {
  const authKey = getAuthKeyForSession(sessionId);
  const dirToRemove = path.join(os.tmpdir(), `krix_sbx_${authKey}`);
  const shellToKill = shellKey(sessionId);
  if (options.deleteContext) {
    deleteSessionContext(sessionId);
  }
  killShell(shellToKill);
  outputCache.delete(sessionId);
  const table = processTables.get(authKey);
  if (table) {
    for (const [, item] of table) killTree(item.proc);
    processTables.delete(authKey);
  }
  try {
    await sbxRemoveTree(dirToRemove, dirToRemove);
    await fsp.rm(dirToRemove, { recursive: true, force: true });
  } catch {}
}

// ---------------------------------------------------------------------------------------------
// Code execution plans (argv only — no shell strings)
// ---------------------------------------------------------------------------------------------

interface Step { file: string; args: string[] }

function runPlan(ext: string, abs: string, extra: string[], bin: string): Step[] {
  switch (ext) {
    case '.py': return [{ file: 'python3', args: [abs, ...extra] }];
    case '.js': return [{ file: 'node', args: [abs, ...extra] }];
    case '.ts': return [{ file: 'npx', args: ['-y', 'tsx', abs, ...extra] }];
    case '.sh': return [{ file: 'bash', args: [abs, ...extra] }];
    case '.go': return [{ file: 'go', args: ['run', abs, ...extra] }];
    case '.java': return [{ file: 'java', args: [abs, ...extra] }];
    case '.cpp': return [{ file: 'g++', args: [abs, '-o', bin] }, { file: bin, args: extra }];
    case '.c': return [{ file: 'gcc', args: [abs, '-o', bin] }, { file: bin, args: extra }];
    case '.rs': return [{ file: 'rustc', args: ['-O', abs, '-o', bin] }, { file: bin, args: extra }];
    case '.rb': return [{ file: 'ruby', args: [abs, ...extra] }];
    case '.php': return [{ file: 'php', args: [abs, ...extra] }];
    default: throw new Error(`Unsupported extension '${ext}'. Use py/js/ts/sh/go/java/cpp/c/rust/ruby/php.`);
  }
}

const EXT_BY_LANG: Record<string, string> = { py: '.py', js: '.js', ts: '.ts', sh: '.sh', go: '.go', java: '.java', cpp: '.cpp', c: '.c', rust: '.rs', ruby: '.rb', php: '.php' };

// ---------------------------------------------------------------------------------------------
// Git helpers: argv only, credentials scoped to github.com via env (never on a command line,
// never written to .git/config), and an explicit remote URL so a tampered .git/config cannot redirect pushes.
// ---------------------------------------------------------------------------------------------

const GIT_BASE_ARGS = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=',
  '-c', 'http.sslVerify=true', '-c', 'commit.gpgsign=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'
];

function remoteUrl(owner: string, repo: string): string {
  assertValidOwnerRepo(owner, repo);
  return `https://github.com/${owner}/${repo}.git`;
}

async function git(root: string, cwd: string, args: string[], token?: string, timeoutMs: number = 60000): Promise<RunResult> {
  return runProc('git', [...GIT_BASE_ARGS, ...args], { cwd, env: scrubbedEnvForGit(root, token), timeoutMs, maxOutputBytes: 2 * 1024 * 1024 });
}

async function assertNoUrlRewrite(root: string, cwd: string, url: string): Promise<void> {
  const r = await git(root, cwd, ['ls-remote', '--get-url', url], undefined, 10000);
  if (r.code !== 0 || r.stdout.trim() !== url) {
    throw new Error('Repository configuration rewrites remote URLs; refusing to send credentials.');
  }
}

function requireRepo(sessionId: string): { root: string; dir: string; owner: string; repo: string; branch: string } {
  const ctx = getSessionContext(sessionId);
  if (!ctx.sandboxDir || !ctx.owner || !ctx.repo) throw new Error('No repo cloned. Call git_clone first.');
  return { root: sandboxRootPath(sessionId), dir: ctx.sandboxDir, owner: ctx.owner, repo: ctx.repo, branch: ctx.branch || 'main' };
}

// ---------------------------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------------------------

export function registerSandboxTools(server: McpServer, sessionId: string, githubToken: string | undefined, registry: Record<string, any>) {
  const reg = makeRegistrar(server, registry);

  reg('sandbox_exec', {
    description: 'Run a shell command as an unprivileged sandbox user. By default runs in a persistent shell that keeps cd/export/venv state across calls (like a real terminal) — pass `persistent:false` for an isolated one-off exec instead. Pass `dir` for a one-off working directory (state changes in that call do not persist). Pass `background:true` to run detached and track it via sandbox_ps (always isolated, unaffected by `persistent`). Files you create here can be handed to the user with sandbox_files (action:share).',
    inputSchema: {
      command: z.string().min(1).max(100000),
      timeoutMs: z.number().int().positive().optional(),
      dir: z.string().optional(),
      background: z.boolean().optional().default(false),
      persistent: z.boolean().optional().default(true)
    },
    annotations: getToolAnnotations('sandbox_exec')
  }, async (args: any) => {
    try {
      assertSandboxAllowed();
      sanitizeCommand(args.command);
      const root = await sandboxRoot(sessionId);
      const cwd = await resolveDir(sessionId, args.dir);
      const env = envFor(sessionId, root);

      if (args.background) {
        const table = procTable(sessionId);
        const running = [...table.values()].filter((p) => p.status === 'running').length;
        if (running >= MAX_BG_PROCS) throw new Error(`Too many background processes (max ${MAX_BG_PROCS}). Kill some with sandbox_ps.`);
        const proc = spawnShell(args.command, { cwd, env });
        if (!proc.pid) throw new Error('Failed to start background process.');
        const pid = proc.pid;
        const entry: ActiveProcess = { pid, command: args.command, proc, startTime: new Date(), status: 'running', exitCode: null, exitedAt: null, stdout: '', stderr: '' };
        table.set(pid, entry);
        proc.stdout?.on('data', (d) => { entry.stdout = appendCapped(entry.stdout, d.toString()); });
        proc.stderr?.on('data', (d) => { entry.stderr = appendCapped(entry.stderr, d.toString()); });
        proc.on('error', (e) => { entry.stderr = appendCapped(entry.stderr, `spawn error: ${e.message}`); entry.status = 'exited'; entry.exitedAt = new Date(); });
        proc.on('exit', (code) => { entry.status = 'exited'; entry.exitCode = code; entry.exitedAt = new Date(); });
        return formatOptimizedResponse({ started: pid, command: args.command, dir: cwd });
      }

      const timeoutMs = Math.min(args.timeoutMs || 30000, 120000);

      if (args.persistent) {
        const cmd = args.dir ? `( cd -- ${shq(cwd)} && {\n${args.command}\n} )` : args.command;
        const r = await runInShell(sessionId, cmd, Math.min(timeoutMs, SHELL_HANG_MS));
        if (r.timedOut) return formatError(`Command timed out after ${timeoutMs}ms and the persistent shell was restarted (its prior state is lost). Use background:true for long-running commands instead.`);
        const out: Record<string, any> = {};
        const o = truncWithCache(sessionId, r.stdout);
        if (o) out.stdout = o;
        if (r.truncated) out.outputTruncated = true;
        if (r.died) out.note = 'The persistent shell exited and will be restarted on the next call.';
        if (r.exit !== 0) out.exit = r.exit;
        return formatOptimizedResponse(Object.keys(out).length ? out : { stdout: '(ok, no output)' });
      }

      return execResponse(sessionId, await runShell(args.command, { cwd, env, timeoutMs }));
    } catch (err) { return formatError(err); }
  });

  reg('sandbox_run', {
    description: 'Run code as an unprivileged sandbox user: pass inline `code` (+ optional `lang`, default py) or an existing `filePath`. Langs: py,js,ts,sh,go,java,cpp,c,rust,ruby,php. Pass `dir` to run in any sandbox directory instead of the default workDir. Files the code writes can be handed to the user with sandbox_files (action:share).',
    inputSchema: {
      lang: z.enum(['py', 'js', 'ts', 'sh', 'go', 'java', 'cpp', 'c', 'rust', 'ruby', 'php']).optional(),
      code: z.string().max(1_000_000).optional(),
      filePath: z.string().optional(),
      args: z.array(z.string().max(4096)).max(64).optional(),
      dir: z.string().optional()
    },
    annotations: getToolAnnotations('sandbox_run')
  }, async (args: any) => {
    let tmp: string | null = null;
    let bin: string | null = null;
    let root = '';
    try {
      assertSandboxAllowed();
      root = await sandboxRoot(sessionId);
      const cwd = await resolveDir(sessionId, args.dir);
      const env = envFor(sessionId, root);
      const nonce = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      bin = path.join(sandboxTmp(root), `_sbx_out_${nonce}`);

      let abs: string;
      if (args.filePath) {
        abs = sanitizePath(args.filePath, cwd);
        await assertInsideRealRoot(root, abs);
      } else if (args.code) {
        sanitizeCommand(args.code);
        const ext = EXT_BY_LANG[args.lang || 'py'] || '.py';
        abs = tmp = path.join(cwd, `_snippet_${nonce}${ext}`);
        await sbxWriteText(root, tmp, args.code, false);
      } else {
        throw new Error('Provide either `code` or `filePath`.');
      }

      const steps = runPlan(path.extname(abs).toLowerCase(), abs, args.args || [], bin);
      let last: RunResult | null = null;
      for (const step of steps) {
        last = await runProc(step.file, step.args, { cwd, env, timeoutMs: 45000 });
        if (last.code !== 0) break;
      }
      return execResponse(sessionId, last!);
    } catch (err) { return formatError(err); }
    finally {
      if (root && tmp) await sbxRemoveFile(root, tmp).catch(() => {});
      if (root && bin) await sbxRemoveFile(root, bin).catch(() => {});
    }
  });

  reg('sandbox_install', {
    description: 'Install npm or pip packages (registry package names with an optional version only). Defaults to the isolated sandbox root (never the cloned repo, so it can\'t pollute git-tracked files) — pass `dir` to target a specific directory instead.',
    inputSchema: { manager: z.enum(['npm', 'pip']), packages: z.array(z.string().max(200)).min(1).max(30), dir: z.string().optional() },
    annotations: getToolAnnotations('sandbox_install')
  }, async (args: any) => {
    try {
      assertSandboxAllowed();
      for (const p of args.packages) assertValidPackageSpec(p);
      const root = await sandboxRoot(sessionId);
      const cwd = args.dir ? await resolveDir(sessionId, args.dir) : root;
      const env = envFor(sessionId, root);
      const r = args.manager === 'npm'
        ? await runProc('npm', ['install', '--no-audit', '--no-fund', '--no-progress', ...args.packages], { cwd, env, timeoutMs: 90000 })
        : await runProc('python3', ['-m', 'pip', 'install', '--quiet', '--no-input', '--disable-pip-version-check', '--target=.', ...args.packages], { cwd, env, timeoutMs: 90000 });
      if (r.code !== 0) return execResponse(sessionId, r);
      return formatOptimizedResponse({ installed: args.packages, path: cwd });
    } catch (err) { return formatError(err); }
  });

  reg('sandbox_ps', {
    description: 'List, kill (pid or "all"), or fetch output of background sandbox processes started via sandbox_exec(background:true). `offset`/`limit` paginate action:list (by item) and action:output (by char).',
    inputSchema: {
      action: z.enum(['list', 'kill', 'output']).default('list'),
      pid: z.union([z.coerce.number(), z.literal('all')]).optional(),
      offset: z.number().optional().describe('Pagination offset — item index for action:list, char offset for action:output.'),
      limit: z.number().optional().describe(`Page size — max 200 items for action:list, max ${OUT_CAP} chars for action:output.`)
    },
    annotations: getToolAnnotations('sandbox_ps')
  }, async (args: any) => {
    const table = procTable(sessionId);

    const now = Date.now();
    for (const [pid, item] of table) {
      if (item.status === 'exited' && item.exitedAt && now - item.exitedAt.getTime() > EXITED_TTL_MS) table.delete(pid);
    }

    if (args.action === 'kill') {
      if (args.pid === 'all') {
        const killed: number[] = [];
        for (const [pid, item] of table) {
          if (item.status === 'running') killTree(item.proc);
          killed.push(pid);
          table.delete(pid);
        }
        return formatOptimizedResponse({ killed });
      }
      if (!args.pid) return formatError('Provide `pid` (a number or "all") for kill.');
      const item = table.get(args.pid);
      if (!item) return formatError('No such process.');
      killTree(item.proc);
      table.delete(args.pid);
      return formatOptimizedResponse({ killed: args.pid });
    }

    if (args.action === 'output') {
      if (!args.pid || args.pid === 'all') return formatError('Provide a specific numeric `pid` for output.');
      const item = table.get(args.pid);
      if (!item) return formatError('No such process.');
      const offset = Math.max(0, args.offset || 0);
      const limit = Math.min(args.limit || OUT_CAP, OUT_CAP);
      const out: Record<string, any> = { pid: item.pid, status: item.status, exitCode: item.exitCode, stdoutLength: item.stdout.length, stderrLength: item.stderr.length };
      const stdoutSlice = item.stdout.slice(offset, offset + limit);
      const stderrSlice = item.stderr.slice(offset, offset + limit);
      if (stdoutSlice) out.stdout = stdoutSlice;
      if (stderrSlice) out.stderr = stderrSlice;
      if (offset + limit < Math.max(item.stdout.length, item.stderr.length)) out.nextOffset = offset + limit;
      return formatOptimizedResponse(out);
    }

    const all = Array.from(table.values()).map(p => ({
      pid: p.pid, command: p.command, status: p.status, exitCode: p.exitCode
    }));
    if (!all.length) return formatOptimizedResponse('No active processes.');
    const offset = Math.max(0, args.offset || 0);
    const limit = Math.min(args.limit || 50, 200);
    const page = all.slice(offset, offset + limit);
    const out: Record<string, any> = { processes: page, total: all.length, offset };
    if (offset + page.length < all.length) out.nextOffset = offset + page.length;
    return formatOptimizedResponse(out);
  });

  reg('sandbox_output', {
    description: 'Page through output that was truncated by sandbox_exec/sandbox_run/sandbox_install — use the outputId from the truncation notice. Cached per-session for 15 minutes (10 most recent truncated outputs kept; older ones are evicted).',
    inputSchema: {
      outputId: z.string().regex(/^[a-f0-9]{12}$/),
      offset: z.number().optional().default(0).describe('Char offset to resume from — defaults to 0, but the truncation notice tells you where the first response left off.'),
      limit: z.number().optional().describe(`Max chars to return (default/cap: ${OUT_CAP}).`)
    },
    annotations: getToolAnnotations('sandbox_output')
  }, async (args: any) => {
    try {
      const full = getCachedOutput(sessionId, args.outputId);
      if (full === undefined) return formatError('No cached output for that outputId — it may have expired (15min TTL) or been evicted (only the 10 most recent truncated outputs per session are kept).');
      const offset = Math.max(0, args.offset || 0);
      const limit = Math.min(args.limit || OUT_CAP, OUT_CAP);
      const slice = full.slice(offset, offset + limit);
      const out: Record<string, any> = { content: slice, offset, totalLength: full.length };
      if (offset + slice.length < full.length) out.nextOffset = offset + slice.length;
      return formatOptimizedResponse(out);
    } catch (err) { return formatError(err); }
  });

  reg('sandbox_file', {
    description: 'Read, write, append to, edit (find-and-replace via old_str/new_str), or delete a file in the sandbox — safer than shell-escaping content through sandbox_exec. For edit, old_str can be any length — a single line or an entire block — as long as it matches the file exactly once; it is not limited to short snippets. To give a file to the user, use sandbox_files (action:share).',
    inputSchema: {
      action: z.enum(['read', 'write', 'append', 'edit', 'delete']),
      path: z.string().min(1).max(1024),
      content: z.string().optional(),
      old_str: z.string().optional().describe('Required for action:edit. Must match the file content in exactly one place.'),
      new_str: z.string().optional().describe('Required for action:edit. Replaces old_str; empty string deletes the matched text.'),
      dir: z.string().optional(),
      offset: z.number().optional().describe('For action:read — char offset to start from, for paginating large files.'),
      limit: z.number().optional().describe(`For action:read — max chars to return (default/cap: ${OUT_CAP}).`)
    },
    annotations: getToolAnnotations('sandbox_file')
  }, async (args: any) => {
    try {
      assertSandboxAllowed();
      const root = await sandboxRoot(sessionId);
      const base = await resolveDir(sessionId, args.dir);
      const abs = sanitizePath(args.path, base);
      await assertInsideRealRoot(root, abs);

      if (args.action === 'read') {
        const st = await sbxStat(root, abs);
        if (st.kind !== 'file') return formatError(`No such file: ${args.path}`);
        const content = await sbxReadText(root, abs, MAX_READ_BYTES);
        const offset = Math.max(0, args.offset || 0);
        const limit = Math.min(args.limit || OUT_CAP, OUT_CAP);
        const slice = content.slice(offset, offset + limit);
        const out: Record<string, any> = { sizeBytes: st.size, totalChars: content.length, offset };
        if (slice) out.content = slice;
        if (offset + slice.length < content.length) out.nextOffset = offset + slice.length;
        return formatOptimizedResponse(out);
      }

      if (args.action === 'delete') {
        const st = await sbxStat(root, abs);
        if (st.kind === 'missing') return formatError(`No such file: ${args.path}`);
        if (st.kind === 'directory') return formatError('Refusing to delete a directory; use sandbox_exec for that.');
        await sbxRemoveFile(root, abs);
        return formatOptimizedResponse({ deleted: args.path });
      }

      if (args.action === 'edit') {
        if (args.old_str === undefined || args.new_str === undefined) return formatError('`old_str` and `new_str` are both required for action:edit.');
        if (args.old_str === '') return formatError('`old_str` must not be empty.');
        const st = await sbxStat(root, abs);
        if (st.kind !== 'file') return formatError(`No such file: ${args.path}`);
        const content = await sbxReadText(root, abs, MAX_READ_BYTES);
        const count = content.split(args.old_str).length - 1;
        if (count === 0) return formatError('old_str not found in file.');
        if (count > 1) return formatError(`old_str matches ${count} places — make it unique by including more surrounding context.`);
        const idx = content.indexOf(args.old_str);
        const updated = content.slice(0, idx) + args.new_str + content.slice(idx + args.old_str.length);
        if (Buffer.byteLength(updated) > MAX_WRITE_BYTES) return formatError('Result is too large for sandbox_file; use sandbox_exec.');
        await sbxWriteText(root, abs, updated, false);
        const newStat = await sbxStat(root, abs);
        return formatOptimizedResponse({ edited: args.path, sizeBytes: newStat.size });
      }

      if (args.content === undefined) return formatError('`content` is required for write/append.');
      if (Buffer.byteLength(args.content) > MAX_WRITE_BYTES) return formatError(`Content exceeds ${MAX_WRITE_BYTES / 1024 / 1024}MB; generate it with code in the sandbox instead.`);
      await sbxMkdirp(root, path.dirname(abs));
      await sbxWriteText(root, abs, args.content, args.action === 'append');
      const stat = await sbxStat(root, abs);
      return formatOptimizedResponse({ [args.action === 'append' ? 'appended' : 'wrote']: args.path, sizeBytes: stat.size });
    } catch (err) { return formatError(err); }
  });

  reg('sandbox_reset', {
    description: 'Wipe the sandbox: scratch files, cloned repo, persistent shell, and background processes.',
    inputSchema: {},
    annotations: getToolAnnotations('sandbox_reset')
  }, async () => {
    try {
      await destroySandbox(sessionId, { deleteContext: false });
      updateSessionContext(sessionId, { sandboxDir: undefined });
      return formatOptimizedResponse({ reset: true });
    } catch (err) { return formatError(err); }
  });

  reg('sandbox_status', {
    description: 'Check available runtimes, memory, isolation status, and the active repo/branch.',
    inputSchema: {},
    annotations: getToolAnnotations('sandbox_status')
  }, async () => {
    try {
      const runtimes: Record<string, string> = {};
      const check = (name: string, file: string, args: string[]) => {
        try { runtimes[name] = execFileSync(file, args, { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0]; }
        catch { runtimes[name] = 'N/A'; }
      };
      check('node', 'node', ['-v']);
      check('python', 'python3', ['--version']);
      check('git', 'git', ['--version']);
      check('go', 'go', ['version']);
      check('zip', 'zip', ['-v']);
      check('unzip', 'unzip', ['-v']);
      check('imagemagick', 'convert', ['-version']);

      const ctx = getSessionContext(sessionId);
      let cloned = false;
      if (ctx.sandboxDir) {
        try {
          const root = sandboxRootPath(sessionId);
          cloned = (await sbxStat(root, ctx.sandboxDir)).kind === 'directory';
          if (!cloned) updateSessionContext(sessionId, { sandboxDir: undefined });
        } catch { cloned = false; }
      }
      const iso = getIsolation();

      return formatOptimizedResponse({
        serverRssMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        systemFreeMemMB: Math.round(os.freemem() / (1024 * 1024)),
        runtimes,
        isolation: iso.enforced ? 'enforced (unprivileged sandbox user)' : `NOT enforced (${iso.reason})`,
        repo: ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo}` : undefined,
        branch: ctx.branch,
        cloned,
        cwd: ctx.cwd,
        envVars: ctx.env ? Object.keys(ctx.env).length : undefined,
        persistentShellAlive: !!persistentShells.get(shellKey(sessionId)),
        ...(ctx.resumedContext ? { resumed: true, resumedAfterIdleMs: ctx.resumedContext.idleMs } : { resumed: false })
      });
    } catch (err) { return formatError(err); }
  });

  reg('git_clone', {
    description: 'Clone a repo into the sandbox so it can be run/tested. Omit owner/repo to use active set_active_context.',
    inputSchema: { owner: z.string().optional(), repo: z.string().optional(), branch: z.string().optional(), depth: z.number().int().min(1).max(1000).optional().default(1) },
    annotations: getToolAnnotations('git_clone')
  }, async (args: any) => {
    try {
      assertSandboxAllowed();
      const ctx = getSessionContext(sessionId);
      const owner = args.owner || ctx.owner;
      const repo = args.repo || ctx.repo;
      if (!owner || !repo) throw new Error('owner/repo missing. Pass them or call set_active_context first.');
      const branch = args.branch || ctx.branch || 'main';
      assertValidRef(branch);
      const url = remoteUrl(owner, repo);

      const root = await sandboxRoot(sessionId);
      const dest = path.join(root, owner, repo);

      if ((await sbxStat(root, path.join(dest, '.git'))).kind === 'directory') {
        let checkoutErr: string | undefined;
        let r = await git(root, dest, ['checkout', branch, '--'], undefined, 15000);
        if (r.code !== 0) {
          await assertNoUrlRewrite(root, dest, url);
          const fetched = await git(root, dest, ['fetch', '--depth', '1', url, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], githubToken, 30000);
          if (fetched.code === 0) r = await git(root, dest, ['checkout', '-B', branch, `origin/${branch}`, '--'], undefined, 15000);
        }
        if (r.code !== 0) checkoutErr = `Could not switch to branch '${branch}'`;
        updateSessionContext(sessionId, { owner, repo, branch, sandboxDir: dest });
        return formatOptimizedResponse({ note: 'already cloned', branch, path: dest, ...(checkoutErr ? { checkoutWarning: checkoutErr } : {}) });
      }

      await sbxRemoveTree(root, dest);
      await sbxMkdirp(root, path.dirname(dest));
      const r = await git(root, root, ['clone', '--depth', String(args.depth || 1), '--branch', branch, '--single-branch', '--', url, dest], githubToken, 90000);
      if (r.code !== 0) return execResponse(sessionId, r);

      await git(root, dest, ['config', 'user.email', 'agent@sandbox.local'], undefined, 10000);
      await git(root, dest, ['config', 'user.name', 'Sandbox Agent'], undefined, 10000);
      updateSessionContext(sessionId, { owner, repo, branch, sandboxDir: dest });
      return formatOptimizedResponse({ cloned: `${owner}/${repo}`, branch, path: dest });
    } catch (err) { return formatError(err); }
  });

  reg('git_checkout', {
    description: 'Switch or create a branch in the active cloned repo. Automatically fetches the branch from origin first if it is not yet known locally.',
    inputSchema: { branch: z.string(), create: z.boolean().optional().default(false) },
    annotations: getToolAnnotations('git_checkout')
  }, async (args: any) => {
    try {
      assertSandboxAllowed();
      const { root, dir, owner, repo } = requireRepo(sessionId);
      assertValidRef(args.branch);
      let r = await git(root, dir, ['checkout', ...(args.create ? ['-b'] : []), args.branch, '--'], undefined, 15000);
      if (r.code !== 0 && !args.create) {
        const url = remoteUrl(owner, repo);
        await assertNoUrlRewrite(root, dir, url);
        const fetched = await git(root, dir, ['fetch', '--depth', '1', url, `+refs/heads/${args.branch}:refs/remotes/origin/${args.branch}`], githubToken, 30000);
        if (fetched.code === 0) r = await git(root, dir, ['checkout', '-B', args.branch, `origin/${args.branch}`, '--'], undefined, 15000);
      }
      if (r.code !== 0) return execResponse(sessionId, r);
      updateSessionContext(sessionId, { branch: args.branch });
      return formatOptimizedResponse({ branch: args.branch });
    } catch (err) { return formatError(err); }
  });

  reg('git_pull', {
    description: 'Fast-forward pull the active branch of the cloned repo.',
    inputSchema: {},
    annotations: getToolAnnotations('git_pull')
  }, async () => {
    try {
      assertSandboxAllowed();
      const { root, dir, owner, repo, branch } = requireRepo(sessionId);
      assertValidRef(branch);
      const url = remoteUrl(owner, repo);
      await assertNoUrlRewrite(root, dir, url);
      return execResponse(sessionId, await git(root, dir, ['pull', '--ff-only', url, branch], githubToken, 60000));
    } catch (err) { return formatError(err); }
  });

  reg('git_status', {
    description: 'Compact status (branch + changed files) of the cloned repo.',
    inputSchema: {},
    annotations: getToolAnnotations('git_status')
  }, async () => {
    try {
      assertSandboxAllowed();
      const { root, dir } = requireRepo(sessionId);
      return execResponse(sessionId, await git(root, dir, ['status', '--porcelain=v1', '-b'], undefined, 15000));
    } catch (err) { return formatError(err); }
  });

  reg('git_diff', {
    description: 'Diff of the cloned repo, optionally scoped to a path or staged changes.',
    inputSchema: { path: z.string().max(1024).optional(), staged: z.boolean().optional().default(false) },
    annotations: getToolAnnotations('git_diff')
  }, async (args: any) => {
    try {
      assertSandboxAllowed();
      const { root, dir } = requireRepo(sessionId);
      const pathArgs = args.path ? ['--', args.path] : ['--'];
      return execResponse(sessionId, await git(root, dir, ['diff', '--no-ext-diff', '--no-textconv', ...(args.staged ? ['--cached'] : []), ...pathArgs], undefined, 20000));
    } catch (err) { return formatError(err); }
  });

  reg('git_commit_push', {
    description: 'Stage, commit, and (by default) push changes in the cloned repo.',
    inputSchema: { message: z.string().min(1).max(5000), push: z.boolean().optional().default(true), branch: z.string().optional() },
    annotations: getToolAnnotations('git_commit_push')
  }, async (args: any) => {
    try {
      assertSandboxAllowed();
      const { root, dir, owner, repo, branch: ctxBranch } = requireRepo(sessionId);
      const branch = args.branch || ctxBranch;
      assertValidRef(branch);
      if (args.branch) {
        const co = await git(root, dir, ['checkout', args.branch, '--'], undefined, 15000);
        if (co.code !== 0) return execResponse(sessionId, co);
        updateSessionContext(sessionId, { branch: args.branch });
      }

      const add = await git(root, dir, ['add', '-A'], undefined, 30000);
      if (add.code !== 0) return execResponse(sessionId, add);

      const commit = await git(root, dir, ['commit', '--no-verify', '-m', args.message], undefined, 30000);
      const nothing = commit.code !== 0 && /nothing to commit|no changes added/i.test(commit.stdout + commit.stderr);
      if (commit.code !== 0 && !nothing) return execResponse(sessionId, commit);

      if (!args.push) return formatOptimizedResponse({ committed: !nothing, ...(nothing ? { note: 'nothing to commit' } : {}) });

      if (!githubToken) throw new Error('No GitHub token configured for this session, so push is not possible.');
      const url = remoteUrl(owner, repo);
      await assertNoUrlRewrite(root, dir, url);
      const push = await git(root, dir, ['push', url, `refs/heads/${branch}:refs/heads/${branch}`], githubToken, 90000);
      if (push.code !== 0) return execResponse(sessionId, push);
      return formatOptimizedResponse({ committed: !nothing, pushed: branch, ...(nothing ? { note: 'nothing new to commit; pushed existing commits' } : {}) });
    } catch (err) { return formatError(err); }
  });
}
