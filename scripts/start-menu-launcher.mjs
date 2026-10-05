import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import os from 'node:os';
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

export function builtVersion(root = projectRoot) {
  try {
    return readFileSync(path.join(root, 'dist', 'index.html'), 'utf8').match(/data-startup-version[^>]*>v([^<]+)</)?.[1] ?? null;
  } catch { return null; }
}

// The release workflow builds in CI only, so refresh the local dist when it lags package.json.
function ensureCurrentBuild() {
  const { version } = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const built = builtVersion();
  if (built === version) return;
  console.log(`화면 빌드 갱신: ${built ? `v${built}` : '없음'} -> v${version}`);
  const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--sourcemap'], { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('빌드 실패. 위 로그를 확인하세요.');
}

// Asks the hidden server to flush pending data and exit (see /api/local-shutdown).
async function stopServer() {
  let token;
  try { token = readFileSync(path.join(os.tmpdir(), 'risubard-shutdown-7777.token'), 'utf8').trim(); } catch {}
  if (!await isReady(serverUrl, false)) return console.log('실행 중인 리스바드 서버가 없습니다.');
  if (!token) throw new Error('종료 토큰이 없습니다. 이 기능이 없는 이전 서버이므로 한 번은 직접 종료하세요.');
  const response = await fetch(`${serverUrl}/api/local-shutdown`, { method: 'POST', headers: { 'x-risubard-shutdown-token': token } });
  if (!response.ok) throw new Error(`서버가 종료 요청을 거부했습니다 (${response.status}).`);
  const deadline = Date.now() + 60000;
  while (await isReady(serverUrl, false)) {
    if (Date.now() > deadline) throw new Error('저장 마무리가 끝나지 않아 종료 대기 시간이 초과되었습니다.');
    await delay(500);
  }
  console.log('리스바드 서버를 종료했습니다.');
}

const serverWindowTitle = '리스바드 일반서버';

// The server gets its own console window so its log stays visible and closing the
// window stops it (after flushing saves). The window stays open if it exits on an error.
function startServerWindow() {
  const node = `"${process.execPath}" server\\node\\server.cjs`;
  return spawn('cmd.exe', ['/d', '/c', `start "${serverWindowTitle}" /d "${projectRoot}" cmd /d /c "${node} & if errorlevel 1 pause"`], {
    cwd: projectRoot,
    env: { ...process.env, PORT: '7777', OPEN_BROWSER: '0', RISU_DEV_SERVER_TARGET: serverUrl, RISUBARD_CONSOLE_TITLE: serverWindowTitle },
    windowsVerbatimArguments: true,
    windowsHide: true,
    stdio: 'ignore',
  });
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
  if (mode === 'stop') return stopServer();
  if (!['normal', 'development'].includes(mode)) throw new Error('실행 모드는 normal, development 또는 stop이어야 합니다.');
  const development = mode === 'development';
  if (!development) ensureCurrentBuild();
  else if (!existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
    throw new Error('컴파일된 화면이 없습니다. 먼저 pnpm build를 실행하세요.');
  }
  await ensureService(serverUrl, false, startServerWindow);
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
