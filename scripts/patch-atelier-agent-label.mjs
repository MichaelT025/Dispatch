// Reapply after updating Pi Atelier; its footer already receives PiAstra's role status.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const target = path.join(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi/agent'), 'npm/node_modules/pi-atelier/src/footer.ts');
let source = await readFile(target, 'utf8');
if (source.includes('// PiAstra active role label')) {
  console.log('Atelier agent label is already installed.');
} else {
  const original = 'const label = state.activity === "working" && !compact ? (state.workingLabel ?? fallback) : fallback;';
  if (!source.includes(original)) throw new Error('Atelier footer changed; inspect the new renderer before patching.');
  source = source.replace(original, `// PiAstra active role label; keep activity color and animation.
\tconst statuses = (state as AtelierState & { extensionStatuses?: readonly string[] }).extensionStatuses ?? [];
\tconst agent = statuses.map(text => /^Agent: (orchestrator|general|fast|review)$/.exec(text)?.[1]).find(Boolean);
\tconst activityLabel = state.activity === "working" && !compact ? (state.workingLabel ?? fallback) : fallback;
\tconst label = agent ? agent.toUpperCase() + (state.activity === "ready" || state.activity === "working" ? "" : " · " + activityLabel) : activityLabel;`);
  await copyFile(target, `${target}.piastra-backup-${Date.now()}`);
  await writeFile(target, source);
  console.log('Atelier footer now displays the selected PiAstra agent. Restart Pi or /reload.');
}
