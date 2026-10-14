import crypto from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Express, Request, Response } from 'express';
import { MongoClient, GridFSBucket, ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import {
  formatOptimizedResponse, formatError, getToolAnnotations, makeRegistrar, getAuthKeyForSession, sanitizeOutput
} from './security.js';
import { createLimiter, rateLimitMiddleware } from './rateLimit.js';
import { resolveSandboxFile } from './sandboxTools.js';
import { sbxReadBytes, sbxStat, sbxMkdirp, sbxWriteText, assertSandboxAllowed } from './sandboxProc.js';

/**
 * Sandbox file tool (share / list / delete / download). Secure file sharing: files created by the AI (in the sandbox, or inline) are stored in MongoDB GridFS
 * and exposed through an unguessable, expiring download link.
 *
 *  - Link = 256-bit random token. Only its SHA-256 hash is stored, so a database leak does not reveal live links.
 *  - Every file expires (default and maximum 48h) and is physically deleted (file + chunks) by a sweeper.
 *  - Files are always served as attachments with nosniff + a sandboxing CSP; active content types are
 *    downgraded to application/octet-stream so a shared .html/.svg can never run in the server's origin.
 *  - Ownership: only the identity that created a file can list or delete it.
 *  - Quotas: per-file size, per-owner file count / total bytes, and per-owner upload rate.
 */

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(min, raw));
}

export const fileConfig = {
  get ttlHours() { return num('FILE_TTL_HOURS', 48, 1, 48); },
  get maxFileBytes() { return Math.floor(num('FILE_MAX_MB', 25, 0.1, 100) * 1024 * 1024); },
  get maxFilesPerOwner() { return Math.floor(num('FILE_MAX_PER_OWNER', 50, 1, 1000)); },
  get maxBytesPerOwner() { return Math.floor(num('FILE_MAX_TOTAL_MB_PER_OWNER', 200, 1, 5000) * 1024 * 1024); },
  get inlineMaxBytes() { return Math.min(10 * 1024 * 1024, this.maxFileBytes); },
  get dbName() { return process.env.MONGODB_DB || 'krix'; }
};

const BUCKET = 'krix_files';

// ---------------------------------------------------------------------------------------------
// Store abstraction (Mongo GridFS in production; swappable in tests)
// ---------------------------------------------------------------------------------------------

export interface StoredFileMeta {
  id: string;
  name: string;
  size: number;
  contentType: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface FileStore {
  put(meta: { name: string; contentType: string; ownerKey: string; tokenHash: string; expiresAt: Date }, data: Buffer): Promise<StoredFileMeta>;
  openByTokenHash(tokenHash: string): Promise<(StoredFileMeta & { stream: Readable }) | null>;
  listByOwner(ownerKey: string): Promise<StoredFileMeta[]>;
  usage(ownerKey: string): Promise<{ count: number; bytes: number }>;
  deleteOwned(ownerKey: string, id: string): Promise<boolean>;
  deleteAllOwned(ownerKey: string): Promise<number>;
  sweepExpired(): Promise<number>;
  close(): Promise<void>;
}

class MongoFileStore implements FileStore {
  private clientPromise: Promise<MongoClient> | null = null;
  private bucketPromise: Promise<{ db: Db; bucket: GridFSBucket }> | null = null;

  private async init(): Promise<{ db: Db; bucket: GridFSBucket }> {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('File storage is not configured: MONGODB_URI is not set on the server.');
    if (!this.bucketPromise) {
      this.bucketPromise = (async () => {
        this.clientPromise = new MongoClient(uri, {
          serverSelectionTimeoutMS: 8000,
          connectTimeoutMS: 8000,
          maxPoolSize: 10,
          appName: 'krix-files'
        }).connect();
        const client = await this.clientPromise;
        const db = client.db(fileConfig.dbName);
        const files = db.collection(`${BUCKET}.files`);
        await Promise.all([
          files.createIndex({ 'metadata.tokenHash': 1 }, { unique: true, sparse: true }),
          files.createIndex({ 'metadata.ownerKey': 1, 'metadata.expiresAt': 1 }),
          files.createIndex({ 'metadata.expiresAt': 1 })
        ]);
        return { db, bucket: new GridFSBucket(db, { bucketName: BUCKET }) };
      })().catch((e) => {
        this.bucketPromise = null;
        this.clientPromise = null;
        console.error('[files] MongoDB init failed:', sanitizeOutput(String(e?.message || e)));
        throw new Error('File storage is temporarily unavailable.');
      });
    }
    return this.bucketPromise;
  }

  private static toMeta(doc: any): StoredFileMeta {
    return {
      id: String(doc._id),
      name: doc.filename,
      size: doc.length,
      contentType: doc.metadata?.contentType || 'application/octet-stream',
      createdAt: doc.uploadDate,
      expiresAt: new Date(doc.metadata?.expiresAt)
    };
  }

  async put(meta: { name: string; contentType: string; ownerKey: string; tokenHash: string; expiresAt: Date }, data: Buffer): Promise<StoredFileMeta> {
    const { bucket } = await this.init();
    const up = bucket.openUploadStream(meta.name, {
      metadata: { ownerKey: meta.ownerKey, tokenHash: meta.tokenHash, contentType: meta.contentType, expiresAt: meta.expiresAt }
    });
    await new Promise<void>((resolve, reject) => {
      up.once('finish', () => resolve());
      up.once('error', reject);
      up.end(data);
    }).catch(async (e) => {
      await up.abort().catch(() => {});
      throw e;
    });
    return { id: String(up.id), name: meta.name, size: data.length, contentType: meta.contentType, createdAt: new Date(), expiresAt: meta.expiresAt };
  }

  async openByTokenHash(tokenHash: string) {
    const { bucket } = await this.init();
    const doc = await bucket.find({ 'metadata.tokenHash': tokenHash }).limit(1).next();
    if (!doc) return null;
    if (!doc.metadata?.expiresAt || new Date(doc.metadata.expiresAt).getTime() <= Date.now()) return null;
    return { ...MongoFileStore.toMeta(doc), stream: bucket.openDownloadStream(doc._id) as unknown as Readable };
  }

  async listByOwner(ownerKey: string): Promise<StoredFileMeta[]> {
    const { bucket } = await this.init();
    const docs = await bucket.find({ 'metadata.ownerKey': ownerKey, 'metadata.expiresAt': { $gt: new Date() } }).sort({ uploadDate: -1 }).limit(200).toArray();
    return docs.map(MongoFileStore.toMeta);
  }

  async usage(ownerKey: string): Promise<{ count: number; bytes: number }> {
    const { db } = await this.init();
    const rows = await db.collection(`${BUCKET}.files`).aggregate([
      { $match: { 'metadata.ownerKey': ownerKey, 'metadata.expiresAt': { $gt: new Date() } } },
      { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: '$length' } } }
    ]).toArray();
    return rows[0] ? { count: rows[0].count, bytes: rows[0].bytes } : { count: 0, bytes: 0 };
  }

  async deleteOwned(ownerKey: string, id: string): Promise<boolean> {
    if (!/^[a-f0-9]{24}$/i.test(id)) return false;
    const { bucket } = await this.init();
    const _id = new ObjectId(id);
    // Ownership check happens in the query itself, never from client-provided data.
    const doc = await bucket.find({ _id, 'metadata.ownerKey': ownerKey }).limit(1).next();
    if (!doc) return false;
    await bucket.delete(_id);
    return true;
  }

  async deleteAllOwned(ownerKey: string): Promise<number> {
    const { bucket } = await this.init();
    const docs = await bucket.find({ 'metadata.ownerKey': ownerKey }).limit(1000).toArray();
    for (const d of docs) await bucket.delete(d._id).catch(() => {});
    return docs.length;
  }

  private sweepCount = 0;

  async sweepExpired(): Promise<number> {
    const { db, bucket } = await this.init();
    const expired = await bucket.find({ 'metadata.expiresAt': { $lte: new Date() } }).limit(500).toArray();
    let deleted = 0;
    for (const f of expired) {
      try { await bucket.delete(f._id); deleted++; } catch (e: any) {
        // Chunks may already be gone (partial earlier delete); make sure the file doc is removed too.
        await db.collection(`${BUCKET}.files`).deleteOne({ _id: f._id }).catch(() => {});
      }
    }
    // Hourly: remove orphaned chunks left by interrupted uploads/deletes.
    if (++this.sweepCount % 6 === 0) {
      const ids = await db.collection(`${BUCKET}.chunks`).aggregate([{ $group: { _id: '$files_id' } }, { $limit: 2000 }]).toArray();
      if (ids.length) {
        const alive = new Set((await db.collection(`${BUCKET}.files`).find({ _id: { $in: ids.map((i: any) => i._id) } }, { projection: { _id: 1 } }).toArray()).map((d: any) => String(d._id)));
        const orphans = ids.map((i: any) => i._id).filter((id: any) => !alive.has(String(id)));
        if (orphans.length) await db.collection(`${BUCKET}.chunks`).deleteMany({ files_id: { $in: orphans } });
      }
    }
    return deleted;
  }

  async close(): Promise<void> {
    const p = this.clientPromise;
    this.clientPromise = null;
    this.bucketPromise = null;
    if (p) await (await p.catch(() => null))?.close().catch(() => {});
  }
}

let activeStore: FileStore | null = null;
export function getFileStore(): FileStore {
  if (!activeStore) activeStore = new MongoFileStore();
  return activeStore;
}
/** Test hook / alternative backends. */
export function setFileStore(store: FileStore | null): void { activeStore = store; }

let sweeperTimer: NodeJS.Timeout | undefined;
export function startFileSweeper(): void {
  if (sweeperTimer || !process.env.MONGODB_URI) return;
  const run = () => { getFileStore().sweepExpired().catch((e) => console.error('[files] sweep failed:', sanitizeOutput(String(e?.message || e)))); };
  setTimeout(run, 5000).unref();
  sweeperTimer = setInterval(run, 10 * 60 * 1000);
  sweeperTimer.unref();
}
export async function stopFileStore(): Promise<void> {
  if (sweeperTimer) { clearInterval(sweeperTimer); sweeperTimer = undefined; }
  if (activeStore) await activeStore.close().catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip', '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.log': 'text/plain', '.yaml': 'text/plain', '.yml': 'text/plain',
  '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain', '.py': 'text/x-python', '.sh': 'text/plain',
  '.css': 'text/css', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};
// Active content: browsers could execute these if served inline from our origin, so they are always
// delivered as opaque downloads (the user can still save and open them locally).
const ACTIVE_EXTS = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs', '.cjs', '.swf', '.xsl', '.xslt']);

export function contentTypeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ACTIVE_EXTS.has(ext)) return 'application/octet-stream';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

export function safeFileName(raw: unknown): string {
  let name = path.basename(String(raw ?? '').replace(/\\/g, '/'));
  name = name.normalize('NFKC').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[^\p{L}\p{N}._\- ()+,@]/gu, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  name = name.replace(/^\.+/, '');
  return name || 'file';
}

function sha256Hex(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function decodeBase64Strict(b64: string): Buffer {
  const clean = b64.replace(/\s+/g, '');
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('content_b64 is not valid base64.');
  return Buffer.from(clean, 'base64');
}

const uploadLimiter = createLimiter({ windowMs: 60_000, max: 20 });

export interface ShareInput {
  filename?: string;
  content?: string;
  content_b64?: string;
  sandboxPath?: string;
  dir?: string;
  ttlHours?: number;
}

export async function shareFile(
  sessionId: string,
  input: ShareInput,
  baseUrl: string
): Promise<{ id: string; name: string; sizeBytes: number; contentType: string; downloadUrl: string; expiresAt: string; expiresInHours: number }> {
  const ownerKey = getAuthKeyForSession(sessionId);
  if (!uploadLimiter.hit(ownerKey)) throw new Error('Upload rate limit reached (20/min). Wait a moment and retry.');

  const sources = [input.content !== undefined, input.content_b64 !== undefined, input.sandboxPath !== undefined].filter(Boolean).length;
  if (sources !== 1) throw new Error('Provide exactly one of: sandboxPath, content, content_b64.');

  const store = getFileStore();
  const limit = fileConfig.maxFileBytes;
  let data: Buffer;
  let name: string;

  if (input.sandboxPath !== undefined) {
    assertSandboxAllowed();
    const { root, abs } = await resolveSandboxFile(sessionId, input.sandboxPath, input.dir);
    const st = await sbxStat(root, abs);
    if (st.kind === 'missing') throw new Error(`No such file in the sandbox: ${input.sandboxPath}`);
    if (st.kind !== 'file') throw new Error('sandboxPath must be a regular file (zip a directory first, e.g. with sandbox_exec `zip -r out.zip dir`).');
    if (st.size > limit) throw new Error(`File is ${(st.size / 1024 / 1024).toFixed(1)}MB; the limit is ${(limit / 1024 / 1024).toFixed(0)}MB.`);
    data = await sbxReadBytes(root, abs, limit);
    name = safeFileName(input.filename || path.basename(abs));
  } else {
    if (!input.filename) throw new Error('filename is required when sharing inline content.');
    data = input.content !== undefined ? Buffer.from(input.content, 'utf8') : decodeBase64Strict(input.content_b64!);
    if (data.length > fileConfig.inlineMaxBytes) throw new Error(`Inline content is limited to ${(fileConfig.inlineMaxBytes / 1024 / 1024).toFixed(0)}MB; create the file in the sandbox and use sandboxPath instead.`);
    name = safeFileName(input.filename);
  }

  if (data.length === 0) throw new Error('Refusing to share an empty file.');
  if (data.length > limit) throw new Error(`File exceeds the ${(limit / 1024 / 1024).toFixed(0)}MB limit.`);

  const usage = await store.usage(ownerKey);
  if (usage.count >= fileConfig.maxFilesPerOwner) throw new Error(`File quota reached (${fileConfig.maxFilesPerOwner} active files). Delete some with sandbox_store action:delete.`);
  if (usage.bytes + data.length > fileConfig.maxBytesPerOwner) throw new Error('Storage quota reached. Delete some files with sandbox_store action:delete.');

  const ttl = Math.min(Math.max(1, Math.floor(input.ttlHours ?? fileConfig.ttlHours)), fileConfig.ttlHours);
  const expiresAt = new Date(Date.now() + ttl * 3600 * 1000);
  const token = crypto.randomBytes(32).toString('base64url');
  const contentType = contentTypeFor(name);

  const meta = await store.put({ name, contentType, ownerKey, tokenHash: sha256Hex(token), expiresAt }, data);
  const base = (process.env.PUBLIC_BASE_URL?.trim() || baseUrl).replace(/\/+$/, '');
  return {
    id: meta.id,
    name,
    sizeBytes: data.length,
    contentType,
    downloadUrl: `${base}/files/${token}/${encodeURIComponent(name)}`,
    expiresAt: expiresAt.toISOString(),
    expiresInHours: ttl
  };
}

// ---------------------------------------------------------------------------------------------
// Internet downloads into the sandbox
// ---------------------------------------------------------------------------------------------

/** True for loopback, private, link-local, CGNAT, multicast, metadata and other non-public addresses. */
export function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (family === 6) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') ||
      /^fe[89ab]/.test(v) || v.startsWith('ff') || v.startsWith('2001:db8');
  }
  return true;
}

function downloadMaxBytes(): number { return Math.floor(num('DOWNLOAD_MAX_MB', 50, 1, 500) * 1024 * 1024); }
const allowPrivateDownloads = () => process.env.ALLOW_PRIVATE_DOWNLOADS === 'true';

interface Fetched { body: Buffer; contentType: string; finalUrl: string; suggestedName?: string }

async function httpGetPinned(urlStr: string, maxBytes: number, deadline: number): Promise<{ redirect?: string; status: number; res?: Fetched }> {
  const url = new URL(urlStr);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs can be downloaded.');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.');

  // Resolve once, validate every address, then connect to exactly that address (defeats DNS rebinding).
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error(`Could not resolve ${host}.`);
  if (!allowPrivateDownloads() && addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('Refusing to download from a private/internal address (set ALLOW_PRIVATE_DOWNLOADS=true to allow).');
  }
  const pick = addrs[0];

  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const timeLeft = deadline - Date.now();
    if (timeLeft <= 0) { reject(new Error('Download timed out.')); return; }
    const req = mod.request(url, {
      method: 'GET',
      timeout: Math.min(timeLeft, 30000),
      headers: { 'User-Agent': 'krix-sandbox/1.0', 'Accept': '*/*', 'Accept-Encoding': 'identity' },
      lookup: ((_h: string, opts: any, cb: any) => (opts?.all ? cb(null, [{ address: pick.address, family: pick.family }]) : cb(null, pick.address, pick.family))) as any,
      servername: net.isIP(host) ? undefined : host
    } as any, (res) => {
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if (status >= 300 && status < 400 && loc) { res.resume(); resolve({ status, redirect: new URL(loc, url).toString() }); return; }
      if (status < 200 || status >= 300) { res.resume(); reject(new Error(`Download failed: HTTP ${status}.`)); return; }
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > maxBytes) { res.destroy(); reject(new Error(`File is ${(declared / 1048576).toFixed(1)}MB; the download limit is ${Math.round(maxBytes / 1048576)}MB.`)); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      const killTimer = setTimeout(() => res.destroy(new Error('Download timed out.')), Math.max(1, deadline - Date.now()));
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(new Error(`Download exceeded the ${Math.round(maxBytes / 1048576)}MB limit.`)); return; }
        chunks.push(c);
      });
      res.on('error', (e) => { clearTimeout(killTimer); reject(e); });
      res.on('end', () => {
        clearTimeout(killTimer);
        const cd = String(res.headers['content-disposition'] || '');
        const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
        let suggested: string | undefined;
        if (m) { try { suggested = decodeURIComponent(m[1]); } catch { suggested = m[1]; } }
        resolve({ status, res: { body: Buffer.concat(chunks), contentType: String(res.headers['content-type'] || ''), finalUrl: url.toString(), suggestedName: suggested } });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Connection timed out.')));
    req.on('error', reject);
    req.end();
  });
}

export async function downloadToSandbox(sessionId: string, input: { url: string; filename?: string; dir?: string }) {
  assertSandboxAllowed();
  const maxBytes = downloadMaxBytes();
  const deadline = Date.now() + 90_000;
  let current = input.url;
  let fetched: Fetched | undefined;
  for (let hop = 0; hop <= 5; hop++) {
    const r = await httpGetPinned(current, maxBytes, deadline);
    if (r.redirect) { current = r.redirect; continue; }
    fetched = r.res;
    break;
  }
  if (!fetched) throw new Error('Too many redirects.');
  if (fetched.body.length === 0) throw new Error('The server returned an empty file.');

  const urlName = decodeURIComponentSafe(path.basename(new URL(fetched.finalUrl).pathname));
  const name = safeFileName(input.filename || fetched.suggestedName || urlName || 'download');
  const { root, abs } = await resolveSandboxFile(sessionId, name, input.dir);
  await sbxMkdirp(root, path.dirname(abs));
  await sbxWriteText(root, abs, fetched.body, false);
  return {
    path: path.relative(root, abs),
    absolutePath: abs,
    name,
    sizeBytes: fetched.body.length,
    contentType: fetched.contentType.split(';')[0] || 'unknown',
    sha256: crypto.createHash('sha256').update(fetched.body).digest('hex'),
    note: 'Saved in the sandbox. Use sandbox_exec/sandbox_run to process it, or sandbox_store action:share to hand it to the user.'
  };
}

function decodeURIComponentSafe(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

// ---------------------------------------------------------------------------------------------
// MCP tool: sandbox_store (share / list / delete / download)
// ---------------------------------------------------------------------------------------------

export function registerFileTools(server: any, sessionId: string, registry: Record<string, any>, getBaseUrl: () => string) {
  const reg = makeRegistrar(server, registry);

  reg('sandbox_store', {
    description:
      'Move files between the sandbox, the internet and the user. Actions:\n' +
      '- share: upload a sandbox file (sandboxPath) or small inline content (content/content_b64 + filename) to MongoDB and get a private downloadUrl — GIVE THAT URL TO THE USER. Files auto-delete after at most 48h (ttlHours can only shorten).\n' +
      '- list: list your active shared files (id, name, size, expiry; links are only shown at share time).\n' +
      '- delete: delete a shared file by id (or all:true), which also kills its link.\n' +
      '- download: fetch a file from an http(s) URL into the sandbox (url, optional filename/dir). Private/internal addresses are refused.\n' +
      'Typical flow: download or create a file -> process it with sandbox_run / sandbox_exec (convert images, zip/unzip, generate code) -> share it.',
    inputSchema: {
      action: z.enum(['share', 'list', 'delete', 'download']),
      sandboxPath: z.string().max(1024).optional().describe('share: path of a regular file in the sandbox (relative to the sandbox working dir, or to `dir`).'),
      dir: z.string().max(1024).optional().describe('share/download: sandbox directory that paths are relative to / the file is saved in.'),
      filename: z.string().max(255).optional().describe('share: download name (required for inline content). download: name to save as.'),
      content: z.string().optional().describe('share: inline UTF-8 text (small files).'),
      content_b64: z.string().optional().describe('share: inline base64 (small binary files).'),
      ttlHours: z.number().int().min(1).max(48).optional().describe('share: hours until auto-deletion (default and maximum 48).'),
      id: z.string().regex(/^[a-fA-F0-9]{24}$/, 'id must be a 24-character hex file id').optional().describe('delete: id of the shared file.'),
      all: z.boolean().optional().describe('delete: delete every file you shared.'),
      url: z.string().url().max(2048).optional().describe('download: http(s) URL to fetch.')
    },
    annotations: getToolAnnotations('sandbox_store')
  }, async (args: any) => {
    try {
      const ownerKey = getAuthKeyForSession(sessionId);
      switch (args.action) {
        case 'share': {
          const out = await shareFile(sessionId, args, getBaseUrl());
          return formatOptimizedResponse({ ...out, note: 'Give downloadUrl to the user. It is private to whoever has the link and expires automatically.' }, 4000);
        }
        case 'list': {
          const files = await getFileStore().listByOwner(ownerKey);
          return formatOptimizedResponse({
            count: files.length,
            files: files.map((f) => ({ id: f.id, name: f.name, sizeBytes: f.size, createdAt: f.createdAt, expiresAt: f.expiresAt }))
          }, 8000);
        }
        case 'delete': {
          if ((args.id ? 1 : 0) + (args.all ? 1 : 0) !== 1) throw new Error('delete needs exactly one of: id, all:true.');
          if (args.all) return formatOptimizedResponse({ deleted: await getFileStore().deleteAllOwned(ownerKey) });
          if (!(await getFileStore().deleteOwned(ownerKey, args.id))) throw new Error('No such file (it may have expired, been deleted, or belong to someone else).');
          return formatOptimizedResponse({ deleted: 1, id: args.id });
        }
        case 'download': {
          if (!args.url) throw new Error('download needs a url.');
          return formatOptimizedResponse(await downloadToSandbox(sessionId, args), 4000);
        }
      }
      throw new Error('Unknown action.');
    } catch (err) { return formatError(err); }
  });
}

// ---------------------------------------------------------------------------------------------
// HTTP download route
// ---------------------------------------------------------------------------------------------

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

export function registerFileRoutes(app: Express): void {
  const limiter = createLimiter({ windowMs: 60_000, max: 60 });
  // Strict limiter for *misses*, so token guessing is throttled hard.
  const missLimiter = createLimiter({ windowMs: 10 * 60_000, max: 30 });

  app.get('/files/:token{/:name}', rateLimitMiddleware(limiter, 'Too many download requests.'), async (req: Request, res: Response) => {
    const ip = req.ip || 'unknown';
    const notFound = () => {
      missLimiter.hit(ip);
      res.status(404).type('text/plain').send('File not found or expired.');
    };
    try {
      if (missLimiter.hit(ip, 0) === false) { res.status(429).type('text/plain').send('Too many invalid requests.'); return; }
      const token = String(req.params.token || '');
      if (!TOKEN_RE.test(token)) { notFound(); return; }
      const file = await getFileStore().openByTokenHash(sha256Hex(token));
      if (!file) { notFound(); return; }

      res.status(200);
      res.setHeader('Content-Type', contentTypeFor(file.name));
      res.setHeader('Content-Length', String(file.size));
      res.setHeader('Content-Disposition', contentDisposition(file.name));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      if (req.method === 'HEAD') { file.stream.destroy(); res.end(); return; }
      await pipeline(file.stream, res);
    } catch (e: any) {
      console.error('[files] download failed:', sanitizeOutput(String(e?.message || e)));
      if (!res.headersSent) res.status(503).type('text/plain').send('File storage is temporarily unavailable.');
      else res.destroy();
    }
  });
}
