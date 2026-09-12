import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { workspace } from './workspace.mjs';

const root = process.cwd();
const port = Number(process.env.PI_DSH_PORT || 8789);
const agentDir = path.join(root, '.local/agent');
const sessionDir = path.join(root, '.local/dsh-sessions');
await mkdir(sessionDir, { recursive: true });
const files = workspace(root);
const peers = new Set();
let session, creating, busy = false;
const broadcast = data => { for (const peer of peers) peer.write(`data: ${JSON.stringify(data)}\n\n`); };
let runtime;
async function models() {
  runtime ??= ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'), modelsStorePath: path.join(agentDir, 'models-store.json'), allowModelNetwork: true });
  return runtime;
}
async function openSession(id, selection) {
  const runtime = await models();
  const configured = JSON.parse(await readFile('config/agents.json', 'utf8')).orchestrator;
  const key = selection || configured.model;
  const slash = key.indexOf('/');
  const model = runtime.getModel(key.slice(0, slash), key.slice(slash + 1));
  if (!model) throw new Error(`${key} is absent from Pi's model catalog. Select an available model; no fallback was used.`);
  const entries = id ? await SessionManager.list(root, sessionDir) : [];
  const entry = entries.find(e => e.id === id);
  if (id && !entry) throw new Error('Session not found');
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  const result = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model, thinkingLevel: configured.thinking, resourceLoader, sessionManager: entry ? SessionManager.open(entry.path, sessionDir, root) : SessionManager.create(root, sessionDir) });
  session?.dispose();
  session = result.session;
  session.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') broadcast({ type: 'delta', text: event.assistantMessageEvent.delta });
    if (event.type === 'tool_execution_start') broadcast({ type: 'tool', name: event.toolName });
    if (event.type === 'tool_execution_end') broadcast({ type: 'tool', name: event.toolName, done: true, error: event.isError });
  });
}
const state = () => ({ busy, model: session?.model ? `${session.model.provider}/${session.model.id}` : null, messages: (session?.state.messages || []).filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, text: typeof m.content === 'string' ? m.content : (m.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), error: m.errorMessage })) });
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
http.createServer(async (req, res) => {
  try {
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return json(res, { error: 'Invalid host' }, 403);
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, { error: 'Invalid origin' }, 403);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET') {
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'state', ...state() })}\n\n`);
        peers.add(res); req.on('close', () => peers.delete(res)); return;
      }
      if (url.pathname === '/api/state') return json(res, state());
      if (url.pathname === '/api/files') return json(res, await files.files(url.searchParams.get('path') || ''));
      if (url.pathname === '/api/file') return json(res, { text: await files.file(url.searchParams.get('path')) });
      if (url.pathname === '/api/diff') return json(res, await files.diff());
      if (url.pathname === '/api/sessions') return json(res, (await SessionManager.list(root, sessionDir)).map(s => ({ id: s.id, name: s.name || s.firstMessage || 'New chat' })));
      if (url.pathname === '/api/models') return json(res, { configured: JSON.parse(await readFile('config/agents.json', 'utf8')).orchestrator.model, models: (await models()).getAvailableSnapshot().map(m => ({ id: `${m.provider}/${m.id}`, name: m.name })) });
      const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] };
      const asset = staticFiles[url.pathname];
      if (!asset) return json(res, { error: 'Not found' }, 404);
      res.writeHead(200, { 'Content-Type': asset[1], 'X-Content-Type-Options': 'nosniff' });
      return res.end(await readFile(path.join(root, '.local/dsh-public', asset[0])));
    }
    if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') return json(res, { error: 'JSON POST required' }, 400);
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 100000) throw new Error('Request too large'); }
    const body = JSON.parse(raw || '{}');
    if (url.pathname === '/api/abort') { await session?.abort(); return json(res, { ok: true }); }
    if (busy || creating) return json(res, { error: 'Wait for the current turn or stop it first' }, 409);
    if (url.pathname === '/api/session') {
      creating = openSession(body.id, body.model);
      try { await creating; } finally { creating = undefined; }
      broadcast({ type: 'state', ...state() }); return json(res, state());
    }
    if (url.pathname === '/api/prompt') {
      if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('Message is empty');
      busy = true;
      try { if (!session) await openSession(undefined, body.model); } catch (error) { busy = false; throw error; }
      json(res, { ok: true });
      session.prompt(body.text).catch(error => broadcast({ type: 'error', error: error.message })).finally(() => { busy = false; broadcast({ type: 'state', ...state() }); });
      return;
    }
    json(res, { error: 'Not found' }, 404);
  } catch (error) { json(res, { error: error.message }, 400); }
}).listen(port, '127.0.0.1', () => console.log(`PiAstra DSH UI: http://127.0.0.1:${port}`));
