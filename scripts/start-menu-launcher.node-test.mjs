import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtVersion, ensureService } from './start-menu-launcher.mjs';

async function fixture(t, html) {
  const server = http.createServer((_req, res) => res.end(html));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('reuses a running server without spawning a second data writer', async t => {
  const url = await fixture(t, '<title>RisuBard</title>');
  await ensureService(url, false, () => assert.fail('must reuse existing server'));
});

test('rejects an unrelated service instead of opening it', async t => {
  const url = await fixture(t, '<title>Another app</title>');
  await assert.rejects(ensureService(url, false, () => assert.fail('port occupied')), /다른 서비스/);
});

test('requires Vite when reusing the development port', async t => {
  const url = await fixture(t, '<title>RisuBard</title>');
  await assert.rejects(ensureService(url, true, () => assert.fail('port occupied')), /다른 서비스/);
});

test('starts a missing service and waits for it before returning', async t => {
  const server = http.createServer((_req, res) => res.end('<title>RisuBard</title>/@vite/client'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let starts = 0;
  await ensureService(`http://127.0.0.1:${port}`, true, () => {
    starts++;
    server.listen(port, '127.0.0.1');
    return { exitCode: null };
  });
  assert.equal(starts, 1);
});

test('reads the version stamped into the compiled startup screen', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'risubard-launcher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(builtVersion(root), null);
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(path.join(root, 'dist', 'index.html'), '<span data-startup-version class="x">v0.9.57</span>');
  assert.equal(builtVersion(root), '0.9.57');
});
