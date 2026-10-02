import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverUrl = 'http://127.0.0.1:7777';
const developmentUrl = 'http://127.0.0.1:5174';

async function isReady(url, development) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw new Error(`${url} 응답을 확인할 수 없습니다.`, { cause: error });
  }
  const html = await response.text();
  if (!response.ok || !html.includes('<title>RisuBard</title>') || html.includes('/@vite/client') !== development) {
    throw new Error(`${url} 포트에서 다른 서비스가 실행 중입니다.`);
  }
  return true;
}

export async function ensureService(url, development, start, timeoutMs = 90000) {
  if (await isReady(url, development)) return;
  const child = start();
  let spawnError;
  child.once?.('error', error => { spawnError = error; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (await isReady(url, development)) return;
    if (child.exitCode !== null) throw new Error(`서버 실행 실패. log/start-menu 폴더의 로그를 확인하세요.`);
    await delay(500);
  }
  throw new Error(`${url} 시작 시간이 초과되었습니다. log/start-menu 폴더의 로그를 확인하세요.`);
}

function startBackground(label, args) {
  const logs = path.join(projectRoot, 'log', 'start-menu');
  mkdirSync(logs, { recursive: true });
  const output = openSync(path.join(logs, `${label}.log`), 'a');
  try {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: { ...process.env, PORT: '7777', OPEN_BROWSER: '0', RISU_DEV_SERVER_TARGET: serverUrl },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', output, output],
    });
    child.unref();
    return child;
  } finally { closeSync(output); }
}

async function main() {
  const mode = process.argv[2];
  if (!['normal', 'development'].includes(mode)) throw new Error('실행 모드는 normal 또는 development여야 합니다.');
  const development = mode === 'development';
  if (!existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
    throw new Error('컴파일된 화면이 없습니다. 먼저 pnpm build를 실행하세요.');
  }
  await ensureService(serverUrl, false, () => startBackground('server', ['server/node/server.cjs']));
  if (development) {
    await ensureService(developmentUrl, true, () => startBackground('development', [
      'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5174', '--strictPort',
    ]));
  }
  const url = development ? developmentUrl : serverUrl;
  console.log(`${development ? '리스바드 개발' : '리스바드 일반'}: ${url}`);
  if (!process.argv.includes('--no-open')) {
    await new Promise((resolve, reject) => {
      const opener = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
      opener.once('error', reject);
      opener.once('exit', code => code === 0 ? resolve() : reject(new Error(`브라우저 열기 실패 (${code})`)));
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
