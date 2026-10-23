import crypto from 'node:crypto';
import path from 'node:path';
import express, { Router, type Express, type NextFunction, type Request, type Response } from 'express';
import { computeAuthKey, safeEqual, sandboxRootForAuthKey } from './security.js';
import { createLimiter, clientIp, rateLimitMiddleware } from './rateLimit.js';
import {
  assertSandboxAllowed, ensureSandboxRoot, sbxMkdirp, sbxRemoveFile, sbxStat, sbxWriteText, assertInsideRealRoot
} from './sandboxProc.js';
import { safeFileName } from './fileShare.js';

/**
 * Temporary web upload sessions.
 *
 *  1. The user opens GET /upload and enters the MCP API key (and, optionally, the GitHub token their
 *     MCP client sends, so the files land in the same sandbox identity the AI is using).
 *  2. The server opens a short-lived upload session (default 10 minutes) and returns a 256-bit token.
 *     Only the token's SHA-256 hash is kept server-side; the page holds the token in memory only
 *     (no cookies, no storage), so closing/reloading the tab ends the session.
 *  3. Files are written into <sandbox root>/web-uploads/ as the unprivileged sandbox user, where the
 *     AI's sandbox tools can read them directly.
 *  4. When the session ends (timer, "end" button, or the tab closing) every file it uploaded is deleted.
 */

export const UPLOAD_DIR = 'web-uploads';

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(min, raw));
}

export const uploadConfig = {
  get enabled() { return process.env.ENABLE_WEB_UPLOAD !== 'false'; },
  get ttlMs() { return Math.floor(num('UPLOAD_SESSION_MINUTES', 10, 0.02, 60) * 60_000); },
  get maxFileBytes() { return Math.floor(num('UPLOAD_MAX_FILE_MB', 25, 0.1, 100) * 1024 * 1024); },
  get maxTotalBytes() { return Math.floor(num('UPLOAD_MAX_TOTAL_MB', 100, 1, 500) * 1024 * 1024); },
  get maxFiles() { return Math.floor(num('UPLOAD_MAX_FILES', 20, 1, 200)); },
  get maxSessions() { return Math.floor(num('UPLOAD_MAX_SESSIONS', 5, 1, 50)); }
};

interface UploadedFile { name: string; size: number; abs: string }

interface UploadSession {
  root: string;
  expiresAt: number;
  files: UploadedFile[];
  bytes: number;
  timer: NodeJS.Timeout;
  /** Serialises writes so name de-duplication and quota checks cannot race. */
  lock: Promise<unknown>;
  ended: boolean;
}

const sessions = new Map<string, UploadSession>(); // key = sha256(token)

function sha256Hex(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

async function endSession(hash: string): Promise<number> {
  const s = sessions.get(hash);
  if (!s || s.ended) return 0;
  s.ended = true;
  clearTimeout(s.timer);
  sessions.delete(hash);
  await s.lock.catch(() => {}); // let an in-flight write finish so it gets deleted too
  let removed = 0;
  for (const f of s.files) {
    try { await sbxRemoveFile(s.root, f.abs); removed++; } catch { /* sandbox may already be gone */ }
  }
  s.files = [];
  return removed;
}

/** Ends every live session and deletes its files (server shutdown). */
export async function shutdownUploadSessions(): Promise<void> {
  await Promise.allSettled([...sessions.keys()].map((h) => endSession(h)));
}

/** Test hook. */
export function activeUploadSessionCount(): number { return sessions.size; }

function isExpired(s: UploadSession): boolean { return Date.now() >= s.expiresAt; }

async function uniqueTarget(root: string, dir: string, wanted: string): Promise<{ name: string; abs: string }> {
  const ext = path.extname(wanted);
  const stem = ext ? wanted.slice(0, -ext.length) : wanted;
  for (let i = 0; i < 200; i++) {
    const name = i === 0 ? wanted : `${stem} (${i})${ext}`;
    const abs = path.join(dir, name);
    if ((await sbxStat(root, abs)).kind === 'missing') return { name, abs };
  }
  throw new Error('Too many files with the same name.');
}

export interface UploadRouteOptions {
  /** The gateway MCP API key the user must present to open a session. */
  apiKey: string;
  /** Server-side default GitHub token (what /mcp falls back to when the client sends none). */
  defaultGithubToken?: string;
  /** Extra origin host allowed to call the API (e.g. from PUBLIC_BASE_URL). */
  publicBaseUrl?: string;
}

function json(res: Response, status: number, body: Record<string, unknown>): void {
  res.status(status).json(body);
}

export function createUploadRouter(opts: UploadRouteOptions): Router {
  const router = Router();
  const apiLimiter = createLimiter({ windowMs: 60_000, max: 240 });
  const failedKeyLimiter = createLimiter({ windowMs: 15 * 60_000, max: 10 });

  let publicHost = '';
  try { if (opts.publicBaseUrl) publicHost = new URL(opts.publicBaseUrl).host; } catch { /* ignore */ }

  router.use((_req, res, next) => {
    if (!uploadConfig.enabled) { json(res, 404, { error: 'Web upload is disabled on this server.' }); return; }
    next();
  });

  // The page is same-origin only: refuse API calls that carry a foreign Origin.
  const sameOrigin = (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      let host = '';
      try { host = new URL(origin).host; } catch { /* invalid */ }
      if (!host || (host !== req.get('host') && host !== publicHost)) { json(res, 403, { error: 'Origin not allowed.' }); return; }
    }
    next();
  };

  const noStore = (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  // ---- Page -----------------------------------------------------------------------------------
  router.get('/', (_req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    res.send(renderUploadPage(nonce, {
      ttlMinutes: Math.round(uploadConfig.ttlMs / 60_000),
      maxFileMb: Math.round((uploadConfig.maxFileBytes / 1024 / 1024) * 10) / 10,
      maxTotalMb: Math.round(uploadConfig.maxTotalBytes / 1024 / 1024),
      maxFiles: uploadConfig.maxFiles,
      folder: UPLOAD_DIR
    }));
  });

  const api = Router();
  api.use(noStore, sameOrigin, rateLimitMiddleware(apiLimiter, 'Too many requests.'));

  // ---- Open a session -------------------------------------------------------------------------
  api.post('/session', express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    const ip = clientIp(req);
    if (!failedKeyLimiter.hit(ip, 0)) {
      res.setHeader('Retry-After', String(failedKeyLimiter.retryAfterSec(ip) || 900));
      json(res, 429, { error: 'Too many failed attempts. Try again later.' });
      return;
    }
    const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    const key = typeof body.apiKey === 'string' ? body.apiKey : '';
    if (!safeEqual(key, opts.apiKey)) {
      failedKeyLimiter.hit(ip);
      json(res, 401, { error: 'Invalid MCP API key.' });
      return;
    }
    failedKeyLimiter.reset(ip);

    try { assertSandboxAllowed(); } catch (e: any) {
      json(res, 503, { error: String(e?.message || 'Sandbox is not available.').slice(0, 300) });
      return;
    }
    if (sessions.size >= uploadConfig.maxSessions) {
      res.setHeader('Retry-After', '60');
      json(res, 503, { error: 'Too many active upload sessions. Try again shortly.' });
      return;
    }

    // Same identity rule as /mcp: x-github-token header, else the server default, else anonymous.
    const clientToken = typeof body.githubToken === 'string' ? body.githubToken.trim().slice(0, 512) : '';
    const authKey = computeAuthKey(clientToken || opts.defaultGithubToken || '');
    const root = sandboxRootForAuthKey(authKey);
    try {
      await ensureSandboxRoot(root);
      await sbxMkdirp(root, path.join(root, UPLOAD_DIR));
    } catch (e: any) {
      console.error('[upload] could not prepare sandbox:', String(e?.message || e).slice(0, 300));
      json(res, 503, { error: 'Could not prepare the sandbox.' });
      return;
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const hash = sha256Hex(token);
    const ttlMs = uploadConfig.ttlMs;
    const session: UploadSession = {
      root, expiresAt: Date.now() + ttlMs, files: [], bytes: 0, lock: Promise.resolve(), ended: false,
      timer: setTimeout(() => { endSession(hash).catch(() => {}); }, ttlMs)
    };
    session.timer.unref();
    sessions.set(hash, session);

    json(res, 201, {
      token,
      remainingMs: ttlMs,
      folder: UPLOAD_DIR,
      limits: { maxFileBytes: uploadConfig.maxFileBytes, maxTotalBytes: uploadConfig.maxTotalBytes, maxFiles: uploadConfig.maxFiles }
    });
  });

  // ---- Everything below needs a live session token -------------------------------------------
  function requireSession(req: Request, res: Response, next: NextFunction): void {
    const token = req.headers['x-upload-token'];
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) { json(res, 401, { error: 'Upload session required.' }); return; }
    const hash = sha256Hex(token);
    const s = sessions.get(hash);
    if (!s || s.ended) { json(res, 401, { error: 'Upload session expired.' }); return; }
    if (isExpired(s)) { endSession(hash).catch(() => {}); json(res, 401, { error: 'Upload session expired.' }); return; }
    res.locals.hash = hash;
    res.locals.session = s;
    next();
  }

  const statusOf = (s: UploadSession) => ({
    remainingMs: Math.max(0, s.expiresAt - Date.now()),
    folder: UPLOAD_DIR,
    bytes: s.bytes,
    files: s.files.map((f) => ({ name: f.name, size: f.size, path: `${UPLOAD_DIR}/${f.name}` }))
  });

  api.get('/session', requireSession, (_req, res) => {
    json(res, 200, statusOf(res.locals.session as UploadSession));
  });

  api.post('/files',
    requireSession,
    (req, res, next) => {
      // Reject early, before buffering a body that cannot fit.
      const s = res.locals.session as UploadSession;
      const len = Number(req.headers['content-length']);
      if (Number.isFinite(len) && len > uploadConfig.maxFileBytes) { json(res, 413, { error: `File exceeds the ${Math.round(uploadConfig.maxFileBytes / 1024 / 1024)}MB per-file limit.` }); return; }
      if (Number.isFinite(len) && s.bytes + len > uploadConfig.maxTotalBytes) { json(res, 413, { error: 'Session storage limit reached.' }); return; }
      next();
    },
    express.raw({ type: () => true, limit: uploadConfig.maxFileBytes }),
    async (req: Request, res: Response) => {
      const s = res.locals.session as UploadSession;
      const data = req.body;
      if (!Buffer.isBuffer(data) || data.length === 0) { json(res, 400, { error: 'Empty file.' }); return; }

      let rawName = '';
      try { rawName = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { rawName = ''; }
      const wanted = safeFileName(rawName);

      const result = s.lock.then(async () => {
        if (s.ended || isExpired(s)) throw Object.assign(new Error('Upload session expired.'), { status: 401 });
        if (s.files.length >= uploadConfig.maxFiles) throw Object.assign(new Error(`File count limit reached (${uploadConfig.maxFiles}).`), { status: 413 });
        if (s.bytes + data.length > uploadConfig.maxTotalBytes) throw Object.assign(new Error('Session storage limit reached.'), { status: 413 });

        const dir = path.join(s.root, UPLOAD_DIR);
        await sbxMkdirp(s.root, dir); // recreated if the sandbox was reset meanwhile
        const { name, abs } = await uniqueTarget(s.root, dir, wanted);
        await assertInsideRealRoot(s.root, abs);
        await sbxWriteText(s.root, abs, data, false);
        s.files.push({ name, size: data.length, abs });
        s.bytes += data.length;
        return { name, size: data.length, path: `${UPLOAD_DIR}/${name}` };
      });
      s.lock = result.catch(() => {});

      try {
        json(res, 201, { file: await result, ...statusOf(s) });
      } catch (e: any) {
        const status = Number(e?.status) || 500;
        if (status === 500) console.error('[upload] write failed:', String(e?.message || e).slice(0, 300));
        json(res, status, { error: status === 500 ? 'Could not store the file.' : String(e.message) });
      }
    }
  );

  // Explicit end (button) and tab-close beacon (token in body, since sendBeacon cannot set headers).
  api.post('/end', express.json({ limit: '2kb', type: () => true }), async (req: Request, res: Response) => {
    const headerToken = req.headers['x-upload-token'];
    const bodyToken = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).token : undefined;
    const token = typeof headerToken === 'string' ? headerToken : typeof bodyToken === 'string' ? bodyToken : '';
    if (!TOKEN_RE.test(token)) { json(res, 400, { error: 'Bad token.' }); return; }
    const deleted = await endSession(sha256Hex(token));
    json(res, 200, { ended: true, deleted });
  });

  api.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err?.type === 'entity.too.large') { json(res, 413, { error: `File exceeds the ${Math.round(uploadConfig.maxFileBytes / 1024 / 1024)}MB per-file limit.` }); return; }
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) { json(res, 400, { error: 'Bad request.' }); return; }
    console.error('[upload] error:', String(err?.message || err).slice(0, 300));
    json(res, 500, { error: 'Internal server error.' });
  });

  router.use('/api', api);
  return router;
}

export function registerUploadRoutes(app: Express, opts: UploadRouteOptions): void {
  app.use('/upload', createUploadRouter(opts));
}

// -------------------------------------------------------------------------------------------------
// Page
// -------------------------------------------------------------------------------------------------

interface PageInfo { ttlMinutes: number; maxFileMb: number; maxTotalMb: number; maxFiles: number; folder: string }

function renderUploadPage(nonce: string, info: PageInfo): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Krix Upload</title>
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="48x48" href="/icon-48.png">
<style nonce="${nonce}">
  :root { color-scheme: dark; --bg:#0d1117; --card:#161b22; --line:#30363d; --fg:#c9d1d9; --dim:#8b949e; --hi:#f0f6fc; --ok:#238636; --bad:#f85149; --accent:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .card { width:100%; max-width:520px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; box-shadow:0 8px 24px rgba(0,0,0,.4); }
  header { display:flex; align-items:center; gap:12px; margin-bottom:6px; }
  header img { width:40px; height:40px; border-radius:10px; }
  h1 { margin:0; font-size:20px; color:var(--hi); }
  p.sub { margin:4px 0 20px; color:var(--dim); font-size:13px; }
  label { display:block; font-size:13px; color:var(--dim); margin:14px 0 6px; }
  input[type=password], input[type=text] { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--hi); font:inherit; }
  input:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  details { margin-top:12px; font-size:13px; color:var(--dim); }
  details summary { cursor:pointer; }
  button { font:inherit; cursor:pointer; border-radius:8px; border:1px solid var(--line); padding:10px 16px; background:#21262d; color:var(--hi); }
  button.primary { background:var(--ok); border-color:var(--ok); font-weight:600; width:100%; margin-top:18px; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .err { color:var(--bad); font-size:13px; margin-top:12px; min-height:1em; }
  .bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
  .timer { font-variant-numeric:tabular-nums; font-weight:600; color:var(--hi); }
  .timer.low { color:var(--bad); }
  .drop { border:2px dashed var(--line); border-radius:10px; padding:28px 16px; text-align:center; color:var(--dim); cursor:pointer; transition:border-color .15s, background .15s; }
  .drop.over, .drop:focus-visible { border-color:var(--accent); background:rgba(88,166,255,.06); outline:none; }
  ul { list-style:none; margin:14px 0 0; padding:0; }
  li { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-top:1px solid var(--line); font-size:13px; }
  li .n { overflow-wrap:anywhere; color:var(--hi); }
  li .m { color:var(--dim); white-space:nowrap; }
  li.fail .m { color:var(--bad); }
  .note { margin-top:16px; font-size:12px; color:var(--dim); }
  .note.nomargin { margin:0; }
  code { background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:1px 5px; color:var(--hi); }
  .row { display:flex; gap:8px; margin-top:16px; }
  .row button { flex:1; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main class="card">
  <header><img src="/icon-48.png" alt=""><h1>Krix Upload</h1></header>

  <section id="login">
    <p class="sub">Drop files here for your AI to use in its sandbox. Enter your MCP API key to open a temporary ${info.ttlMinutes}-minute session. Files are deleted when it ends.</p>
    <form id="loginForm" autocomplete="off">
      <label for="key">MCP API key</label>
      <input id="key" type="password" autocomplete="off" spellcheck="false" required>
      <details>
        <summary>Advanced</summary>
        <label for="gh">GitHub token (only if your MCP client sends its own <code>x-github-token</code>)</label>
        <input id="gh" type="password" autocomplete="off" spellcheck="false">
      </details>
      <button class="primary" id="start" type="submit">Start ${info.ttlMinutes}-minute session</button>
      <div class="err" id="loginErr" role="alert"></div>
    </form>
  </section>

  <section id="session" hidden>
    <div class="bar"><span>Session ends in <span class="timer" id="timer">--:--</span></span><span id="usage" class="note nomargin"></span></div>
    <div class="drop" id="drop" tabindex="0" role="button" aria-label="Choose files to upload">Drop files here or click to choose<br><small>Up to ${info.maxFiles} files, ${info.maxFileMb} MB each, ${info.maxTotalMb} MB total</small></div>
    <input id="picker" type="file" multiple hidden>
    <ul id="list"></ul>
    <div class="err" id="upErr" role="alert"></div>
    <p class="note">Files are saved in your sandbox at <code>${info.folder}/&lt;filename&gt;</code>. Tell your AI to look there.</p>
    <div class="row"><button id="end" type="button">End session &amp; delete files</button></div>
  </section>
</main>
<script nonce="${nonce}">
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let token = null, endsAt = 0, tick = null, limits = null;

  const fmt = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

  function show(loggedIn) {
    $('login').hidden = loggedIn;
    $('session').hidden = !loggedIn;
  }

  function reset(msg) {
    token = null; clearInterval(tick); tick = null;
    $('list').textContent = ''; $('upErr').textContent = ''; $('usage').textContent = '';
    show(false);
    $('loginErr').textContent = msg || '';
  }

  function startTimer(remainingMs) {
    endsAt = performance.now() + remainingMs;
    clearInterval(tick);
    const render = () => {
      const left = Math.max(0, endsAt - performance.now());
      const s = Math.ceil(left / 1000);
      const el = $('timer');
      el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      el.classList.toggle('low', s <= 60);
      if (left <= 0) reset('Session expired. Your uploaded files were deleted.');
    };
    render();
    tick = setInterval(render, 500);
  }

  async function api(path, opts) {
    const res = await fetch('/upload/api' + path, opts);
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) { const e = new Error(data.error || 'Request failed (' + res.status + ').'); e.status = res.status; throw e; }
    return data;
  }

  $('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('loginErr').textContent = '';
    $('start').disabled = true;
    try {
      const data = await api('/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: $('key').value, githubToken: $('gh').value })
      });
      $('key').value = ''; $('gh').value = '';
      token = data.token; limits = data.limits;
      show(true);
      startTimer(data.remainingMs);
    } catch (e) {
      $('loginErr').textContent = e.message;
    } finally {
      $('start').disabled = false;
    }
  });

  function addRow(name) {
    const li = document.createElement('li');
    const n = document.createElement('span'); n.className = 'n'; n.textContent = name;
    const m = document.createElement('span'); m.className = 'm'; m.textContent = 'uploading…';
    li.append(n, m);
    $('list').prepend(li);
    return { li, n, m };
  }

  function sendOne(file, row) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/upload/api/files');
      xhr.setRequestHeader('x-upload-token', token);
      xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) row.m.textContent = Math.round(e.loaded / e.total * 100) + '%'; };
      xhr.onload = () => {
        let d = {}; try { d = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status === 201) {
          row.n.textContent = d.file.path; row.m.textContent = fmt(d.file.size);
          $('usage').textContent = d.files.length + ' file(s), ' + fmt(d.bytes);
        } else {
          row.li.className = 'fail'; row.m.textContent = d.error || 'failed';
          if (xhr.status === 401) reset('Session expired. Your uploaded files were deleted.');
        }
        resolve();
      };
      xhr.onerror = () => { row.li.className = 'fail'; row.m.textContent = 'network error'; resolve(); };
      xhr.send(file);
    });
  }

  async function upload(files) {
    $('upErr').textContent = '';
    for (const f of files) {
      if (!token) return;
      const row = addRow(f.name);
      if (f.size === 0) { row.li.className = 'fail'; row.m.textContent = 'empty file'; continue; }
      if (limits && f.size > limits.maxFileBytes) { row.li.className = 'fail'; row.m.textContent = 'too large'; continue; }
      await sendOne(f, row);
    }
  }

  const drop = $('drop'), picker = $('picker');
  drop.addEventListener('click', () => picker.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
  picker.addEventListener('change', () => { const f = [...picker.files]; picker.value = ''; upload(f); });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => upload([...e.dataTransfer.files]));
  // Stop the browser from navigating to a file dropped outside the drop zone.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('end').addEventListener('click', async () => {
    const t = token;
    reset('Session ended. Your uploaded files were deleted.');
    if (t) { try { await api('/end', { method: 'POST', headers: { 'x-upload-token': t, 'content-type': 'application/json' }, body: '{}' }); } catch (_) {} }
  });

  // Closing or leaving the page ends the session right away (the server timer is the backstop).
  window.addEventListener('pagehide', () => {
    if (token) navigator.sendBeacon('/upload/api/end', new Blob([JSON.stringify({ token })], { type: 'application/json' }));
  });
})();
</script>
</body>
</html>`;
}
