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
  formatOptimizedResponse, formatImageResponse, formatError, getToolAnnotations, makeRegistrar, getAuthKeyForSession, sanitizeOutput
} from './security.js';
import { createLimiter, rateLimitMiddleware } from './rateLimit.js';
import { resolveSandboxFile } from './sandboxTools.js';
import { sbxReadBytes, sbxStat, sbxMkdirp, sbxWriteText, assertSandboxAllowed } from './sandboxProc.js';

/**
 * Sandbox store tool (share / list / delete / download / view).
 * Secure file sharing, internet asset downloading, media viewing, and storage lifecycle management:
 *
 *  - Link = 256-bit random token. Only its SHA-256 hash is stored, so a database leak does not reveal live links.
 *  - Expiry: default 72 hours, configurable up to 720 hours, or 'never' for permanent retention.
 *  - Quotas: per-file size, per-owner file count / total bytes, and per-owner upload rate.
 *  - Direct MCP Media Output: returns native MCP image content blocks for inline chat rendering.
 *  - Internet Download Engine: downloads assets across the internet with modern browser headers and webpage media extraction.
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
  get ttlHours() { return num('FILE_TTL_HOURS', 72, 1, 720); },
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
  expiresAt: Date | null;
}

export interface ListOwnerOptions {
  search?: string;
  status?: 'active' | 'expired' | 'permanent' | 'all';
  sortBy?: 'size' | 'createdAt' | 'expiresAt' | 'name';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface FileStore {
  put(meta: { name: string; contentType: string; ownerKey: string; tokenHash: string; expiresAt: Date | null }, data: Buffer): Promise<StoredFileMeta>;
  openByTokenHash(tokenHash: string): Promise<(StoredFileMeta & { stream: Readable }) | null>;
  openById(ownerKey: string, id: string): Promise<(StoredFileMeta & { stream: Readable }) | null>;
  listByOwner(ownerKey: string, options?: ListOwnerOptions): Promise<{ files: StoredFileMeta[]; totalCount: number }>;
  usage(ownerKey: string): Promise<{ count: number; bytes: number; permanentCount: number; expiredCount: number }>;
  deleteOwned(ownerKey: string, id: string): Promise<boolean>;
  deleteManyOwned(ownerKey: string, ids: string[]): Promise<number>;
  deleteFilteredOwned(ownerKey: string, filter: { expiredOnly?: boolean; search?: string }): Promise<number>;
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
      expiresAt: doc.metadata?.expiresAt ? new Date(doc.metadata.expiresAt) : null
    };
  }

  async put(meta: { name: string; contentType: string; ownerKey: string; tokenHash: string; expiresAt: Date | null }, data: Buffer): Promise<StoredFileMeta> {
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
    if (doc.metadata?.expiresAt && new Date(doc.metadata.expiresAt).getTime() <= Date.now()) return null;
    return { ...MongoFileStore.toMeta(doc), stream: bucket.openDownloadStream(doc._id) as unknown as Readable };
  }

  async openById(ownerKey: string, id: string) {
    if (!/^[a-f0-9]{24}$/i.test(id)) return null;
    const { bucket } = await this.init();
    const _id = new ObjectId(id);
    const doc = await bucket.find({ _id, 'metadata.ownerKey': ownerKey }).limit(1).next();
    if (!doc) return null;
    return { ...MongoFileStore.toMeta(doc), stream: bucket.openDownloadStream(doc._id) as unknown as Readable };
  }

  async listByOwner(ownerKey: string, options: ListOwnerOptions = {}): Promise<{ files: StoredFileMeta[]; totalCount: number }> {
    const { bucket } = await this.init();
    const now = new Date();
    const status = options.status || 'active';
    const query: Record<string, any> = { 'metadata.ownerKey': ownerKey };

    if (status === 'active') {
      query.$or = [{ 'metadata.expiresAt': null }, { 'metadata.expiresAt': { $gt: now } }];
    } else if (status === 'expired') {
      query['metadata.expiresAt'] = { $ne: null, $lte: now };
    } else if (status === 'permanent') {
      query['metadata.expiresAt'] = null;
    }

    if (options.search && options.search.trim()) {
      query.filename = { $regex: options.search.trim(), $options: 'i' };
    }

    const sortField = options.sortBy === 'size' ? 'length'
      : options.sortBy === 'expiresAt' ? 'metadata.expiresAt'
      : options.sortBy === 'name' ? 'filename'
      : 'uploadDate';
    const sortDir = options.sortOrder === 'asc' ? 1 : -1;

    const limit = Math.min(Math.max(1, options.limit || 20), 100);
    const offset = Math.max(0, options.offset || 0);

    const [docs, totalCount] = await Promise.all([
      bucket.find(query).sort({ [sortField]: sortDir }).skip(offset).limit(limit).toArray(),
      bucket.find(query).count()
    ]);

    return { files: docs.map(MongoFileStore.toMeta), totalCount };
  }

  async usage(ownerKey: string): Promise<{ count: number; bytes: number; permanentCount: number; expiredCount: number }> {
    const { db } = await this.init();
    const now = new Date();
    const rows = await db.collection(`${BUCKET}.files`).aggregate([
      { $match: { 'metadata.ownerKey': ownerKey } },
      {
        $group: {
          _id: null,
          totalCount: { $sum: 1 },
          totalBytes: { $sum: '$length' },
          permanentCount: {
            $sum: { $cond: [{ $eq: ['$metadata.expiresAt', null] }, 1, 0] }
          },
          expiredCount: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$metadata.expiresAt', null] }, { $lte: ['$metadata.expiresAt', now] }] },
                1,
                0
              ]
            }
          }
        }
      }
    ]).toArray();
    if (!rows[0]) return { count: 0, bytes: 0, permanentCount: 0, expiredCount: 0 };
    return {
      count: rows[0].totalCount,
      bytes: rows[0].totalBytes,
      permanentCount: rows[0].permanentCount,
      expiredCount: rows[0].expiredCount
    };
  }

  async deleteOwned(ownerKey: string, id: string): Promise<boolean> {
    if (!/^[a-f0-9]{24}$/i.test(id)) return false;
    const { bucket } = await this.init();
    const _id = new ObjectId(id);
    const doc = await bucket.find({ _id, 'metadata.ownerKey': ownerKey }).limit(1).next();
    if (!doc) return false;
    await bucket.delete(_id);
    return true;
  }

  async deleteManyOwned(ownerKey: string, ids: string[]): Promise<number> {
    const validIds = ids.filter((id) => /^[a-f0-9]{24}$/i.test(id)).map((id) => new ObjectId(id));
    if (!validIds.length) return 0;
    const { bucket } = await this.init();
    const docs = await bucket.find({ _id: { $in: validIds }, 'metadata.ownerKey': ownerKey }).toArray();
    let deleted = 0;
    for (const d of docs) {
      try {
        await bucket.delete(d._id);
        deleted++;
      } catch {}
    }
    return deleted;
  }

  async deleteFilteredOwned(ownerKey: string, filter: { expiredOnly?: boolean; search?: string }): Promise<number> {
    const { bucket } = await this.init();
    const query: Record<string, any> = { 'metadata.ownerKey': ownerKey };
    if (filter.expiredOnly) {
      query['metadata.expiresAt'] = { $ne: null, $lte: new Date() };
    }
    if (filter.search && filter.search.trim()) {
      query.filename = { $regex: filter.search.trim(), $options: 'i' };
    }
    const docs = await bucket.find(query).limit(500).toArray();
    let deleted = 0;
    for (const d of docs) {
      try {
        await bucket.delete(d._id);
        deleted++;
      } catch {}
    }
    return deleted;
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
    const now = new Date();
    // Only sweep documents that have an expiration date in the past (expiresAt != null)
    const expired = await bucket.find({ 'metadata.expiresAt': { $ne: null, $lte: now } }).limit(500).toArray();
    let deleted = 0;
    for (const f of expired) {
      try { await bucket.delete(f._id); deleted++; } catch (e: any) {
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
// Massive 250+ MIME Database
// ---------------------------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  // Images (Raster, Vector & RAW)
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif', '.tiff': 'image/tiff',
  '.tif': 'image/tiff', '.svg': 'image/svg+xml', '.heic': 'image/heic', '.heif': 'image/heif', '.raw': 'image/x-dcraw',
  '.cr2': 'image/x-canon-cr2', '.nef': 'image/x-nikon-nef', '.arw': 'image/x-sony-arw', '.dng': 'image/x-adobe-dng',
  '.psd': 'image/vnd.adobe.photoshop', '.ai': 'application/postscript', '.eps': 'application/postscript',
  '.cur': 'image/x-icon', '.pnm': 'image/x-portable-anymap', '.pbm': 'image/x-portable-bitmap',
  '.pgm': 'image/x-portable-graymap', '.ppm': 'image/x-portable-pixmap', '.xbm': 'image/x-xbitmap',

  // Audio Formats
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma', '.opus': 'audio/opus', '.mid': 'audio/midi',
  '.midi': 'audio/midi', '.aif': 'audio/x-aiff', '.aiff': 'audio/x-aiff', '.alac': 'audio/alac', '.amr': 'audio/amr',

  // Video Formats
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.m4v': 'video/x-m4v',
  '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2', '.m2ts': 'video/mp2t', '.ogv': 'video/ogg',

  // Documents & Office
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword', '.dot': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel', '.xlt': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint', '.pps': 'application/vnd.ms-powerpoint',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation', '.odg': 'application/vnd.oasis.opendocument.graphics',
  '.rtf': 'application/rtf', '.epub': 'application/epub+zip', '.mobi': 'application/x-mobipocket-ebook',
  '.pages': 'application/x-iwork-pages-sffpages', '.numbers': 'application/x-iwork-numbers-sffnumbers',
  '.key': 'application/x-iwork-keynote-sffkey',

  // Text & Markdown
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.rst': 'text/x-rst',
  '.tex': 'application/x-tex', '.log': 'text/plain', '.diff': 'text/x-diff', '.patch': 'text/x-diff',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',

  // Web & Configuration
  '.html': 'text/html', '.htm': 'text/html', '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css', '.scss': 'text/x-scss', '.sass': 'text/x-sass', '.less': 'text/x-less',
  '.json': 'application/json', '.jsonc': 'application/json', '.jsonld': 'application/ld+json',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'application/toml', '.xml': 'application/xml',
  '.wasm': 'application/wasm', '.graphql': 'application/graphql', '.gql': 'application/graphql',

  // Programming & Source Code
  '.ts': 'text/typescript', '.tsx': 'text/typescript-jsx', '.js': 'text/javascript', '.jsx': 'text/javascript-jsx',
  '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.vue': 'text/x-vue', '.svelte': 'text/x-svelte',
  '.py': 'text/x-python', '.pyw': 'text/x-python', '.rb': 'text/x-ruby', '.php': 'text/x-php',
  '.java': 'text/x-java-source', '.class': 'application/java-vm', '.jar': 'application/java-archive',
  '.c': 'text/x-c', '.h': 'text/x-c', '.cpp': 'text/x-c++', '.cc': 'text/x-c++', '.cxx': 'text/x-c++',
  '.hpp': 'text/x-c++', '.cs': 'text/x-csharp', '.go': 'text/x-go', '.rs': 'text/x-rust',
  '.swift': 'text/x-swift', '.kt': 'text/x-kotlin', '.kts': 'text/x-kotlin', '.dart': 'text/x-dart',
  '.lua': 'text/x-lua', '.sh': 'application/x-sh', '.bash': 'application/x-sh', '.zsh': 'application/x-sh',
  '.fish': 'application/x-fish', '.bat': 'application/x-bat', '.cmd': 'application/x-bat',
  '.ps1': 'application/x-powershell', '.pl': 'text/x-perl', '.pm': 'text/x-perl', '.r': 'text/x-r',
  '.scala': 'text/x-scala', '.ex': 'text/x-elixir', '.exs': 'text/x-elixir', '.erl': 'text/x-erlang',
  '.zig': 'text/x-zig', '.nim': 'text/x-nim', '.sql': 'application/sql',

  // AI, Data Science & Machine Learning Models
  '.parquet': 'application/vnd.apache.parquet', '.feather': 'application/vnd.apache.arrow.file',
  '.arrow': 'application/vnd.apache.arrow.file', '.h5': 'application/x-hdf5', '.hdf5': 'application/x-hdf5',
  '.onnx': 'application/octet-stream', '.pt': 'application/octet-stream', '.pth': 'application/octet-stream',
  '.safetensors': 'application/octet-stream', '.bin': 'application/octet-stream', '.gguf': 'application/octet-stream',
  '.joblib': 'application/octet-stream', '.pkl': 'application/octet-stream', '.pickle': 'application/octet-stream',
  '.npy': 'application/octet-stream', '.npz': 'application/octet-stream',

  // Archives, Packages & Compression
  '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip', '.tgz': 'application/gzip',
  '.bz2': 'application/x-bzip2', '.tbz2': 'application/x-bzip2', '.xz': 'application/x-xz', '.txz': 'application/x-xz',
  '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar', '.zst': 'application/zstd',
  '.iso': 'application/x-iso9660-image', '.dmg': 'application/x-apple-diskimage',
  '.deb': 'application/vnd.debian.binary-package', '.rpm': 'application/x-rpm',
  '.apk': 'application/vnd.android.package-archive', '.whl': 'application/x-wheel+zip',

  // Fonts
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',

  // 3D Assets & CAD
  '.obj': 'model/obj', '.fbx': 'application/octet-stream', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary',
  '.stl': 'model/stl', '.ply': 'model/ply', '.dae': 'model/vnd.collada+xml', '.blend': 'application/x-blender',
  '.step': 'application/step', '.stp': 'application/step', '.iges': 'model/iges', '.igs': 'model/iges',

  // Database
  '.sqlite': 'application/vnd.sqlite3', '.sqlite3': 'application/vnd.sqlite3', '.db': 'application/vnd.sqlite3',
  '.mdb': 'application/x-msaccess', '.accdb': 'application/x-msaccess'
};

// Active content: delivered as attachment with octet-stream header when served over public download HTTP route.
const ACTIVE_EXTS = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs', '.cjs', '.swf', '.xsl', '.xslt']);

export function contentTypeFor(name: string): string {
  const base = path.basename(name).toLowerCase();
  if (['dockerfile', 'makefile', 'license', 'readme', 'procfile', '.env', '.gitignore', '.npmrc', '.editorconfig'].includes(base)) {
    return 'text/plain';
  }
  const ext = path.extname(name).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|webp|gif|avif|bmp|tiff|x-icon|vnd\.microsoft\.icon|svg\+xml)$/i.test(mime);
}

export function isMcpImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|webp|gif)$/i.test(mime);
}

export function isAudioMime(mime: string): boolean {
  return mime.startsWith('audio/');
}

export function isVideoMime(mime: string): boolean {
  return mime.startsWith('video/');
}

export function isTextContent(mime: string, filename?: string, buffer?: Buffer): boolean {
  if (mime.startsWith('text/')) return true;
  if (/^(application\/(json|xml|javascript|x-javascript|typescript|x-typescript|graphql|sql|x-sql|x-sh|x-shellscript|toml|x-toml|yaml|x-yaml|ld\+json))$/i.test(mime)) return true;
  if (filename) {
    const base = path.basename(filename).toLowerCase();
    if (['dockerfile', 'makefile', 'license', 'readme', 'procfile', '.env', '.gitignore', '.npmrc', '.editorconfig'].includes(base)) return true;
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|c|h|cpp|hpp|cs|java|kt|kts|swift|php|sh|bash|zsh|sql|toml|yaml|yml|json|md|txt|html|css|scss|xml|csv|tsv|env)$/i.test(filename)) return true;
  }
  if (buffer && buffer.length > 0) {
    const checkLen = Math.min(buffer.length, 8000);
    for (let i = 0; i < checkLen; i++) {
      if (buffer[i] === 0x00) return false;
    }
    return true;
  }
  return false;
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
  never?: boolean;
}

export async function shareFile(
  sessionId: string,
  input: ShareInput,
  baseUrl: string
): Promise<{ id: string; name: string; sizeBytes: number; contentType: string; downloadUrl: string; expiresAt: string; expiresInHours: number | null; permanent: boolean }> {
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
  const maxMb = (fileConfig.maxBytesPerOwner / 1024 / 1024).toFixed(0);
  const currentMb = (usage.bytes / 1024 / 1024).toFixed(1);
  const fileMb = (data.length / 1024 / 1024).toFixed(1);

  if (usage.count >= fileConfig.maxFilesPerOwner) {
    throw new Error(`MongoDB storage is full (file count limit reached: ${usage.count}/${fileConfig.maxFilesPerOwner} files). Delete some files using sandbox_store action:delete (use action:list to inspect or pass ids: [...]).`);
  }
  if (usage.bytes + data.length > fileConfig.maxBytesPerOwner) {
    throw new Error(`MongoDB storage is full (byte quota reached: ${currentMb}MB / ${maxMb}MB used). Cannot add ${fileMb}MB file. Delete old/large files with sandbox_store action:delete (use action:list with sortBy: 'size' to find largest files).`);
  }

  const isNever = input.never === true || input.ttlHours === 0 || input.ttlHours === -1;
  const ttl = isNever ? 0 : Math.min(Math.max(1, Math.floor(input.ttlHours ?? fileConfig.ttlHours)), 720);
  const expiresAt = isNever ? null : new Date(Date.now() + ttl * 3600 * 1000);
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
    expiresAt: expiresAt ? expiresAt.toISOString() : 'never',
    expiresInHours: isNever ? null : ttl,
    permanent: isNever
  };
}

export interface MongoStorageStatus {
  configured: boolean;
  connected: boolean;
  database?: string;
  storage?: {
    availableMB: number;
    usedMB: number;
    maxMB: number;
    percentUsed: string;
    usedBytes: number;
    maxBytes: number;
  };
  files?: {
    totalCount: number;
    maxCount: number;
    availableSlots: number;
    permanentCount: number;
    expiredCount: number;
  };
  defaultTtlHours?: number;
  message?: string;
  error?: string;
}

/** Check MongoDB connection status and calculate available storage quota for the caller's session. */
export async function getMongoStorageStatus(sessionId: string): Promise<MongoStorageStatus> {
  if (!process.env.MONGODB_URI && !activeStore) {
    return {
      configured: false,
      connected: false,
      message: 'MONGODB_URI is not configured on the server. Persistent file storage and sandbox_store are disabled.'
    };
  }

  try {
    const ownerKey = getAuthKeyForSession(sessionId);
    const store = getFileStore();

    const usagePromise = store.usage(ownerKey);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('MongoDB connection timed out after 5000ms')), 5000).unref()
    );
    const u = await Promise.race([usagePromise, timeoutPromise]);

    const maxBytes = fileConfig.maxBytesPerOwner;
    const usedBytes = u.bytes;
    const availableBytes = Math.max(0, maxBytes - usedBytes);

    const usedMB = parseFloat((usedBytes / (1024 * 1024)).toFixed(2));
    const maxMB = Math.round(maxBytes / (1024 * 1024));
    const availableMB = parseFloat((availableBytes / (1024 * 1024)).toFixed(2));
    const percentUsed = `${Math.min(100, Math.round((usedBytes / maxBytes) * 100))}%`;

    return {
      configured: true,
      connected: true,
      database: fileConfig.dbName,
      storage: {
        availableMB,
        usedMB,
        maxMB,
        percentUsed,
        usedBytes,
        maxBytes
      },
      files: {
        totalCount: u.count,
        maxCount: fileConfig.maxFilesPerOwner,
        availableSlots: Math.max(0, fileConfig.maxFilesPerOwner - u.count),
        permanentCount: u.permanentCount,
        expiredCount: u.expiredCount
      },
      defaultTtlHours: fileConfig.ttlHours
    };
  } catch (err: any) {
    return {
      configured: true,
      connected: false,
      error: sanitizeOutput(String(err?.message || err))
    };
  }
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
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity'
      },
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

export function extractMediaUrlsFromHtml(html: string, baseUrl: string): { images: string[]; media: string[]; links: string[] } {
  const images = new Set<string>();
  const media = new Set<string>();
  const links = new Set<string>();

  const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    try { images.add(new URL(match[1], baseUrl).toString()); } catch {}
  }

  const mediaRegex = /<(?:video|audio|source)[^>]+src=["']([^"']+)["']/gi;
  while ((match = mediaRegex.exec(html)) !== null) {
    try { media.add(new URL(match[1], baseUrl).toString()); } catch {}
  }

  const linkRegex = /<a[^>]+href=["']([^"']+)["']/gi;
  while ((match = linkRegex.exec(html)) !== null) {
    try {
      const u = new URL(match[1], baseUrl).toString();
      if (/\.(pdf|zip|tar|gz|7z|csv|tsv|json|docx?|xlsx?|pptx?|mp4|mp3|wav|png|jpe?g|webp|svg)$/i.test(u)) {
        links.add(u);
      }
    } catch {}
  }

  return {
    images: Array.from(images).slice(0, 50),
    media: Array.from(media).slice(0, 30),
    links: Array.from(links).slice(0, 50)
  };
}

export async function downloadToSandbox(sessionId: string, input: { url: string; filename?: string; dir?: string; extractMedia?: boolean }) {
  assertSandboxAllowed();
  const maxBytes = downloadMaxBytes();
  const deadline = Date.now() + 90_000;
  let current = input.url;
  let fetched: Fetched | undefined;
  for (let hop = 0; hop <= 8; hop++) {
    const r = await httpGetPinned(current, maxBytes, deadline);
    if (r.redirect) { current = r.redirect; continue; }
    fetched = r.res;
    break;
  }
  if (!fetched) throw new Error('Too many redirects.');
  if (fetched.body.length === 0) throw new Error('The server returned an empty file.');

  const rawType = fetched.contentType.split(';')[0].trim().toLowerCase();
  const urlName = decodeURIComponentSafe(path.basename(new URL(fetched.finalUrl).pathname));
  const name = safeFileName(input.filename || fetched.suggestedName || urlName || 'download');
  const contentTypeRaw = (rawType && rawType !== 'application/octet-stream' && rawType !== 'binary/octet-stream') ? rawType : contentTypeFor(name);
  const { root, abs } = await resolveSandboxFile(sessionId, name, input.dir);
  await sbxMkdirp(root, path.dirname(abs));
  await sbxWriteText(root, abs, fetched.body, false);

  const out: Record<string, any> = {
    path: path.relative(root, abs),
    absolutePath: abs,
    name,
    sizeBytes: fetched.body.length,
    contentType: contentTypeRaw,
    sha256: crypto.createHash('sha256').update(fetched.body).digest('hex'),
    note: 'Saved in the sandbox. Use sandbox_exec/sandbox_run to process it, sandbox_store action:view to view it, or sandbox_store action:share to hand it to the user.'
  };

  if (input.extractMedia || contentTypeRaw.includes('text/html')) {
    const htmlText = fetched.body.toString('utf-8');
    const extracted = extractMediaUrlsFromHtml(htmlText, fetched.finalUrl);
    if (extracted.images.length || extracted.media.length || extracted.links.length) {
      out.extractedUrls = extracted;
    }
  }

  return { result: out, data: fetched.body, contentType: contentTypeRaw };
}

function decodeURIComponentSafe(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

// ---------------------------------------------------------------------------------------------
// MCP tool: sandbox_store (share / list / delete / download / view)
// ---------------------------------------------------------------------------------------------

export function registerFileTools(server: any, sessionId: string, registry: Record<string, any>, getBaseUrl: () => string) {
  const reg = makeRegistrar(server, registry);

  reg('sandbox_store', {
    description:
      'Move, view, and manage files between the sandbox, MongoDB cloud store, the internet, and the user.\n' +
      'Actions:\n' +
      '- share: upload a sandbox file (sandboxPath) or inline content (content/content_b64) to MongoDB and get a private download link for the user. Expiry defaults to 72 hours (or set `never: true` / `ttlHours: 0` for permanent retention).\n' +
      '- list: search, filter, and inspect your shared files with quota stats. Filter by `search` (name substring/regex), `status` (active/expired/permanent/all), and `sortBy` (size/createdAt/expiresAt/name).\n' +
      '- delete: delete a file by `id`, batch delete multiple with `ids: [...]`, delete all expired with `expiredOnly: true`, or delete all with `all: true`.\n' +
      '- download: download any file/image from across the internet into the sandbox. Supports `view: true` to display images inline, and `extractMedia: true` to discover downloadable image/media links from webpages.\n' +
      '- view: inspect a file from the sandbox or store directly. Automatically returns native MCP image blocks for images (so they display inline in chat) and clean text for documents/code.',
    inputSchema: {
      action: z.enum(['share', 'list', 'delete', 'download', 'view']),
      sandboxPath: z.string().max(1024).optional().describe('share/view: path of a file inside the sandbox.'),
      dir: z.string().max(1024).optional().describe('share/download/view: sandbox base directory.'),
      filename: z.string().max(255).optional().describe('share/download: file name.'),
      content: z.string().optional().describe('share: inline UTF-8 text.'),
      content_b64: z.string().optional().describe('share: inline base64 data.'),
      ttlHours: z.number().int().min(0).max(720).optional().describe('share: hours until auto-deletion (default 72, 0 for never).'),
      never: z.boolean().optional().describe('share: store permanently without auto-deletion.'),
      url: z.string().url().max(2048).optional().describe('download: HTTP/HTTPS URL from any website or API to fetch into sandbox.'),
      extractMedia: z.boolean().optional().describe('download: if URL is an HTML page, extract all image, video, and download links found on the page.'),
      view: z.boolean().optional().describe('download/share: if true and the file is an image, renders the image block directly in the tool response.'),
      search: z.string().optional().describe('list/delete: regex or substring filter for filenames.'),
      status: z.enum(['active', 'expired', 'permanent', 'all']).optional().default('active').describe('list: file expiration filter.'),
      sortBy: z.enum(['size', 'createdAt', 'expiresAt', 'name']).optional().default('createdAt').describe('list: sort field.'),
      sortOrder: z.enum(['asc', 'desc']).optional().default('desc').describe('list: sort order direction.'),
      limit: z.number().int().min(1).max(100).optional().default(20).describe('list: pagination limit.'),
      offset: z.number().int().min(0).optional().default(0).describe('list: pagination offset.'),
      compact: z.boolean().optional().default(true).describe('list: return token-efficient compact summary.'),
      id: z.string().regex(/^[a-fA-F0-9]{24}$/, 'id must be a 24-character hex file id').optional().describe('delete/view: ID of the stored file.'),
      ids: z.array(z.string().regex(/^[a-fA-F0-9]{24}$/)).optional().describe('delete: batch list of file IDs to delete.'),
      expiredOnly: z.boolean().optional().describe('delete: delete all expired files owned by user.'),
      all: z.boolean().optional().describe('delete: delete every file you shared.')
    },
    annotations: getToolAnnotations('sandbox_store')
  }, async (args: any) => {
    try {
      const ownerKey = getAuthKeyForSession(sessionId);
      switch (args.action) {
        case 'share': {
          const out = await shareFile(sessionId, args, getBaseUrl());
          if (args.view && isMcpImageMime(out.contentType) && args.sandboxPath) {
            const { root, abs } = await resolveSandboxFile(sessionId, args.sandboxPath, args.dir);
            const imgData = await sbxReadBytes(root, abs, fileConfig.maxFileBytes);
            return formatImageResponse(imgData, out.contentType, { ...out, note: 'Give downloadUrl to the user for external sharing.' });
          }
          return formatOptimizedResponse({ ...out, note: 'Give downloadUrl to the user. It is private to whoever has the link.' }, 4000);
        }

        case 'list': {
          const options: ListOwnerOptions = {
            search: args.search,
            status: args.status,
            sortBy: args.sortBy,
            sortOrder: args.sortOrder,
            limit: args.limit,
            offset: args.offset
          };
          const [result, usage] = await Promise.all([
            getFileStore().listByOwner(ownerKey, options),
            getFileStore().usage(ownerKey)
          ]);
          const maxMb = (fileConfig.maxBytesPerOwner / 1024 / 1024).toFixed(0);
          const usedMb = (usage.bytes / 1024 / 1024).toFixed(2);
          const percentUsed = Math.round((usage.bytes / fileConfig.maxBytesPerOwner) * 100);
          const quota = {
            usedFiles: usage.count,
            maxFiles: fileConfig.maxFilesPerOwner,
            usedMb: `${usedMb} MB`,
            maxMb: `${maxMb} MB`,
            percentUsed: `${percentUsed}%`,
            permanentFiles: usage.permanentCount,
            expiredFiles: usage.expiredCount
          };

          if (args.compact !== false) {
            return formatOptimizedResponse({
              total: result.totalCount,
              count: result.files.length,
              quota,
              files: result.files.map((f) => ({
                id: f.id,
                name: f.name,
                size: f.size > 1048576 ? `${(f.size / 1048576).toFixed(1)}MB` : `${Math.round(f.size / 1024)}KB`,
                type: f.contentType,
                expires: f.expiresAt ? f.expiresAt.toISOString().slice(0, 16).replace('T', ' ') : 'never'
              }))
            }, 6000);
          }

          return formatOptimizedResponse({
            total: result.totalCount,
            count: result.files.length,
            quota,
            files: result.files
          }, 8000);
        }

        case 'delete': {
          const targets = (args.id ? 1 : 0) + (args.ids ? 1 : 0) + (args.all ? 1 : 0) + (args.expiredOnly ? 1 : 0) + (args.search ? 1 : 0);
          if (targets === 0) throw new Error('delete needs at least one of: id, ids: [...], all: true, expiredOnly: true, or search: "pattern".');

          if (args.all) {
            return formatOptimizedResponse({ deleted: await getFileStore().deleteAllOwned(ownerKey) });
          }
          if (args.ids && Array.isArray(args.ids)) {
            const count = await getFileStore().deleteManyOwned(ownerKey, args.ids);
            return formatOptimizedResponse({ deleted: count, targetIds: args.ids.length });
          }
          if (args.expiredOnly || args.search) {
            const count = await getFileStore().deleteFilteredOwned(ownerKey, { expiredOnly: args.expiredOnly, search: args.search });
            return formatOptimizedResponse({ deleted: count, filter: { expiredOnly: !!args.expiredOnly, search: args.search } });
          }
          if (!(await getFileStore().deleteOwned(ownerKey, args.id))) {
            throw new Error('No such file (it may have expired, been deleted, or belong to someone else).');
          }
          return formatOptimizedResponse({ deleted: 1, id: args.id });
        }

        case 'download': {
          if (!args.url) throw new Error('download needs a url.');
          const dl = await downloadToSandbox(sessionId, args);
          if (args.view && isMcpImageMime(dl.contentType)) {
            return formatImageResponse(dl.data, dl.contentType, dl.result);
          }
          return formatOptimizedResponse(dl.result, 5000);
        }

        case 'view': {
          let buffer: Buffer;
          let filename: string;
          let mime: string;

          if (args.sandboxPath) {
            assertSandboxAllowed();
            const { root, abs } = await resolveSandboxFile(sessionId, args.sandboxPath, args.dir);
            const st = await sbxStat(root, abs);
            if (st.kind === 'missing') throw new Error(`File not found in sandbox: ${args.sandboxPath}`);
            filename = path.basename(abs);
            mime = contentTypeFor(filename);
            buffer = await sbxReadBytes(root, abs, fileConfig.maxFileBytes);
          } else if (args.id) {
            const fileDoc = await getFileStore().openById(ownerKey, args.id);
            if (!fileDoc) throw new Error(`Stored file not found or expired: ${args.id}`);
            filename = fileDoc.name;
            mime = fileDoc.contentType;
            const chunks: Buffer[] = [];
            for await (const chunk of fileDoc.stream) chunks.push(Buffer.from(chunk));
            buffer = Buffer.concat(chunks);
          } else {
            throw new Error('view requires either sandboxPath or id.');
          }

          if (isMcpImageMime(mime)) {
            return formatImageResponse(buffer, mime, { name: filename, sizeBytes: buffer.length, format: 'image' });
          }

          if (mime === 'image/svg+xml') {
            return formatOptimizedResponse({
              name: filename,
              sizeBytes: buffer.length,
              contentType: mime,
              format: 'svg',
              dataUri: `data:image/svg+xml;base64,${buffer.toString('base64')}`,
              content: buffer.toString('utf-8')
            }, 10000);
          }

          if (isAudioMime(mime) || isVideoMime(mime)) {
            return formatOptimizedResponse({
              name: filename,
              sizeBytes: buffer.length,
              contentType: mime,
              category: isVideoMime(mime) ? 'video' : 'audio',
              dataUri: buffer.length <= 5 * 1024 * 1024 ? `data:${mime};base64,${buffer.toString('base64')}` : undefined,
              base64Sample: buffer.toString('base64').slice(0, 1000),
              note: 'Multimedia file. Use action: share to generate a streaming or download link.'
            }, 4000);
          }

          if (mime === 'application/pdf') {
            return formatOptimizedResponse({
              name: filename,
              sizeBytes: buffer.length,
              contentType: 'application/pdf',
              category: 'pdf',
              dataUri: buffer.length <= 5 * 1024 * 1024 ? `data:application/pdf;base64,${buffer.toString('base64')}` : undefined,
              base64Sample: buffer.toString('base64').slice(0, 1000),
              note: 'PDF document. Use action: share to generate a download link for viewing.'
            }, 4000);
          }

          if (isTextContent(mime, filename, buffer)) {
            const text = buffer.toString('utf-8');
            const offset = Math.max(0, args.offset || 0);
            const limit = Math.min(args.limit || 8000, 30000);
            const slice = text.slice(offset, offset + limit);
            const out: Record<string, any> = {
              name: filename,
              sizeBytes: buffer.length,
              contentType: mime,
              totalChars: text.length,
              offset,
              content: slice
            };
            if (offset + slice.length < text.length) out.nextOffset = offset + slice.length;
            return formatOptimizedResponse(out, 12000);
          }

          return formatOptimizedResponse({
            name: filename,
            sizeBytes: buffer.length,
            contentType: mime,
            isBinary: true,
            base64Sample: buffer.toString('base64').slice(0, 2000),
            note: 'Binary file. Use action: share to generate a download link for the user.'
          }, 3000);
        }
      }
      throw new Error('Unknown action.');
    } catch (err) { return formatError(err); }
  });
}

// ---------------------------------------------------------------------------------------------
// HTTP download route
// ---------------------------------------------------------------------------------------------

function contentDisposition(name: string, inline: boolean = false): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const dispType = inline ? 'inline' : 'attachment';
  return `${dispType}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

export function registerFileRoutes(app: Express): void {
  const limiter = createLimiter({ windowMs: 60_000, max: 60 });
  const missLimiter = createLimiter({ windowMs: 10 * 60_000, max: 30 });

  app.options('/files/:token{/:name}', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    res.status(204).end();
  });

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

      const rawExt = path.extname(file.name).toLowerCase();
      const isDangerous = ACTIVE_EXTS.has(rawExt);
      const effectiveType = isDangerous ? 'application/octet-stream' : contentTypeFor(file.name);
      const isViewableMedia = !isDangerous && (isImageMime(effectiveType) || isAudioMime(effectiveType) || isVideoMime(effectiveType) || effectiveType === 'application/pdf');
      const isInline = isViewableMedia || req.query.inline === 'true' || req.query.view === 'true';

      res.status(200);
      res.setHeader('Content-Type', effectiveType);
      res.setHeader('Content-Length', String(file.size));
      res.setHeader('Content-Disposition', contentDisposition(file.name, isInline));
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
      res.setHeader('Timing-Allow-Origin', '*');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (isDangerous) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      }
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'public, max-age=3600');
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
