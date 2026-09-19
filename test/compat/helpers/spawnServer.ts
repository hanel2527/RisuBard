/**
 * Spawn a RisuAI-NodeOnly server in isolation using a temporary save directory.
 *
 * Strategy: run `node <project>/server/node/server.cjs` with cwd set to a temp
 * directory.  The server resolves `save/` relative to cwd, but loads code via
 * __dirname, so no symlinks or copies are needed.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const SERVER_SCRIPT = path.join(PROJECT_ROOT, 'server', 'node', 'server.cjs')

const TEST_PASSWORD = 'compat-test-pass'

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port)
}

export interface ServerHandle {
  port: number
  password: string
  cwd: string
  /** Stop the isolated process without deleting its data (crash/restart tests). */
  stop: (signal?: NodeJS.Signals) => Promise<void>
  /** Kill the server and clean up the temp directory. */
  cleanup: () => Promise<void>
}

/** Find a free port by binding to 0 and immediately closing. */
async function bindFreePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('Unable to determine port')))
      }
    })
    srv.on('error', reject)
  })
}

async function getFreePort(): Promise<number> {
  let port = await bindFreePort()
  while (isFetchBlockedPort(port)) port = await bindFreePort()
  return port
}

export interface SpawnServerOptions {
  /** Extra env vars to pass to the spawned server process. */
  env?: Record<string, string>
  /**
   * Seed files into the temp `save/` directory BEFORE the server boots — e.g.
   * to plant an old hex-named save folder and exercise migrateFromSaveDir.
   * Receives the absolute path to the `save/` dir.
   */
  seedSave?: (saveDir: string) => Promise<void>
}

export async function spawnServer(opts: SpawnServerOptions = {}): Promise<ServerHandle> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-compat-'))
  await mkdir(path.join(tempDir, 'save'), { recursive: true })
  await mkdir(path.join(tempDir, 'backups'), { recursive: true })
  await writeFile(path.join(tempDir, 'save', '__password'), TEST_PASSWORD, 'utf-8')
  if (opts.seedSave) await opts.seedSave(path.join(tempDir, 'save'))

  const port = await getFreePort()

  const child: ChildProcess = spawn(
    process.execPath,
    [SERVER_SCRIPT],
    {
      cwd: tempDir,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        RISUBARD_DATA_ROOT: path.join(tempDir, 'save'),
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  // Collect stderr for diagnostics on failure
  let stderrBuf = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })

  // Wait for the server to print its "running" message
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Server did not start within 10 s.\nstderr: ${stderrBuf}`))
    }, 10_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('[Server]') && chunk.toString().includes('server is running')) {
        clearTimeout(timeout)
        resolve()
      }
    })

    child.on('error', (err) => { clearTimeout(timeout); reject(err) })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Server exited early with code ${code}.\nstderr: ${stderrBuf}`))
    })
  })

  // Track exit state via event listener (set up once, before any cleanup call)
  let exited = child.exitCode !== null
  child.on('exit', () => { exited = true })

  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (!exited) {
      child.kill(signal)
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => {
          if (!exited) child.kill('SIGKILL')
          resolve()
        }, 3000)
        child.on('exit', () => { clearTimeout(timeout); resolve() })
      })
    }
  }
  const cleanup = async () => {
    await stop()
    await rm(tempDir, { recursive: true, force: true })
  }

  return { port, password: TEST_PASSWORD, cwd: tempDir, stop, cleanup }
}
