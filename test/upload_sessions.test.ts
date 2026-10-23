import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { computeAuthKey, sandboxRootForAuthKey } from '../src/security.js';
import { registerUploadRoutes, activeUploadSessionCount, shutdownUploadSessions, UPLOAD_DIR } from '../src/uploadSessions.js';

const API_KEY = 'test-key-0123456789-0123456789';
const GH = 'ghp_test_default_token';

describe('web upload sessions', () => {
  let server: http.Server;
  let base = '';
  const root = sandboxRootForAuthKey(computeAuthKey(GH));

  before(async () => {
    process.env.UPLOAD_SESSION_MINUTES = '10';
    process.env.UPLOAD_MAX_FILE_MB = '0.1';
    process.env.UPLOAD_MAX_FILES = '3';
    const app = express();
    registerUploadRoutes(app, { apiKey: API_KEY, defaultGithubToken: GH });
    server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await shutdownUploadSessions();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const open = (apiKey: string) => fetch(`${base}/upload/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey })
  });
  const send = (token: string, name: string, body: Buffer | string) => fetch(`${base}/upload/api/files`, {
    method: 'POST', headers: { 'x-upload-token': token, 'x-filename': encodeURIComponent(name) }, body
  });
  const end = (token: string) => fetch(`${base}/upload/api/end`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token })
  });

  test('page is served with a nonce-based CSP', async () => {
    const res = await fetch(`${base}/upload`, { redirect: 'manual' });
    const r = res.status === 301 || res.status === 302 ? await fetch(`${base}/upload/`) : res;
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy') || '', /script-src 'nonce-/);
    assert.match(await r.text(), /MCP API key/);
  });

  test('wrong key is rejected and creates no session', async () => {
    const before = activeUploadSessionCount();
    assert.equal((await open('nope')).status, 401);
    assert.equal(activeUploadSessionCount(), before);
  });

  test('upload requires a valid token', async () => {
    assert.equal((await send('x'.repeat(43), 'a.txt', 'hi')).status, 401);
    assert.equal((await fetch(`${base}/upload/api/files`, { method: 'POST', body: 'hi' })).status, 401);
  });

  test('foreign Origin is refused', async () => {
    const res = await fetch(`${base}/upload/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ apiKey: API_KEY })
    });
    assert.equal(res.status, 403);
  });

  test('full lifecycle: files land in sandbox and vanish when the session ends', async () => {
    const res = await open(API_KEY);
    assert.equal(res.status, 201);
    const { token, remainingMs, folder } = await res.json() as any;
    assert.equal(folder, UPLOAD_DIR);
    assert.ok(remainingMs > 9 * 60_000 && remainingMs <= 10 * 60_000);

    const a = await send(token, '../../etc/pass wd.txt', 'hello');
    assert.equal(a.status, 201);
    const aj = await a.json() as any;
    assert.equal(aj.file.path.startsWith(`${UPLOAD_DIR}/`), true);
    assert.ok(!aj.file.name.includes('/') && !aj.file.name.includes('..'));
    const abs1 = path.join(root, aj.file.path);
    assert.equal(fs.readFileSync(abs1, 'utf8'), 'hello');

    // Same name again is de-duplicated, not overwritten.
    const b = await (await send(token, 'notes.txt', 'one')).json() as any;
    const c = await (await send(token, 'notes.txt', 'two')).json() as any;
    assert.equal(b.file.name, 'notes.txt');
    assert.equal(c.file.name, 'notes (1).txt');

    // Count limit (3).
    assert.equal((await send(token, 'd.txt', 'four')).status, 413);
    // Empty and oversize files.
    assert.equal((await send(token, 'e.txt', '')).status, 400);

    const status = await (await fetch(`${base}/upload/api/session`, { headers: { 'x-upload-token': token } })).json() as any;
    assert.equal(status.files.length, 3);

    const ended = await (await end(token)).json() as any;
    assert.equal(ended.deleted, 3);
    assert.equal(fs.existsSync(abs1), false);
    assert.equal(fs.existsSync(path.join(root, UPLOAD_DIR, 'notes.txt')), false);
    assert.equal((await send(token, 'late.txt', 'x')).status, 401);
  });

  test('per-file size limit returns 413', async () => {
    const { token } = await (await open(API_KEY)).json() as any;
    assert.equal((await send(token, 'big.bin', Buffer.alloc(200 * 1024, 1))).status, 413);
    await end(token);
  });

  test('session expires on its own and deletes its files', async () => {
    process.env.UPLOAD_SESSION_MINUTES = '0.02'; // ~1.2s
    const { token } = await (await open(API_KEY)).json() as any;
    process.env.UPLOAD_SESSION_MINUTES = '10';
    const f = await (await send(token, 'temp.txt', 'bye')).json() as any;
    const abs = path.join(root, f.file.path);
    assert.equal(fs.existsSync(abs), true);
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(fs.existsSync(abs), false);
    assert.equal((await send(token, 'again.txt', 'x')).status, 401);
  });
});
