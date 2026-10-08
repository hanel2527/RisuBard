import { spawn } from 'node:child_process';
import { existsSync, rmSync, watch, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const DEV_URL = 'http://127.0.0.1:5174';
// Lets the start-menu normal launcher end this session (scripts/start-menu-launcher.mjs).
const pidPath = path.join(os.tmpdir(), 'risubard-dev-launcher.pid');

export function createChildSpecs(projectRoot) {
  return [
    {
      label: 'SERVER',
      args: ['server/node/server.cjs'],
    },
    {
      label: 'WEB',
      args: [`${projectRoot}/node_modules/vite/bin/vite.js`, '--host', '127.0.0.1'],
    },
  ];
}

export function isRestartKey(key) {
  return key?.name === 'r' && !key.ctrl && !key.meta;
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const children = new Set();
let browserOpened = false;
let restarting = false;
let shuttingDown = false;
let readinessGeneration = 0;
let serverChild;
let serverWatcher;
let pendingServerRestart = false;

export function watchServerChanges(directory, onChange, { watchImpl = watch, delay = 250 } = {}) {
  let timer;
  const watcher = watchImpl(directory, { recursive: true }, (_event, filename) => {
    if (filename && !/\.(?:cjs|mjs|js|ts|json)$/i.test(String(filename))) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, delay);
  });
  watcher.on('error', error => log(`서버 파일 감시 실패: ${error.message}. R 키로 다시 시작할 수 있습니다.`));
  return { close() { clearTimeout(timer); watcher.close(); } };
}

function log(message) {
  console.log(`\n[LAUNCHER] ${message}`);
}

function startChild({ label, args }) {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: false,
  });

  children.add(child);
  if (label === 'SERVER') serverChild = child;
  child.on('error', (error) => {
    console.error(`[${label}] 실행 실패: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!restarting && !shuttingDown) {
      log(`${label}가 종료되었습니다 (code=${code ?? '-'}, signal=${signal ?? '-'}). R 키로 다시 시작할 수 있습니다.`);
    }
  });

  return child;
}

async function waitForWeb(generation) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (generation !== readinessGeneration || shuttingDown) return;
    try {
      await fetch(DEV_URL, { signal: AbortSignal.timeout(1000) });
      if (generation !== readinessGeneration || browserOpened) return;
      browserOpened = true;
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', DEV_URL], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      log(`브라우저를 열었습니다: ${DEV_URL}`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (generation === readinessGeneration && !shuttingDown) {
    log(`웹 서버 준비를 확인하지 못했습니다. 로그를 확인한 뒤 R 키를 눌러 주세요.`);
  }
}

function startAll() {
  readinessGeneration += 1;
  const generation = readinessGeneration;
  for (const spec of createChildSpecs(projectRoot)) startChild(spec);
  void waitForWeb(generation);
}

export function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error(`PID ${child.pid ?? '?'}의 종료를 확인하지 못했습니다. 새 프로세스를 시작하지 않습니다.`));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

export async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', reject);
      killer.once('exit', resolve);
    });
  } else {
    child.kill('SIGTERM');
  }

  await waitForExit(child);
}

async function stopAll() {
  readinessGeneration += 1;
  const running = [...children];
  const results = await Promise.allSettled(running.map(stopChild));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

async function restartAll() {
  if (restarting || shuttingDown) return;
  restarting = true;
  log('프런트엔드와 서버를 다시 시작합니다...');
  try {
    await stopAll();
    if (!shuttingDown) startAll();
  } catch (error) {
    log(`재시작 중단: ${error.message}`);
  } finally {
    restarting = false;
    if (pendingServerRestart && !shuttingDown) void restartServer();
  }
}

async function restartServer() {
  if (shuttingDown) return;
  pendingServerRestart = true;
  if (restarting) return;
  restarting = true;
  try {
    do {
      pendingServerRestart = false;
      if (serverChild) await stopChild(serverChild);
      if (!shuttingDown) startChild(createChildSpecs(projectRoot)[0]);
    } while (pendingServerRestart && !shuttingDown);
  } catch (error) {
    pendingServerRestart = false;
    log(`서버 재시작 중단: ${error.message}`);
  } finally { restarting = false; }
}

function restoreTerminal() {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  process.stdin.pause();
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  serverWatcher?.close();
  log('프런트엔드와 서버를 종료합니다...');
  try { await stopAll(); }
  catch (error) {
    log(`종료 실패: ${error.message}`);
    shuttingDown = false;
    return;
  }
  restoreTerminal();
  rmSync(pidPath, { force: true });
  process.exit(exitCode);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const entryPath = path.resolve(process.argv[1]);
  return process.platform === 'win32'
    ? entryPath.toLowerCase() === scriptPath.toLowerCase()
    : entryPath === scriptPath;
}

function run() {
  const viteEntry = createChildSpecs(projectRoot)[1].args[0];
  if (!existsSync(viteEntry)) {
    console.error('[LAUNCHER] 개발 의존성이 없습니다. 먼저 저장소에서 pnpm install을 실행해 주세요.');
    process.exitCode = 1;
    return;
  }

  writeFileSync(pidPath, String(process.pid));
  console.log('RisuBard Dev');
  console.log(`- 웹: ${DEV_URL}`);
  console.log('- API: http://127.0.0.1:7777');
  console.log('- R: 모두 재시작 / Ctrl+C: 모두 종료');

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', (_text, key) => {
      if (key?.ctrl && key.name === 'c') void shutdown();
      else if (isRestartKey(key)) void restartAll();
    });
  }

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  serverWatcher = watchServerChanges(path.join(projectRoot, 'server', 'node'), () => void restartServer());
  startAll();
}

if (isMainModule()) run();
