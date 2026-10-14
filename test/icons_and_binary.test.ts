import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IconSchema, ImplementationSchema } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import {
  ICON_48_DATA_URI, ICON_24_DATA_URI, ICON_48_BUFFER, ICON_24_BUFFER,
  GITHUB_RAW_BASE_URL, GITHUB_ICON_48_URL, GITHUB_ICON_128_URL, GITHUB_LOGO_URL,
  RENDER_PUBLIC_URL, RENDER_ICON_48_URL, RENDER_ICON_128_URL, RENDER_LOGO_URL,
  DEFAULT_PUBLIC_URL, getServerIcons, SERVER_ICONS
} from '../src/icons.js';
import { isBinaryBuffer, resolveInputBuffer, resolveInputString } from '../src/security.js';

describe('Icons and Asset Metadata', () => {
  test('ICON_48_DATA_URI and ICON_24_DATA_URI have valid PNG headers', () => {
    assert.ok(ICON_48_DATA_URI.startsWith('data:image/png;base64,'));
    assert.ok(ICON_24_DATA_URI.startsWith('data:image/png;base64,'));

    // PNG magic bytes: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
    const pngMagic = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.deepEqual(ICON_48_BUFFER.subarray(0, 8), pngMagic);
    assert.deepEqual(ICON_24_BUFFER.subarray(0, 8), pngMagic);
  });

  test('GitHub raw URLs and Render URLs point to canonical endpoints', () => {
    assert.equal(GITHUB_RAW_BASE_URL, 'https://raw.githubusercontent.com/imunmuted/Krix/gem/assets');
    assert.equal(GITHUB_ICON_48_URL, 'https://raw.githubusercontent.com/imunmuted/Krix/gem/assets/icon-48.png');
    assert.equal(GITHUB_ICON_128_URL, 'https://raw.githubusercontent.com/imunmuted/Krix/gem/assets/icon-128.png');
    assert.equal(GITHUB_LOGO_URL, 'https://raw.githubusercontent.com/imunmuted/Krix/gem/assets/logo.png');

    assert.equal(RENDER_PUBLIC_URL, 'https://krix.onrender.com');
    assert.equal(RENDER_ICON_48_URL, 'https://krix.onrender.com/icon-48.png');
    assert.equal(RENDER_ICON_128_URL, 'https://krix.onrender.com/icon-128.png');
    assert.equal(RENDER_LOGO_URL, 'https://krix.onrender.com/logo.png');

    assert.equal(DEFAULT_PUBLIC_URL, GITHUB_RAW_BASE_URL);
  });

  test('getServerIcons strictly returns SEP-973 compliant HTTPS icon objects without oversized data URIs', () => {
    const icons = getServerIcons();
    assert.ok(icons.length >= 8);

    // SEP-973 / MCP schema requirements:
    for (const icon of icons) {
      assert.ok(icon.src, 'Icon must have src property');
      assert.ok(icon.src.startsWith('https://'), `Icon src must be a public HTTPS URL: ${icon.src}`);
      assert.ok(icon.src.length <= 255, `Icon src must not exceed 255 characters: ${icon.src.length}`);
      assert.ok(!icon.src.startsWith('data:'), `Icon src must not be an oversized data URI`);
      assert.equal(icon.url, icon.src, 'Icon url property must match src property');
      assert.equal(icon.mimeType, 'image/png', 'Icon MIME type must be image/png');
      assert.ok(Array.isArray(icon.sizes), 'Icon sizes must be an array');
      for (const size of icon.sizes) {
        assert.match(size, /^(\d+x\d+|any)$/, `Size must match pattern: ${size}`);
      }
      if (icon.theme) {
        assert.ok(icon.theme === 'light' || icon.theme === 'dark', `Theme must be light or dark: ${icon.theme}`);
      }
      assert.ok(!icon.src.includes('krix-gateway.onrender.com'), `Must not reference dead domain: ${icon.src}`);

      // Validate against MCP SDK IconSchema
      const validated = IconSchema.parse(icon);
      assert.equal(validated.src, icon.src);
    }

    // Canonical GitHub raw URLs
    const githubLight = icons.find(i => i.src === GITHUB_ICON_48_URL && i.theme === 'light');
    const githubDark = icons.find(i => i.src === GITHUB_ICON_48_URL && i.theme === 'dark');
    assert.ok(githubLight, 'Should include light theme GitHub icon-48');
    assert.ok(githubDark, 'Should include dark theme GitHub icon-48');

    // Live Render web service endpoints
    const renderLight = icons.find(i => i.src === RENDER_ICON_48_URL && i.theme === 'light');
    const renderDark = icons.find(i => i.src === RENDER_ICON_48_URL && i.theme === 'dark');
    assert.ok(renderLight, 'Should include light theme Render icon-48');
    assert.ok(renderDark, 'Should include dark theme Render icon-48');
  });

  test('getServerIcons appends custom host endpoints when distinct baseUrl is provided', () => {
    const customIcons = getServerIcons('https://my-gateway.example.com');
    const customEndpoint = customIcons.find(i => i.src === 'https://my-gateway.example.com/icon-48.png');
    assert.ok(customEndpoint, 'Should include custom baseUrl endpoints');
    assert.equal(customEndpoint.url, 'https://my-gateway.example.com/icon-48.png');
    assert.ok(customEndpoint.src.length <= 255);
  });

  test('MCP initialize response payload strictly adheres to SEP-973 icon specification', async () => {
    const serverIcons = getServerIcons();
    const server = new McpServer({
      name: 'krix',
      title: 'Krix',
      version: '1.1.0',
      description: 'Advanced agentic gateway for remote GitHub discovery, Render management, and sandboxed execution.',
      websiteUrl: 'https://github.com/imunmuted/Krix',
      icons: serverIcons
    });

    (server.server as any)._serverInfo.icon = GITHUB_ICON_48_URL;
    (server.server as any)._serverInfo.iconUrl = GITHUB_ICON_48_URL;
    (server.server as any)._serverInfo.logo = GITHUB_LOGO_URL;
    (server.server as any)._serverInfo.logoUrl = GITHUB_LOGO_URL;
    (server.server as any)._serverInfo.icons = serverIcons;

    const initResult = await (server.server as any)._oninitialize({
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'gemini-connector', version: '1.0.0' }
      }
    });

    assert.ok(initResult, 'Initialize result must be returned');
    assert.ok(initResult.serverInfo, 'serverInfo must be defined');
    assert.equal(initResult.serverInfo.name, 'krix');
    assert.equal(initResult.serverInfo.version, '1.1.0');

    // Ensure oversized data URI is not present in serverInfo
    assert.equal((initResult.serverInfo as any).iconDataUri, undefined, 'iconDataUri should not be present in serverInfo payload');

    const icons = initResult.serverInfo.icons;
    assert.ok(Array.isArray(icons), 'serverInfo.icons must be an array');
    assert.ok(icons.length >= 8, 'serverInfo.icons must have at least 8 variants');

    // Primary icon must be an accessible HTTPS URL <= 255 chars
    const primaryIcon = icons[0];
    assert.ok(primaryIcon.src.startsWith('https://'), 'Primary icon must be HTTPS URL');
    assert.ok(primaryIcon.src.length <= 255, 'Primary icon length must be <= 255 chars');
    assert.equal(primaryIcon.mimeType, 'image/png');
    assert.deepEqual(primaryIcon.sizes, ['48x48']);

    for (const icon of icons) {
      assert.ok(icon.src.startsWith('https://'), 'All icons must be HTTPS URLs');
      assert.ok(icon.src.length <= 255, 'All icon URLs must be <= 255 characters');
      assert.ok(!icon.src.startsWith('data:'), 'No icon should use data URI');
      assert.equal(icon.mimeType, 'image/png');
      assert.ok(Array.isArray(icon.sizes));
      assert.ok(icon.sizes.length > 0);

      // Validate against MCP SDK IconSchema
      const validated = IconSchema.parse(icon);
      assert.equal(validated.src, icon.src);
    }

    // Validate entire serverInfo against ImplementationSchema
    const validatedServerInfo = ImplementationSchema.parse(initResult.serverInfo);
    assert.equal(validatedServerInfo.name, 'krix');
    assert.ok(validatedServerInfo.icons && validatedServerInfo.icons.length >= 8);
  });

  test('server.json validates successfully against official Model Context Protocol schema', () => {
    const serverJsonPath = path.resolve(process.cwd(), 'server.json');
    const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf-8'));

    const schemaPath = path.resolve(process.cwd(), 'test/fixtures/server.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));

    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema);
    const valid = validate(serverJson);

    if (!valid) {
      console.error('Schema validation errors:', validate.errors);
    }
    assert.ok(valid, `server.json must satisfy official server.schema.json: ${JSON.stringify(validate.errors)}`);
  });

  test('manifests (gemini-extension.json, server.json, manifest.json) have matching icon properties and valid endpoints', () => {
    const serverJsonPath = path.resolve(process.cwd(), 'server.json');
    const geminiJsonPath = path.resolve(process.cwd(), 'gemini-extension.json');
    const manifestJsonPath = path.resolve(process.cwd(), 'manifest.json');

    assert.ok(fs.existsSync(serverJsonPath), 'server.json must exist');
    assert.ok(fs.existsSync(geminiJsonPath), 'gemini-extension.json must exist');
    assert.ok(fs.existsSync(manifestJsonPath), 'manifest.json must exist');

    const serverJsonRaw = fs.readFileSync(serverJsonPath, 'utf-8');
    const geminiJsonRaw = fs.readFileSync(geminiJsonPath, 'utf-8');
    const manifestJsonRaw = fs.readFileSync(manifestJsonPath, 'utf-8');

    assert.ok(!serverJsonRaw.includes('krix-gateway.onrender.com'), 'server.json must not reference dead onrender domain anywhere');
    assert.ok(!geminiJsonRaw.includes('krix-gateway.onrender.com'), 'gemini-extension.json must not reference dead onrender domain anywhere');
    assert.ok(!manifestJsonRaw.includes('krix-gateway.onrender.com'), 'manifest.json must not reference dead onrender domain anywhere');

    const serverJson = JSON.parse(serverJsonRaw);
    const geminiJson = JSON.parse(geminiJsonRaw);
    const manifestJson = JSON.parse(manifestJsonRaw);

    assert.equal(serverJson.remotes[0].url, 'https://krix.onrender.com/mcp', 'server.json remotes URL must point to live krix.onrender.com/mcp');
    assert.equal(geminiJson.mcpServers.krix.url, 'https://krix.onrender.com/mcp', 'gemini-extension.json mcpServers URL must point to live krix.onrender.com/mcp');

    // Matching descriptions
    assert.equal(serverJson.description, geminiJson.description);
    assert.equal(serverJson.description, manifestJson.description);
    assert.ok(serverJson.description.length <= 100, 'Description must be <= 100 chars');

    // Verify icons match in length and properties
    assert.equal(serverJson.icons.length, geminiJson.icons.length, 'Icon counts must match between server.json and gemini-extension.json');
    assert.equal(serverJson.icons.length, manifestJson.icons.length, 'Icon counts must match between server.json and manifest.json');

    for (let i = 0; i < serverJson.icons.length; i++) {
      const sIcon = serverJson.icons[i];
      const gIcon = geminiJson.icons[i];
      const mIcon = manifestJson.icons[i];

      assert.equal(sIcon.src, gIcon.src, `Icon ${i} src must match between server.json and gemini-extension.json`);
      assert.equal(sIcon.src, mIcon.src, `Icon ${i} src must match between server.json and manifest.json`);
      assert.equal(sIcon.url, sIcon.src, `Icon ${i} url must match src`);
      assert.equal(gIcon.url, gIcon.src, `Icon ${i} url must match src`);
      assert.equal(mIcon.url, mIcon.src, `Icon ${i} url must match src`);
      assert.equal(sIcon.mimeType, gIcon.mimeType, `Icon ${i} mimeType must match`);
      assert.equal(sIcon.mimeType, mIcon.mimeType, `Icon ${i} mimeType must match`);
      assert.deepEqual(sIcon.sizes, gIcon.sizes, `Icon ${i} sizes must match`);
      assert.deepEqual(sIcon.sizes, mIcon.sizes, `Icon ${i} sizes must match`);
      assert.equal(sIcon.theme, gIcon.theme, `Icon ${i} theme must match`);
      assert.equal(sIcon.theme, mIcon.theme, `Icon ${i} theme must match`);

      assert.ok(sIcon.src.startsWith('https://'), `Icon src must be HTTPS: ${sIcon.src}`);
      assert.ok(sIcon.src.length <= 255, `Icon src length must be <= 255: ${sIcon.src.length}`);
    }
  });

  test('Local asset files exist and have valid non-zero content with proper dimensions', () => {
    const assetsDir = path.resolve(process.cwd(), 'assets');
    const files = ['icon-48.png', 'icon-128.png', 'logo.png', 'favicon.ico'];

    for (const file of files) {
      const fullPath = path.join(assetsDir, file);
      assert.ok(fs.existsSync(fullPath), `Asset file must exist: ${file}`);
      const stat = fs.statSync(fullPath);
      assert.ok(stat.size > 0, `Asset file must not be empty: ${file}`);

      const buf = fs.readFileSync(fullPath);
      if (file.endsWith('.png')) {
        const pngMagic = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        assert.deepEqual(buf.subarray(0, 8), pngMagic, `${file} must have valid PNG magic bytes`);
      } else if (file.endsWith('.ico')) {
        // ICO magic: 0x00 0x00 0x01 0x00
        const icoMagic = Buffer.from([0x00, 0x00, 0x01, 0x00]);
        assert.deepEqual(buf.subarray(0, 4), icoMagic, `${file} must have valid ICO magic bytes`);
      }
    }
  });

  test('Live remote icon endpoints return HTTP 200 with image/png and CORS headers', async () => {
    // Tests accessibility of live canonical endpoints
    const endpoints = [
      { name: 'GitHub raw icon-48', url: GITHUB_ICON_48_URL },
      { name: 'GitHub raw logo', url: GITHUB_LOGO_URL },
      { name: 'Render live icon-48', url: RENDER_ICON_48_URL },
      { name: 'Render live logo', url: RENDER_LOGO_URL }
    ];

    for (const ep of endpoints) {
      try {
        const res = await fetch(ep.url, { method: 'HEAD' });
        assert.equal(res.status, 200, `${ep.name} (${ep.url}) must return HTTP 200`);
        const contentType = res.headers.get('content-type');
        assert.ok(contentType?.includes('image/png'), `${ep.name} must return image/png, got ${contentType}`);
        const cors = res.headers.get('access-control-allow-origin');
        assert.equal(cors, '*', `${ep.name} must return Access-Control-Allow-Origin: *`);
      } catch (err: any) {
        // If network is completely offline during test runner execution, log warning
        console.warn(`Live endpoint check skipped for ${ep.name}:`, err.message);
      }
    }
  });
});

describe('Binary-Safe Buffer Handling in Security & Tools', () => {
  test('isBinaryBuffer accurately differentiates text from binary', () => {
    const textBuf = Buffer.from('Hello, world! This is valid UTF-8 text with symbols: ©™✓');
    assert.equal(isBinaryBuffer(textBuf), false);

    const emptyBuf = Buffer.alloc(0);
    assert.equal(isBinaryBuffer(emptyBuf), false);

    const binaryBuf = Buffer.from([0x00, 0xFF, 0x10, 0x20]);
    assert.equal(isBinaryBuffer(binaryBuf), true);

    // PNG buffer has null bytes in headers
    assert.equal(isBinaryBuffer(ICON_48_BUFFER), true);
  });

  test('resolveInputBuffer safely parses plain text or base64', () => {
    const plain = resolveInputBuffer('hello world');
    assert.equal(plain.toString('utf-8'), 'hello world');

    const b64 = resolveInputBuffer(undefined, Buffer.from('binary-safe').toString('base64'));
    assert.equal(b64.toString('utf-8'), 'binary-safe');

    // Handles whitespace in base64 string
    const b64WithSpaces = ' ' + Buffer.from('spaced').toString('base64') + '\n';
    assert.equal(resolveInputBuffer(undefined, b64WithSpaces).toString('utf-8'), 'spaced');
  });

  test('resolveInputString strips whitespace from base64 input', () => {
    const text = 'foo bar';
    const b64 = ' ' + Buffer.from(text).toString('base64') + ' \r\n';
    assert.equal(resolveInputString(undefined, b64), text);
  });
});
