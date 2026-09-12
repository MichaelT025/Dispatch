import { realpath, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const hidden = name => ['.git', '.local', 'node_modules', '.codex', '.agents'].includes(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name);
export function workspace(root) {
  async function resolve(relative = '') {
    if (typeof relative !== 'string' || relative.split(/[\\/]/).some(hidden)) throw new Error('Path is not available');
    const base = await realpath(root);
    const target = await realpath(path.resolve(base, relative));
    const rel = path.relative(base, target);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(/[\\/]/).some(hidden)) throw new Error('Path must stay inside the public workspace');
    return target;
  }
  return {
    async files(relative) {
      const entries = await readdir(await resolve(relative), { withFileTypes: true });
      return entries.filter(e => !hidden(e.name) && !e.isSymbolicLink()).map(e => ({ name: e.name, directory: e.isDirectory(), path: path.posix.join((relative || '').replaceAll('\\', '/'), e.name) })).sort((a,b) => Number(b.directory)-Number(a.directory) || a.name.localeCompare(b.name));
    },
    async file(relative) {
      const target = await resolve(relative);
      if ((await stat(target)).size > 512000) throw new Error('Preview limited to 500 KB');
      const content = await readFile(target);
      if (content.includes(0)) throw new Error('Binary preview is not supported yet');
      return content.toString('utf8');
    },
    async diff() {
      const { stdout } = await exec('git', ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color', '--', '.', ':!.env', ':!.env.*'], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
      const { stdout: untracked } = await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root });
      const added = [];
      for (const name of untracked.split('\0').filter(Boolean)) {
        try { added.push({ path: name, content: await this.file(name) }); } catch { /* Unsupported previews are omitted. */ }
      }
      return { patch: stdout, untracked: added };
    }
  };
}
