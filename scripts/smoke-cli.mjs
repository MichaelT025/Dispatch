// Opt-in live smoke test: consumes a small amount of configured provider usage.
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const cwd = await mkdtemp(path.join(tmpdir(), 'piastra-cli-smoke-'));
const parallel = process.argv.includes('--parallel');
const files = parallel ? ['fixture.txt', 'second.txt', 'third.txt', 'fourth.txt'] : ['fixture.txt'];
for (const file of files) await writeFile(path.join(cwd, file), 'before\n');
for (const args of [['init'], ['add', '.'], ['-c', 'user.name=PiAstra Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']]) execFileSync('git', args, { cwd, stdio: 'pipe' });
const cli = process.argv.slice(2).find(arg => !arg.startsWith('--')) || path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const prompt = parallel ? `Integration test. Call delegate ONCE with FOUR general write tasks simultaneously, one task per file: ${files.join(', ')}. Each worker must use read then edit to change ONLY its assigned file from before to after preserving the trailing newline. No other edits. Then call one read review worker to inspect Git diff against HEAD: expected only those four line changes; no pre-existing changes. If any worker fails stop and report it. Do not use other tools yourself. This test specifically requires four editing workers in the same batch.` : `Integration test. Use delegate for these three sequential batches, no other tools yourself:
1. One general write worker: change fixture.txt from before to after, preserving a trailing newline, using the edit tool. No other edits.
2. Two fast read workers in the SAME delegate call: one reads fixture.txt and reports its content; the other uses inspect_git status and diff and reports the change.
3. One review read worker: original requirement was ONLY changing fixture.txt from before to after with trailing newline. Baseline HEAD, no pre-existing changes. Independently inspect Git diff and read the file; report whether it matches. Do not run tests or edit anything.
If any worker fails, report the failure and stop. Otherwise reply briefly with the results.`;
const child = spawn(process.execPath, [cli, '--mode', 'json', '--no-session', '-p', prompt], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(homedir(), '.pi/agent') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', stderr = '';
child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { stderr += d; });
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
await mkdir('.local', { recursive: true });
await writeFile('.local/cli-smoke.jsonl', output);
const events = output.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const workerResults = events.filter(e => e.type === 'tool_execution_end' && e.toolName === 'delegate').flatMap(e => e.result?.details?.results || []);
const updates = events.filter(e => e.type === 'tool_execution_update' && e.toolName === 'delegate');
const liveActivity = updates.some(e => e.partialResult?.details?.workers?.some(w => w.recent.length));
const fourRunning = updates.some(e => e.partialResult?.details?.workers?.filter(w => w.status === 'running').length >= 4);
console.log(JSON.stringify({ cwd, code, liveActivity, fourRunning, workers: workerResults.map(r => ({ role: r.role, model: r.model, ok: r.ok, transcript: r.transcript })), stderr }, null, 2));
const contents = await Promise.all(files.map(file => readFile(path.join(cwd, file), 'utf8')));
if (code !== 0 || workerResults.length !== (parallel ? 5 : 4) || workerResults.some(r => !r.ok) || contents.some(c => c !== 'after\n') || !liveActivity || (parallel && !fourRunning)) process.exitCode = 1;
