import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ICON_48_DATA_URI, ICON_24_DATA_URI, ICON_48_BUFFER, ICON_24_BUFFER,
  GITHUB_RAW_BASE_URL, GITHUB_ICON_48_URL, GITHUB_ICON_128_URL, GITHUB_LOGO_URL,
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

  test('GitHub raw URLs point to canonical imunmuted/Krix/gem repository', () => {
    assert.equal(GITHUB_RAW_BASE_URL, 'https://raw.githubusercontent.com/imunmuted/Krix/gem/assets');
    assert.equal(GITHUB_ICON_48_URL, 'https://raw.githubusercontent.com/imunmuted/Krix/gem/assets/icon-48.png');
    assert.equal(GITHUB_ICON_128_URL, 'https://raw.githubusercontent.com/imunmuted/Krix/gem/assets/icon-128.png');
    assert.equal(GITHUB_LOGO_URL, 'https://raw.githubusercontent.com/imunmuted/Krix/gem/assets/logo.png');
    assert.equal(DEFAULT_PUBLIC_URL, GITHUB_RAW_BASE_URL);
  });

  test('getServerIcons provides both embedded data URIs and public GitHub URLs', () => {
    const icons = getServerIcons();
    assert.ok(icons.length >= 6);

    // Data URIs for inline zero-network handshake
    const dataUriLight = icons.find(i => i.src.startsWith('data:') && i.theme === 'light');
    const dataUriDark = icons.find(i => i.src.startsWith('data:') && i.theme === 'dark');
    assert.ok(dataUriLight, 'Should include light theme data URI');
    assert.ok(dataUriDark, 'Should include dark theme data URI');

    // Canonical GitHub raw URLs
    const githubLight = icons.find(i => i.src === GITHUB_ICON_48_URL && i.theme === 'light');
    const githubDark = icons.find(i => i.src === GITHUB_ICON_48_URL && i.theme === 'dark');
    const github128 = icons.find(i => i.src === GITHUB_ICON_128_URL);
    const githubLogo = icons.find(i => i.src === GITHUB_LOGO_URL);

    assert.ok(githubLight, 'Should include light theme GitHub icon-48');
    assert.ok(githubDark, 'Should include dark theme GitHub icon-48');
    assert.ok(github128, 'Should include GitHub icon-128');
    assert.ok(githubLogo, 'Should include GitHub logo');

    // Ensure krix-gateway.onrender.com is never referenced in any icon src
    for (const icon of icons) {
      assert.ok(!icon.src.includes('krix-gateway.onrender.com'), `Icon src must not reference dead onrender domain: ${icon.src}`);
    }
  });

  test('getServerIcons appends custom host endpoints when distinct baseUrl is provided', () => {
    const customIcons = getServerIcons('https://my-gateway.example.com');
    const customEndpoint = customIcons.find(i => i.src === 'https://my-gateway.example.com/icon-48.png');
    assert.ok(customEndpoint, 'Should include custom baseUrl endpoints');
  });

  test('server.json and gemini-extension.json do not reference dead krix-gateway.onrender.com for icons', () => {
    const serverJsonPath = path.resolve(process.cwd(), 'server.json');
    const geminiJsonPath = path.resolve(process.cwd(), 'gemini-extension.json');

    const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf-8'));
    const geminiJson = JSON.parse(fs.readFileSync(geminiJsonPath, 'utf-8'));

    for (const icon of serverJson.icons) {
      assert.ok(!icon.src.includes('krix-gateway.onrender.com'), `server.json icon must not reference dead onrender domain: ${icon.src}`);
      assert.ok(icon.src.startsWith('https://raw.githubusercontent.com/'), `server.json icon should use raw GitHub URL: ${icon.src}`);
    }

    assert.ok(!geminiJson.icon.includes('krix-gateway.onrender.com'), `gemini-extension.json icon must not reference dead onrender domain: ${geminiJson.icon}`);
    assert.ok(geminiJson.icon.startsWith('https://raw.githubusercontent.com/'), `gemini-extension.json icon should use raw GitHub URL: ${geminiJson.icon}`);

    for (const icon of geminiJson.icons) {
      assert.ok(!icon.src.includes('krix-gateway.onrender.com'), `gemini-extension.json icon must not reference dead onrender domain: ${icon.src}`);
      assert.ok(icon.src.startsWith('https://raw.githubusercontent.com/'), `gemini-extension.json icon should use raw GitHub URL: ${icon.src}`);
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
