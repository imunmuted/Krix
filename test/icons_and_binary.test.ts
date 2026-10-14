import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

  test('getServerIcons provides public HTTPS URLs first followed by embedded data URIs and dual src/url fields', () => {
    const icons = getServerIcons();
    assert.ok(icons.length >= 8);

    // Verify HTTPS URLs come first (required by MCP schema maxLength 255 and Gemini proxy compatibility)
    assert.ok(icons[0].src.startsWith('https://'), 'First icon MUST be a public HTTPS URL');
    assert.ok(icons[1].src.startsWith('https://'), 'Second icon MUST be a public HTTPS URL');

    // Verify dual src and url field compatibility on all icons
    for (const icon of icons) {
      assert.ok(icon.src, 'Icon must have src property');
      assert.equal(icon.url, icon.src, 'Icon url property must match src property');
      assert.ok(!icon.src.includes('krix-gateway.onrender.com'), `Must not reference dead domain: ${icon.src}`);
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

    // Data URIs for inline zero-network handshake
    const dataUriLight = icons.find(i => i.src.startsWith('data:') && i.theme === 'light');
    const dataUriDark = icons.find(i => i.src.startsWith('data:') && i.theme === 'dark');
    assert.ok(dataUriLight, 'Should include light theme data URI');
    assert.ok(dataUriDark, 'Should include dark theme data URI');
  });

  test('getServerIcons appends custom host endpoints when distinct baseUrl is provided', () => {
    const customIcons = getServerIcons('https://my-gateway.example.com');
    const customEndpoint = customIcons.find(i => i.src === 'https://my-gateway.example.com/icon-48.png');
    assert.ok(customEndpoint, 'Should include custom baseUrl endpoints');
    assert.equal(customEndpoint.url, 'https://my-gateway.example.com/icon-48.png');
  });

  test('server.json and gemini-extension.json do not reference dead krix-gateway.onrender.com anywhere', () => {
    const serverJsonPath = path.resolve(process.cwd(), 'server.json');
    const geminiJsonPath = path.resolve(process.cwd(), 'gemini-extension.json');

    const serverJsonRaw = fs.readFileSync(serverJsonPath, 'utf-8');
    const geminiJsonRaw = fs.readFileSync(geminiJsonPath, 'utf-8');

    assert.ok(!serverJsonRaw.includes('krix-gateway.onrender.com'), 'server.json must not reference dead onrender domain anywhere');
    assert.ok(!geminiJsonRaw.includes('krix-gateway.onrender.com'), 'gemini-extension.json must not reference dead onrender domain anywhere');

    const serverJson = JSON.parse(serverJsonRaw);
    const geminiJson = JSON.parse(geminiJsonRaw);

    assert.equal(serverJson.remotes[0].url, 'https://krix.onrender.com/mcp', 'server.json remotes URL must point to live krix.onrender.com/mcp');
    assert.equal(geminiJson.mcpServers.krix.url, 'https://krix.onrender.com/mcp', 'gemini-extension.json mcpServers URL must point to live krix.onrender.com/mcp');

    for (const icon of serverJson.icons) {
      assert.ok(icon.src.startsWith('https://'), `server.json icon should use HTTPS URL: ${icon.src}`);
      assert.equal(icon.url, icon.src, 'server.json icon url property must match src');
    }

    assert.ok(geminiJson.icon.startsWith('https://'), `gemini-extension.json icon should use HTTPS URL: ${geminiJson.icon}`);
    assert.equal(geminiJson.iconUrl, geminiJson.icon);
    assert.ok(geminiJson.logo.startsWith('https://'));
    assert.equal(geminiJson.logoUrl, geminiJson.logo);

    for (const icon of geminiJson.icons) {
      assert.ok(icon.src.startsWith('https://'), `gemini-extension.json icon should use HTTPS URL: ${icon.src}`);
      assert.equal(icon.url, icon.src, 'gemini-extension.json icon url property must match src');
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
