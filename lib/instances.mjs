import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

async function canonical(path) {
  const value = await realpath(path).catch(() => resolve(path));
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Track only this foreground process. Exit cleanup never touches another instance. */
export async function trackDispatchInstance(paths, kind, { host = process, pid = process.pid } = {}) {
  const dir = join(paths.home, 'instances');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${pid}-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify({ pid, kind, packageRoot: await canonical(paths.packageRoot) }), { flag: 'wx', mode: 0o600 });
  const cleanup = () => { try { unlinkSync(file); } catch { /* already removed */ } };
  host.once('exit', cleanup);
  return () => { host.removeListener('exit', cleanup); cleanup(); };
}

/** Conservative PID liveness check: never kills a process or guesses past access errors. */
export async function assertNoActiveDispatch(paths, { isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
} } = {}) {
  const dir = join(paths.home, 'instances');
  let files;
  try { files = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const root = await canonical(paths.packageRoot);
  for (const file of files) {
    if (!/^\d+-[a-f0-9-]+\.json$/.test(file)) continue;
    const path = join(dir, file);
    let entry;
    try { entry = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
    if (!Number.isSafeInteger(entry.pid) || entry.pid < 1 || typeof entry.packageRoot !== 'string') continue;
    if (await canonical(entry.packageRoot) !== root) continue;
    if (await isAlive(entry.pid)) {
      throw new Error(`Close running Dispatch sessions before updating (process ${entry.pid}). Then run dispatch update again. If this is a stale PID record, verify the process before removing ${path}.`);
    }
    await unlink(path).catch(() => {});
  }
}
