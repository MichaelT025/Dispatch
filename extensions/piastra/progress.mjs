// Keep terminal previews bounded; full events remain in each Pi transcript.
const clean = value => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export function makeWorker(task, index, model) {
  return { id: index + 1, role: task.role, model, task: clean(task.task), status: 'starting', activity: 'Loading worker', recent: [], text: '', started: Date.now() };
}
export function trackEvent(worker, event) {
  let line;
  if (event.type === 'tool_execution_start') {
    const args = event.args || {};
    const target = args.path || args.file_path || args.command || args.url || [args.operation, args.revision].filter(Boolean).join(' ') || args.pattern || '';
    line = `→ ${event.toolName} ${clean(target).slice(0, 220)}`.trim();
    worker.activity = line;
  } else if (event.type === 'tool_execution_end') {
    line = `${event.isError ? '✗' : '✓'} ${event.toolName}`;
    const text = event.result?.content?.filter(c => c.type === 'text').map(c => c.text).join(' ') || '';
    if (text) line += `: ${clean(text).slice(0, 300)}`;
    worker.activity = `${event.toolName} ${event.isError ? 'failed' : 'finished'}; thinking…`;
  } else if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
    worker.text = (worker.text + clean(event.assistantMessageEvent.delta)).slice(-1200);
    worker.activity = 'Responding…';
  } else return false;
  if (line) worker.recent = [...worker.recent, line].slice(-20);
  return true;
}
export function progressText(workers, expanded = false) {
  return workers.map(w => {
    const seconds = Math.floor(((w.ended || Date.now()) - w.started) / 1000);
    let text = `#${w.id} ${w.role} · ${w.model} · ${w.status} · ${seconds}s\n  ${clean(w.activity)}`;
    if (expanded) {
      text += `\n  Task: ${w.task}\n${w.recent.map(line => `  ${line}`).join('\n')}`;
      if (w.text) text += `\n  Latest response: ${w.text}`;
      if (w.transcript) text += `\n  Transcript: ${w.transcript}`;
    }
    return text;
  }).join('\n\n');
}
