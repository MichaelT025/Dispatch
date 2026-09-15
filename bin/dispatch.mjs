#!/usr/bin/env node
import { runDispatch } from '../lib/cli.mjs';

try {
  process.exitCode = await runDispatch(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error?.name === 'AbortError' ? 'Dispatch cancelled.' : error?.message || 'Dispatch failed.'}\n`);
  process.exitCode = error?.name === 'AbortError' ? 130 : 2;
}
