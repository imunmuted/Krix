import express, { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';

dotenv.config();

import { registerGitHubTools } from './githubTools.js';
import { registerRenderTools } from './renderTools.js';
import { registerSandboxTools, destroySandbox } from './sandboxTools.js';
import { registerFileTools, registerFileRoutes, startFileSweeper, stopFileStore } from './fileShare.js';
import { logIsolationStatus } from './sandboxProc.js';
import { createLimiter, rateLimitMiddleware, clientIp } from './rateLimit.js';
import {
  TOOL_CATEGORY, ToolCategory, getSessionContext, registerSessionAuth, getAuthKeyForSession,
  computeAuthKey, safeEqual, registerSecret, sanitizeOutput
} from './security.js';

const DEFAULT_GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT;
const DEFAULT_RENDER_API_KEY = process.env.RENDER_API_KEY || process.env.RENDER_PAT;
const MCP_API_KEY = process.env.MCP_API_KEY;

if (!MCP_API_KEY) {
  console.error('FATAL: MCP_API_KEY is not set. Refusing to start an unauthenticated gateway.');
  process.exit(1);
}
if (MCP_API_KEY.length < 24) {
  console.warn('⚠️  MCP_API_KEY is shorter than 24 characters. Use a long random value, e.g. `openssl rand -hex 32`.');
}
registerSecret(DEFAULT_GITHUB_PAT);
registerSecret(DEFAULT_RENDER_API_KEY);

const ALLOW_QUERY_API_KEY = process.env.ALLOW_QUERY_API_KEY !== 'false';
if (ALLOW_QUERY_API_KEY) {
  console.warn('⚠️  ?api_key= query authentication is enabled (ALLOW_QUERY_API_KEY). URLs end up in proxy logs and browser history; prefer the x-api-key or Authorization header and set ALLOW_QUERY_API_KEY=false when your client supports it.');
}

const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS) || 50);
const MAX_BODY_MB = Math.min(64, Math.max(1, Number(process.env.MAX_BODY_MB) || 16));
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActive: number;
}
const transports = new Map<string, SessionEntry>();

function tagCategory(registry: Record<string, any>, categoryOf: Record<string, ToolCategory>, fallbackCategory: ToolCategory) {
  for (const name of Object.keys(registry)) {
    if (!categoryOf[name]) categoryOf[name] = TOOL_CATEGORY[name] || fallbackCategory;
  }
}

function baseUrl(req: Request): string {
  const protoRaw = (req.headers['x-forwarded-proto'] as string)?.split(',')[0].trim().toLowerCase();
  const proto = protoRaw === 'http' || protoRaw === 'https' ? protoRaw : (req.protocol === 'http' ? 'http' : 'https');
  const hostRaw = req.get('host') || 'localhost:3000';
  const host = /^[A-Za-z0-9.\-:\[\]]{1,255}$/.test(hostRaw) ? hostRaw : 'localhost:3000';
  return `${proto}://${host}`;
}

function serverIcons(req: Request): Array<{ src: string; mimeType: string; sizes: string[] }> {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') || baseUrl(req);
  const logo = process.env.APP_LOGO_URL?.trim() || `${base}/logo.png`;
  const mimeType = /\.svg(?:\?.*)?$/i.test(logo) ? 'image/svg+xml' : /\.jpe?g(?:\?.*)?$/i.test(logo) ? 'image/jpeg' : 'image/png';
  return [{ src: logo, mimeType, sizes: ['320x317'] }];
}

function createMasterServer(githubToken: string, renderToken: string | undefined, sessionId: string, req: Request) {
  const server = new McpServer({
    name: 'krix',
    version: '2.2.0',
    icons: serverIcons(req)
  }, {
    capabilities: {
      tools: {
        listChanged: true
      }
    }
  });

  const octokit = new Octokit({ auth: githubToken || '' });

  const registry: Record<string, any> = {};
  const categoryOf: Record<string, ToolCategory> = {};

  registerGitHubTools(server, octokit, sessionId, registry);
  tagCategory(registry, categoryOf, 'github_admin');

  registerRenderTools(server, () => renderToken, registry);
  tagCategory(registry, categoryOf, 'render');

  registerSandboxTools(server, sessionId, githubToken, registry);
  tagCategory(registry, categoryOf, 'sandbox');

  const publicBase = baseUrl(req);
  registerFileTools(server, sessionId, registry, () => publicBase);
  tagCategory(registry, categoryOf, 'files');

  const ctx = getSessionContext(sessionId);
  for (const [name, handle] of Object.entries(registry)) {
    const cat = categoryOf[name];
    if (ctx.enabledCategories.has(cat)) {
      handle.enable();
    } else {
      handle.disable();
    }
  }

  return server;
}

// ---------------------------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.disable('etag');
{
  const hops = process.env.TRUST_PROXY;
  app.set('trust proxy', hops === undefined || hops === '' ? 1 : (hops === 'false' ? false : Number.isFinite(Number(hops)) ? Number(hops) : hops));
}

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Coarse global limiter (cheap protection for every route, including unauthenticated ones).
app.use(rateLimitMiddleware(createLimiter({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_PER_MIN) || 600 }), 'Rate limit exceeded.'));

app.get('/healthz', (_req, res) => { res.json({ ok: true }); });

app.use('/assets', express.static('assets', { dotfiles: 'deny', index: false, maxAge: '1h' }));
app.get(['/logo.png', '/logo.jpg', '/favicon.ico'], (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const pngPath = path.resolve('assets/logo.png');
  const jpgPath = path.resolve('assets/logo.jpg');
  if (fs.existsSync(pngPath)) return res.sendFile(pngPath);
  if (fs.existsSync(jpgPath)) return res.sendFile(jpgPath);
  res.status(404).send('Logo not found');
});

registerFileRoutes(app);

const failedAuthLimiter = createLimiter({ windowMs: 15 * 60_000, max: 10 });

function jsonRpcError(res: Response, status: number, code: number, message: string, id: unknown = null): void {
  if (!res.headersSent) res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id });
}

function extractClientKey(req: Request): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  if (ALLOW_QUERY_API_KEY && typeof req.query.api_key === 'string') return req.query.api_key;
  return undefined;
}

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const ip = clientIp(req);
  if (!failedAuthLimiter.hit(ip, 0)) {
    res.setHeader('Retry-After', String(failedAuthLimiter.retryAfterSec(ip) || 900));
    jsonRpcError(res, 429, -32000, 'Too many failed authentication attempts.');
    return;
  }
  if (!safeEqual(extractClientKey(req), MCP_API_KEY)) {
    failedAuthLimiter.hit(ip);
    jsonRpcError(res, 401, -32000, 'Unauthorized.');
    return;
  }
  next();
}

function checkOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length && typeof origin === 'string' && !ALLOWED_ORIGINS.includes(origin)) {
    jsonRpcError(res, 403, -32000, 'Origin not allowed.');
    return;
  }
  next();
}

app.all('/mcp',
  checkOrigin,
  authenticate,                                   // authenticate BEFORE parsing a (potentially huge) body
  (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); },
  express.json({ limit: `${MAX_BODY_MB}mb` }),
  async (req: Request, res: Response): Promise<void> => {
    const githubToken = (typeof req.headers['x-github-token'] === 'string' ? req.headers['x-github-token'] : '') || DEFAULT_GITHUB_PAT || '';
    const renderToken = (typeof req.headers['x-render-token'] === 'string' ? req.headers['x-render-token'] : '') || DEFAULT_RENDER_API_KEY;
    registerSecret(githubToken);
    registerSecret(renderToken);
    const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
    const body = req.body;

    try {
      if (sessionId) {
        const entry = transports.get(sessionId);
        if (!entry) { jsonRpcError(res, 404, -32001, 'Session not found. Re-initialize.', body?.id ?? null); return; }
        // A session is bound to the identity that created it.
        if (getAuthKeyForSession(sessionId) !== computeAuthKey(githubToken)) {
          jsonRpcError(res, 403, -32000, 'Session identity mismatch.', body?.id ?? null);
          return;
        }
        entry.lastActive = Date.now();
        await entry.transport.handleRequest(req, res, body);
        return;
      }

      const isInit = Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
      if (req.method !== 'POST' || !isInit) {
        jsonRpcError(res, 400, -32000, 'Bad Request: no valid session. Send an initialize request first.', body?.id ?? null);
        return;
      }
      if (transports.size >= MAX_SESSIONS) {
        res.setHeader('Retry-After', '30');
        jsonRpcError(res, 503, -32000, 'Server is at capacity. Try again shortly.', body?.id ?? null);
        return;
      }

      const newSessionId = crypto.randomUUID();
      registerSessionAuth(newSessionId, githubToken);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (id) => {
          transports.set(id, { transport, lastActive: Date.now() });
        }
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          destroySandbox(transport.sessionId).catch(() => {});
          transports.delete(transport.sessionId);
        }
      };

      const masterServer = createMasterServer(githubToken, renderToken, newSessionId, req);
      await masterServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error: any) {
      console.error('[mcp] request failed:', sanitizeOutput(String(error?.stack || error?.message || error)).slice(0, 2000));
      jsonRpcError(res, 500, -32603, 'Internal server error.', body?.id ?? null);
    }
  }
);

app.get('/', (_req, res) => {
  res.send('⚡ Krix Gateway Active.');
});

// Body-parser and other middleware errors: never leak internals.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (err?.type === 'entity.too.large') { jsonRpcError(res, 413, -32000, 'Request body too large.'); return; }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) { jsonRpcError(res, 400, -32700, 'Parse error.'); return; }
  console.error('[http] error:', sanitizeOutput(String(err?.message || err)).slice(0, 500));
  jsonRpcError(res, 500, -32603, 'Internal server error.');
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxIdle = 10 * 60 * 1000;
  for (const [id, entry] of transports.entries()) {
    if (now - entry.lastActive > maxIdle) {
      transports.delete(id);
      destroySandbox(id).catch(() => {});
      try { entry.transport.close(); } catch {}
    }
  }
}, 3 * 60 * 1000);
cleanupTimer.unref();

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Krix Active on Port ${PORT}`);
  logIsolationStatus();
  if (process.env.MONGODB_URI) startFileSweeper();
  else console.warn('ℹ️  MONGODB_URI is not set: sandbox_store share/list/delete will report that file storage is not configured (download still works).');
});
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanupTimer);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await Promise.allSettled([...transports.keys()].map((id) => destroySandbox(id)));
  await stopFileStore().catch(() => {});
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', sanitizeOutput(String((reason as any)?.stack || reason)).slice(0, 1000));
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', sanitizeOutput(String(err?.stack || err)).slice(0, 1000));
  shutdown();
});
