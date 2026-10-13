import express, { Request, Response } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';

import { registerGitHubTools } from './githubTools.js';
import { registerRenderTools } from './renderTools.js';
import { registerSandboxTools, destroySandbox } from './sandboxTools.js';
import {
  formatOptimizedResponse, getToolAnnotations, TOOL_CATEGORY, ToolCategory, getSessionContext, registerSessionAuth
} from './security.js';

dotenv.config();

const DEFAULT_GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PAT;
const DEFAULT_RENDER_API_KEY = process.env.RENDER_API_KEY || process.env.RENDER_PAT;
const MCP_API_KEY = process.env.MCP_API_KEY;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActive: number;
}
const transports = new Map<string, SessionEntry>();

function tagCategory(registry: Record<string, any>, categoryOf: Record<string, ToolCategory>, fallbackCategory: ToolCategory) {
  for (const name of Object.keys(registry)) {
    categoryOf[name] = TOOL_CATEGORY[name] || fallbackCategory;
  }
}

function baseUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0].trim() || req.protocol || 'https';
  const host = req.get('host') || 'localhost:3000';
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
    version: '2.1.0',
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

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/assets', express.static('assets'));
app.get(['/logo.png', '/logo.jpg', '/favicon.ico'], (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const pngPath = path.resolve('assets/logo.png');
  const jpgPath = path.resolve('assets/logo.jpg');
  if (fs.existsSync(pngPath)) return res.sendFile(pngPath);
  if (fs.existsSync(jpgPath)) return res.sendFile(jpgPath);
  res.status(404).send('Logo not found');
});

app.all('/mcp', async (req: Request, res: Response): Promise<void> => {
  if (!MCP_API_KEY) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'MCP_API_KEY missing on server.' },
      id: req.body?.id || null
    });
    return;
  }

  const clientKey = (req.headers['x-api-key'] as string)
    || req.headers['authorization']?.toString().replace('Bearer ', '')
    || (req.query.api_key as string);

  if (clientKey !== MCP_API_KEY) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized API Key.' },
      id: req.body?.id || null
    });
    return;
  }

  const githubToken = (req.headers['x-github-token'] as string) || DEFAULT_GITHUB_PAT || '';
  const renderToken = (req.headers['x-render-token'] as string) || DEFAULT_RENDER_API_KEY;
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const entry = transports.get(sessionId)!;
    entry.lastActive = Date.now();
    registerSessionAuth(sessionId, githubToken);
    try {
      await entry.transport.handleRequest(req, res, req.body);
    } catch (error: any) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error?.message }, id: req.body?.id || null });
      }
    }
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
      destroySandbox(transport.sessionId);
      transports.delete(transport.sessionId);
    }
  };

  const masterServer = createMasterServer(githubToken, renderToken, newSessionId, req);
  try {
    await masterServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error?.message }, id: req.body?.id || null });
    }
  }
});

app.get('/', (_req, res) => {
  res.send('⚡ Krix Gateway Active.');
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxIdle = 10 * 60 * 1000;
  for (const [id, entry] of transports.entries()) {
    if (now - entry.lastActive > maxIdle) {
      destroySandbox(id);
      try { entry.transport.close(); } catch {}
      transports.delete(id);
    }
  }
}, 3 * 60 * 1000);
cleanupTimer.unref();

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`🚀 Krix Active on Port ${PORT}`));

function shutdown() {
  clearInterval(cleanupTimer);
  for (const [id] of transports.entries()) destroySandbox(id);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
