import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import { DiffRows, ReadRows } from './vendor/diff/DiffRows';
import { parseUnifiedDiff, unifiedSegments, untrackedFile, displayPath } from './vendor/diff/rows';
import { langOfPath } from './vendor/diff/highlight';
import './vendor/theme/design-platform.css';
import './style.css';

async function api(route: string, data?: unknown) {
  const r = await fetch(`/api/${route}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const value = await r.json(); if (!r.ok) throw new Error(value.error); return value;
}
function App() {
  const [messages, setMessages] = useState<any[]>([]), [sessions, setSessions] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]), [model, setModel] = useState('openai-codex/gpt-6-astra');
  const [input, setInput] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [tool, setTool] = useState('');
  const [tab, setTab] = useState('files'), [directory, setDirectory] = useState(''), [entries, setEntries] = useState<any[]>([]);
  const [file, setFile] = useState(''), [content, setContent] = useState(''), [diffs, setDiffs] = useState<any[]>([]), [selected, setSelected] = useState(0), [panel, setPanel] = useState(true);
  const fail = (e: Error) => setError(e.message);
  const refresh = () => Promise.all([api(`files?path=${encodeURIComponent(directory)}`).then(setEntries), api('diff').then(d => setDiffs([...parseUnifiedDiff(d.patch).files, ...d.untracked.map((f: any) => untrackedFile(f.path, f.content))])), api('sessions').then(setSessions)]).catch(fail);
  useEffect(() => { refresh(); }, [directory]);
  useEffect(() => {
    api('models').then(d => { setModels(d.models); setModel(d.configured); }).catch(fail);
    const events = new EventSource('/api/events');
    events.onmessage = e => {
      const data = JSON.parse(e.data);
      if (data.type === 'state') { setMessages(data.messages); setBusy(data.busy); if (data.model) setModel(data.model); setTool(''); api('sessions').then(setSessions).catch(fail); }
      if (data.type === 'delta') setMessages(prev => { const next = [...prev]; if (next.at(-1)?.role !== 'assistant') next.push({ role: 'assistant', text: '' }); next[next.length - 1] = { ...next.at(-1), text: next.at(-1).text + data.text }; return next; });
      if (data.type === 'tool') setTool(`${data.name}${data.done ? (data.error ? ' failed' : ' finished') : '…'}`);
      if (data.type === 'error') setError(data.error);
    };
    events.onerror = () => setError('Connection interrupted. Reconnecting…');
    events.onopen = () => setError('');
    return () => events.close();
  }, []);
  const current = diffs[selected];
  const segments = useMemo(() => current ? unifiedSegments(current) : [], [current]);
  const lines = useMemo(() => content.split('\n').map((text, i) => ({ line: i + 1, text })), [content]);
  async function send() {
    if (!input.trim() || busy) return;
    const text = input; setError(''); setBusy(true); setInput(''); setMessages(prev => [...prev, { role: 'user', text }]);
    try { await api('prompt', { text, model }); } catch (e) { fail(e as Error); setBusy(false); setInput(text); await api('state').then(s => setMessages(s.messages)); }
  }
  async function open(id?: string) { try { setError(''); await api('session', { id, model }); } catch (e) { fail(e as Error); } }
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><span className="brandmark">π</span> PiAstra <span className="preview">preview</span></div>
      <button className="new" onClick={() => open()} disabled={busy}>＋ New chat</button>
      <div className="section-label">WORKSPACE</div><div className="workspace">▱ &nbsp; PiAstra</div>
      <div className="section-label">CHATS</div><div className="sessions">{sessions.map(s => <button key={s.id} disabled={busy} onClick={() => open(s.id)}>{s.name}</button>)}{!sessions.length && <p className="muted">Your conversations appear here.</p>}</div>
      <footer><span className="status-dot"/> Pi connected <small>Local workspace</small></footer>
    </aside>
    <main><header><span>PiAstra <span className="slash">/</span> <strong>Workspace chat</strong></span><button onClick={() => setPanel(!panel)}>{panel ? 'Hide' : 'Show'} workspace ▥</button></header>
      <div className="conversation">{!messages.length ? <div className="welcome"><span className="welcome-logo">π</span><h1>What are we building?</h1><p>A little less overhead. More room to think.</p><div className="suggestions">{['Explore this project', 'Review the current changes', 'Help me plan the next step'].map(s => <button key={s} onClick={() => setInput(s)}>{s} ↗</button>)}</div></div> : messages.map((m, i) => <article key={i} className={m.role}><div className="speaker">{m.role === 'user' ? 'You' : 'PiAstra'}</div><Markdown>{m.text}</Markdown>{m.error && <p className="error">{m.error}</p>}</article>)}{busy && <div className="working">◌ {tool || 'Thinking…'}</div>}</div>
      <div className="compose-wrap">{error && <div className="error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}<div className="composer"><textarea aria-label="Message PiAstra" placeholder="Ask anything about your project…" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}/><div className="composer-bottom"><select aria-label="Model" disabled={busy || messages.length > 0} value={model} onChange={e => setModel(e.target.value)}>{!models.some(m => m.id === model) && <option value={model}>{model.split('/')[1]} · unavailable</option>}{models.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</select><span className="thinking">Low</span>{busy ? <button className="send" aria-label="Stop" onClick={() => api('abort', {}).catch(fail)}>■</button> : <button className="send" aria-label="Send message" disabled={!input.trim()} onClick={send}>↑</button>}</div></div><div className="compose-note">Pi tools run in this workspace · Shift + Enter for a new line</div></div>
    </main>
    {panel && <aside className="inspector"><div className="tabs"><button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Files</button><button className={tab === 'changes' ? 'active' : ''} onClick={() => { setTab('changes'); refresh(); }}>Changes <span className="count">{diffs.length}</span></button><button className="refresh" aria-label="Refresh workspace" onClick={refresh}>↻</button></div>
      {tab === 'files' ? <><div className="path">{directory || 'PiAstra'}{directory && <button onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}>↑ Up</button>}</div><div className="file-list">{entries.map(e => <button key={e.path} className={file === e.path ? 'chosen' : ''} onClick={() => { if(e.directory) setDirectory(e.path); else api(`file?path=${encodeURIComponent(e.path)}`).then(d => { setFile(e.path); setContent(d.text); }).catch(fail); }}><span>{e.directory ? '▸' : '≡'}</span>{e.name}</button>)}</div>{file ? <div className="preview-pane"><div className="file-heading">{file}</div><div className="code"><ReadRows lines={lines} lang={langOfPath(file)}/></div></div> : <div className="empty">Select a file to preview it.</div>}</> : <><div className="path">Working tree against HEAD</div><div className="file-list changes">{diffs.map((d, i) => <button key={i} className={selected === i ? 'chosen' : ''} onClick={() => setSelected(i)}><span className="change-mark">{d.oldPath === '/dev/null' ? 'A' : 'M'}</span>{displayPath(d.newPath === '/dev/null' ? d.oldPath : d.newPath)}</button>)}</div>{current ? <div className="preview-pane"><div className="file-heading">{displayPath(current.newPath)}</div><div className="code">{current.binary ? <p>Binary file changed</p> : <DiffRows segments={segments} lang={langOfPath(current.newPath)}/>}</div></div> : <div className="empty">No local changes.</div>}</>}
    </aside>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
