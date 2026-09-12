import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
console.log(`Node ${process.version}`);
for (const name of ['@earendil-works/pi-coding-agent', 'pi-web-ui']) {
  const path = join(root, 'node_modules', name, 'package.json');
  if (!existsSync(path)) { console.log(`MISSING ${name}: run npm ci`); process.exitCode = 1; }
  else console.log(`${name} ${readJson(path).version}`);
}
const authPath = join(root, '.local', 'agent', 'auth.json');
// Print provider names only, never credential values.
const providers = existsSync(authPath) ? Object.keys(readJson(authPath)) : [];
for (const provider of ['openai-codex', 'opencode-go']) {
  console.log(`${provider}: ${providers.includes(provider) ? 'stored authentication present (not validated)' : 'no stored authentication'}`);
}
const config = readJson(join(root, 'config', 'agents.json'));
for (const [role, value] of Object.entries(config)) {
  console.log(`${role}: ${value.model ?? 'MODEL NOT SELECTED'}; effort ${value.thinking ?? 'not selected'}`);
}
console.log('Setup stage: CLI delegation active; fork UI integration staged (npm run start:fork; tests: npm run test:fork).');
