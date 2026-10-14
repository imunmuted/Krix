import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scrubbedBaseEnv } from './security.js';

/**
 * Process runner for the sandbox. Design rules:
 *  1. Never build shell strings from untrusted values — callers pass argv arrays.
 *  2. Children get a scrubbed environment (no server secrets).
 *  3. When SANDBOX_UID/SANDBOX_GID are set and the server runs as root, every child (and every file
 *     operation, which is done by a child too) runs as that unprivileged user, so sandboxed code can
 *     neither read the server's memory/environment (/proc/<pid>/environ) nor plant symlinks that a
 *     privileged server process would follow.
 *  4. Timeouts kill the whole process group, not just the direct child.
 */

export interface Isolation { enforced: boolean; uid?: number; gid?: number; reason?: string }

let cachedIsolation: Isolation | undefined;

export function getIsolation(): Isolation {
  if (cachedIsolation) return cachedIsolation;
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const uidRaw = process.env.SANDBOX_UID;
  const gidRaw = process.env.SANDBOX_GID ?? uidRaw;
  const uid = Number(uidRaw);
  const gid = Number(gidRaw);
  if (uidRaw && Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0) {
    cachedIsolation = isRoot
      ? { enforced: true, uid, gid }
      : { enforced: false, reason: 'SANDBOX_UID is set but the server is not running as root, so it cannot switch users.' };
  } else {
    cachedIsolation = { enforced: false, reason: 'SANDBOX_UID/SANDBOX_GID are not set.' };
  }
  return cachedIsolation;
}

function isolationRequired(): boolean {
  const flag = process.env.SANDBOX_REQUIRE_ISOLATION;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

/** Throws unless the sandbox may run in the current deployment (fail closed in production). */
export function assertSandboxAllowed(): void {
  const iso = getIsolation();
  if (iso.enforced || !isolationRequired()) return;
  throw new Error(
    `Sandbox disabled: OS-level isolation is not active (${iso.reason}). ` +
    'Run the server as root with SANDBOX_UID/SANDBOX_GID set to an unprivileged user (the provided Dockerfile does this), ' +
    'or explicitly accept the risk with SANDBOX_REQUIRE_ISOLATION=false.'
  );
}

export function logIsolationStatus(): void {
  const iso = getIsolation();
  if (iso.enforced) {
    console.log(`🔒 Sandbox isolation active (uid=${iso.uid}, gid=${iso.gid}).`);
  } else {
    console.warn(`⚠️  Sandbox isolation NOT active: ${iso.reason} ${isolationRequired() ? 'Sandbox tools are disabled (fail-closed).' : 'Sandboxed code can read this server\'s secrets via /proc. Set SANDBOX_UID/SANDBOX_GID and run as root in a container.'}`);
  }
}

function identityOpts(): { uid?: number; gid?: number } {
  const iso = getIsolation();
  return iso.enforced ? { uid: iso.uid, gid: iso.gid } : {};
}

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

// Shell resource limits (soft caps; failures to lower limits are ignored).
const LIMITS_PREFIX =
  'ulimit -c 0 2>/dev/null; ulimit -f 1048576 2>/dev/null; ulimit -n 4096 2>/dev/null; ulimit -u 2048 2>/dev/null\n';

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  input?: string | Buffer;
  maxOutputBytes?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Raw stdout bytes (use for binary-safe reads). */
  stdoutBuffer: Buffer;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  spawnError?: string;
}

export function killTree(child: ChildProcess | number | undefined): void {
  const pid = typeof child === 'number' ? child : child?.pid;
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); return; } catch {}
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

export function runProc(file: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const cap = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        ...identityOpts()
      });
    } catch (e: any) {
      resolve({ code: null, signal: null, stdoutBuffer: Buffer.alloc(0), stdout: '', stderr: '', timedOut: false, truncated: false, spawnError: e?.message || String(e) });
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => { timedOut = true; killTree(child); }, Math.max(1, opts.timeoutMs));

    const take = (list: Buffer[], size: number, chunk: Buffer): number => {
      if (size >= cap) { truncated = true; killTree(child); return size; }
      const room = cap - size;
      list.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      if (chunk.length > room) { truncated = true; killTree(child); }
      return size + Math.min(chunk.length, room);
    };
    child.stdout?.on('data', (c: Buffer) => { outBytes = take(out, outBytes, c); });
    child.stderr?.on('data', (c: Buffer) => { errBytes = take(err, errBytes, c); });

    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Reap any stragglers left in the process group.
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      const stdoutBuffer = Buffer.concat(out);
      resolve({ code, signal, stdoutBuffer, stdout: stdoutBuffer.toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, truncated, spawnError });
    };
    child.on('error', (e) => finish(null, null, e.message));
    child.on('close', (code, signal) => finish(code, signal));

    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input);
    }
  });
}

/** Run a shell snippet (the *only* place a shell is used) with resource limits applied. */
export function runShell(cmd: string, opts: RunOptions): Promise<RunResult> {
  return runProc('/bin/bash', ['--noprofile', '--norc', '-c', LIMITS_PREFIX + cmd], opts);
}

/** Spawn a detached background shell command; the caller owns the ChildProcess. */
export function spawnShell(cmd: string, opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  return spawn('/bin/bash', ['--noprofile', '--norc', '-c', LIMITS_PREFIX + cmd], {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...identityOpts()
  });
}

/** Spawn the long-lived interactive shell used by sandbox_exec(persistent:true). */
export function spawnPersistentShell(opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  const proc = spawn('/bin/bash', ['--noprofile', '--norc'], {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...identityOpts()
  });
  proc.stdin?.on('error', () => {});
  proc.stderr?.resume();
  proc.stdin?.write(LIMITS_PREFIX);
  return proc;
}

// ---------------------------------------------------------------------------------------------
// Environment for sandboxed code
// ---------------------------------------------------------------------------------------------

export function sandboxHome(root: string): string { return path.join(root, '.home'); }
export function sandboxTmp(root: string): string { return path.join(root, '.tmp'); }

export function buildSandboxEnv(root: string, userEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const home = sandboxHome(root);
  return {
    ...scrubbedBaseEnv(),
    HOME: home,
    TMPDIR: sandboxTmp(root),
    npm_config_cache: path.join(home, '.npm'),
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    NODE_OPTIONS: userEnv?.NODE_OPTIONS || '--max-old-space-size=400',
    ...(userEnv || {})
  };
}

/**
 * Environment for git child processes. The GitHub credential is passed as an in-memory config entry
 * scoped to https://github.com/ only — it never appears on a command line or in .git/config, and is
 * never sent to any other host even if a repo's config is tampered with.
 */
export function scrubbedEnvForGit(root: string, token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...scrubbedBaseEnv(),
    HOME: sandboxHome(root),
    TMPDIR: sandboxTmp(root),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_OPTIONAL_LOCKS: '0'
  };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

/** Create (once) a sandbox root owned by the sandbox user, with private home and tmp dirs. */
export async function ensureSandboxRoot(root: string): Promise<void> {
  const iso = getIsolation();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const sub of [sandboxHome(root), sandboxTmp(root)]) {
    await fs.mkdir(sub, { recursive: true, mode: 0o700 });
  }
  if (iso.enforced) {
    for (const p of [root, sandboxHome(root), sandboxTmp(root)]) {
      await fs.chown(p, iso.uid!, iso.gid!).catch(() => {});
      await fs.chmod(p, 0o700).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------------------------
// File operations performed *as the sandbox user* (never by the privileged server process)
// ---------------------------------------------------------------------------------------------

function fsEnv(root: string): NodeJS.ProcessEnv {
  return { ...scrubbedBaseEnv(), HOME: sandboxHome(root) };
}

export interface SbxStat { kind: 'file' | 'directory' | 'other' | 'missing'; size: number }

export async function sbxStat(root: string, abs: string): Promise<SbxStat> {
  const r = await runProc('stat', ['-L', '-c', '%F|%s', '--', abs], { cwd: root, env: fsEnv(root), timeoutMs: 10000, maxOutputBytes: 4096 });
  if (r.code !== 0) return { kind: 'missing', size: 0 };
  const [type, size] = r.stdout.trim().split('|');
  const n = Number(size) || 0;
  if (/regular/.test(type)) return { kind: 'file', size: n };
  if (/directory/.test(type)) return { kind: 'directory', size: n };
  return { kind: 'other', size: n };
}

export async function sbxReadText(root: string, abs: string, maxBytes: number): Promise<string> {
  const r = await runProc('cat', ['--', abs], { cwd: root, env: fsEnv(root), timeoutMs: 20000, maxOutputBytes: maxBytes });
  if (r.truncated) throw new Error(`File is larger than ${Math.round(maxBytes / 1024 / 1024)}MB; read it with sandbox_exec (head/tail/sed) instead.`);
  if (r.code !== 0) throw new Error((r.stderr || 'Could not read file.').trim().slice(0, 300));
  return r.stdout;
}

export async function sbxWriteText(root: string, abs: string, data: string | Buffer, append: boolean): Promise<void> {
  const script = append ? 'cat >> "$1"' : 'cat > "$1"';
  const r = await runProc('/bin/sh', ['-c', script, 'sh', abs], { cwd: root, env: fsEnv(root), timeoutMs: 20000, input: data, maxOutputBytes: 8192 });
  if (r.code !== 0) throw new Error((r.stderr || 'Could not write file.').trim().slice(0, 300));
}

export async function sbxMkdirp(root: string, abs: string): Promise<void> {
  const r = await runProc('mkdir', ['-p', '--', abs], { cwd: root, env: fsEnv(root), timeoutMs: 10000, maxOutputBytes: 8192 });
  if (r.code !== 0) throw new Error((r.stderr || 'Could not create directory.').trim().slice(0, 300));
}

export async function sbxRemoveFile(root: string, abs: string): Promise<void> {
  const r = await runProc('rm', ['-f', '--', abs], { cwd: root, env: fsEnv(root), timeoutMs: 10000, maxOutputBytes: 8192 });
  if (r.code !== 0) throw new Error((r.stderr || 'Could not delete file.').trim().slice(0, 300));
}

export async function sbxRemoveTree(root: string, abs: string): Promise<void> {
  await runProc('rm', ['-rf', '--', abs], { cwd: '/', env: fsEnv(root), timeoutMs: 60000, maxOutputBytes: 8192 });
}

/** Read a file's raw bytes as the sandbox user, refusing anything larger than `maxBytes`. */
export async function sbxReadBytes(root: string, abs: string, maxBytes: number): Promise<Buffer> {
  const r = await runProc('cat', ['--', abs], { cwd: root, env: fsEnv(root), timeoutMs: 60000, maxOutputBytes: maxBytes });
  if (r.truncated) throw new Error(`File is larger than the ${Math.round(maxBytes / 1024 / 1024)}MB limit.`);
  if (r.code !== 0) throw new Error((r.stderr || 'Could not read file.').trim().slice(0, 300));
  return r.stdoutBuffer;
}

/**
 * Follow symlinks on the deepest existing ancestor and confirm the final location is still inside
 * the sandbox root. Defence in depth: the real boundary is that file operations run as the sandbox user.
 */
export async function assertInsideRealRoot(root: string, target: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  let probe = target;
  for (let i = 0; i < 64; i++) {
    try {
      const real = await fs.realpath(probe);
      const rel = path.relative(realRoot, real);
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        throw new Error('Security Violation: path resolves outside the sandbox (symlink escape).');
      }
      return;
    } catch (e: any) {
      if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') {
        const parent = path.dirname(probe);
        if (parent === probe) throw new Error('Security Violation: invalid path.');
        probe = parent;
        continue;
      }
      throw e;
    }
  }
  throw new Error('Security Violation: path too deep.');
}
