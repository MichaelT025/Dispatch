import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('.local/dsh-public', { recursive: true });
await build({ entryPoints: ['web/app.tsx'], bundle: true, outfile: '.local/dsh-public/app.js', jsx: 'automatic', sourcemap: true });
await writeFile('.local/dsh-public/index.html', '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PiAstra</title><link rel="stylesheet" href="/app.css"></head><body data-ds-dark-theme><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
await import('../web/server/index.mjs');
