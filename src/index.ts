import express, { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';

dotenv.config();

import {
  SERVER_ICONS, getServerIcons, getServerInfoIcons, ICON_48_DATA_URI, ICON_48_BUFFER, ICON_24_BUFFER,
  GITHUB_ICON_48_URL, GITHUB_ICON_128_URL, GITHUB_LOGO_URL,
  RENDER_PUBLIC_URL, RENDER_ICON_48_URL, RENDER_ICON_128_URL, RENDER_LOGO_URL
} from './icons.js';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pre-load icon assets into memory for instant base64 Data URI serving
let icon48DataUri = '';
let icon128DataUri = '';

function loadAsset(fileName: string): Buffer | null {
  for (const candidate of [
    path.resolve(process.cwd(), 'assets', fileName),
    path.resolve(__dirname, '../assets', fileName),
    path.resolve(__dirname, 'assets', fileName),
    path.resolve('assets', fileName)
  ]) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
    } catch {}
  }
  return null;
}

function createMasterServer(githubToken: string, renderToken: string | undefined, sessionId: string, req: Request) {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || baseUrl(req);
  const serverIcons = getServerIcons(base);
  const serverInfoIcons = getServerInfoIcons(base);
  const server = new McpServer({
    name: 'krix',
    title: 'Krix',
    version: '1.1.0',
    description: 'Advanced agentic gateway for remote GitHub discovery, Render management, and sandboxed execution.',
    websiteUrl: 'https://github.com/imunmuted/Krix',
    icons: serverInfoIcons
  }, {
    capabilities: {
      tools: {
        listChanged: true
      }
    }
  });

  const primaryIconUrl = serverIcons[0]?.src ?? GITHUB_ICON_48_URL;
  const primaryLogoUrl = serverIcons.find((i) => i.sizes?.includes('320x320'))?.src ?? GITHUB_LOGO_URL;
  (server.server as any)._serverInfo.icon = primaryIconUrl;
  (server.server as any)._serverInfo.iconUrl = primaryIconUrl;
  (server.server as any)._serverInfo.logo = primaryLogoUrl;
  (server.server as any)._serverInfo.logoUrl = primaryLogoUrl;
  (server.server as any)._serverInfo.icons = serverInfoIcons;

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

  // Ensure every tool returned to MCP clients (like Gemini) includes icons metadata (matching GitHub MCP Server)
  const rawServer = server.server as any;
  const originalListTools = rawServer._requestHandlers?.get('tools/list');
  if (originalListTools) {
    server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const result = await originalListTools(request, extra);
      return {
        ...result,
        tools: (result.tools || []).map((t: any) => ({
          ...t,
          icons: serverIcons
        }))
      };
    });
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

// Static assets and discovery manifests (for Gemini, browser tabs, and MCP discovery)
const staticAssetPaths = [
  '/logo.png', '/icon-128.png', '/icon-64.png', '/icon-48.png', '/icon-24.png', '/apple-touch-icon.png',
  '/logo.jpg', '/logo.jpeg', '/favicon.ico', '/manifest.json', '/manifest.webmanifest',
  '/server.json', '/.well-known/mcp.json', '/gemini-extension.json'
];

app.options(staticAssetPaths, (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  res.status(204).end();
});

app.get(['/logo.png', '/icon-128.png', '/icon-64.png', '/icon-48.png', '/icon-24.png', '/apple-touch-icon.png'], (req, res) => {
  const reqName = path.basename(req.path);
  const targetFile = reqName === 'apple-touch-icon.png' ? 'icon-128.png' : reqName;
  const buf = loadAsset(targetFile) || (targetFile.includes('24') ? ICON_24_BUFFER : ICON_48_BUFFER);
  if (buf) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Content-Disposition', `inline; filename="${targetFile}"`);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    res.setHeader('Timing-Allow-Origin', '*');
    res.send(buf);
  } else {
    res.status(404).send('Icon not found');
  }
});

app.get(['/logo.jpg', '/logo.jpeg'], (_req, res) => {
  const buf = loadAsset('logo.jpg') || ICON_48_BUFFER;
  if (buf) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Content-Disposition', 'inline; filename="logo.jpg"');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    res.setHeader('Timing-Allow-Origin', '*');
    res.send(buf);
  } else {
    res.status(404).send('Logo not found');
  }
});

app.get('/favicon.ico', (_req, res) => {
  const buf = loadAsset('favicon.ico') || ICON_48_BUFFER;
  if (buf) {
    res.setHeader('Content-Type', 'image/x-icon');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Content-Disposition', 'inline; filename="favicon.ico"');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    res.setHeader('Timing-Allow-Origin', '*');
    res.send(buf);
  } else {
    res.status(404).send('Favicon not found');
  }
});

app.get(['/manifest.json', '/manifest.webmanifest'], (req, res) => {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || baseUrl(req);
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.json({
    name: 'Krix',
    short_name: 'Krix',
    description: 'Advanced agentic gateway for remote GitHub discovery, Render management, and sandboxed execution.',
    start_url: '/',
    display: 'standalone',
    icons: getServerIcons(base).map((icon) => ({
      ...icon,
      type: icon.mimeType
    }))
  });
});

app.get(['/server.json', '/.well-known/mcp.json'], (req, res) => {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || baseUrl(req);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.json({
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: 'io.github.imunmuted/krix',
    description: 'Advanced agentic gateway for remote GitHub discovery, Render management, and sandboxed execution.',
    title: 'Krix',
    repository: {
      url: 'https://github.com/imunmuted/Krix',
      source: 'github'
    },
    version: '1.1.0',
    icons: getServerIcons(base),
    remotes: [
      {
        type: 'streamable-http',
        url: `${base}/mcp`,
        headers: [
          {
            name: 'x-api-key',
            description: 'Krix Gateway MCP API key',
            isSecret: true
          }
        ]
      }
    ]
  });
});

app.get('/gemini-extension.json', (req, res) => {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || baseUrl(req);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.json({
    name: 'krix',
    title: 'Krix',
    version: '1.1.0',
    description: 'Advanced agentic gateway for remote GitHub discovery, Render management, and sandboxed execution.',
    icon: getServerIcons(base)[0]?.src ?? GITHUB_ICON_48_URL,
    iconUrl: getServerIcons(base)[0]?.src ?? GITHUB_ICON_48_URL,
    logo: getServerIcons(base).find((i) => i.sizes?.includes('320x320'))?.src ?? GITHUB_LOGO_URL,
    logoUrl: getServerIcons(base).find((i) => i.sizes?.includes('320x320'))?.src ?? GITHUB_LOGO_URL,
    icons: getServerIcons(base),
    mcpServers: {
      krix: {
        description: 'Advanced agentic gateway for remote GitHub discovery, Render management, and sandboxed execution.',
        httpUrl: `${base}/mcp`,
        url: `${base}/mcp`,
        headers: {
          'x-api-key': '$MCP_API_KEY'
        }
      }
    }
  });
});

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Krix MCP Gateway</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="48x48" href="/icon-48.png">
  <link rel="icon" type="image/png" sizes="128x128" href="/icon-128.png">
  <link rel="apple-touch-icon" href="/icon-128.png">
  <link rel="manifest" href="/manifest.json">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; text-align: center; max-width: 420px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
    img { width: 96px; height: 96px; border-radius: 16px; margin-bottom: 16px; object-fit: cover; }
    h1 { margin: 0 0 8px 0; font-size: 24px; color: #f0f6fc; }
    p { margin: 0 0 16px 0; color: #8b949e; font-size: 14px; line-height: 1.5; }
    .badge { display: inline-block; background: #238636; color: white; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <img src="/icon-128.png" alt="Krix Logo">
    <h1>Krix MCP Gateway</h1>
    <p>Advanced agentic developer gateway for remote GitHub discovery, Render cloud management, sandboxed execution, and persistent storage.</p>
    <div class="badge">Active & Ready</div>
  </div>
</body>
</html>`);
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
