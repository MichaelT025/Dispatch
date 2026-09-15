import { spawn } from 'node:child_process';

/** Open a public web URL without interpolating it into a shell command. */
export async function openBrowser(rawUrl, { platform = process.platform, spawnProcess = spawn } = {}) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) browser URLs without embedded credentials are supported.');
  }
  const command = platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
  await new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
