import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TEMPLATES } from 'pi-web-ui/dist/server/subagent-templates.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = join(root, '.local', 'agent');
const webDir = join(root, '.local', 'web');
const config = JSON.parse(readFileSync(join(root, 'config', 'agents.json'), 'utf8'));
for (const path of [agentDir, webDir]) mkdirSync(path, { recursive: true });

function seed(path, value) {
  if (existsSync(path)) return;
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

const [provider, ...modelParts] = config.orchestrator.model.split('/');
seed(join(agentDir, 'settings.json'), {
  defaultProvider: provider,
  defaultModel: modelParts.join('/'),
  defaultThinkingLevel: config.orchestrator.thinking,
  retry: { enabled: true, maxRetries: 2 },
});

// Native templates cannot yet enforce per-role effort or model fallback.
// Seed disabled templates until the integration is verified; never silently
// inherit Astra for an unconfigured Go worker.
const templates = ['general', 'fast', 'review'].map(name => ({
  name,
  description: `PiAstra ${name} (prepared; runtime integration pending)`,
  promptMode: 'append',
  systemPrompt: readFileSync(join(root, 'roles', `${name}.md`), 'utf8'),
  enabledSkills: [],
  enabledExtensions: [],
  model: config[name].model ?? '',
  enabled: false,
}));
seed(join(webDir, 'subagent-templates.json'), templates);
// Upstream otherwise auto-seeds its larger specialist roster on startup.
seed(join(webDir, 'subagent-templates.seeded.json'), DEFAULT_TEMPLATES.map(t => t.name));
seed(join(webDir, 'client-state.json'), {
  __settings__: {
    settings: {
      customSystemPrompt: 'PiAstra setup preview. Worker templates are disabled while the integration is being completed. Do not claim delegation is available or replace unavailable workers with parent-model subagents.',
      promptMode: 'append',
      goalModeEnabled: false,
      visionBridgeEnabled: false,
      retryMaxAttempts: 2,
      disabledAgentTools: [
        'subagent_spawn', 'delegate_task', 'terminal_create', 'terminal_list',
        'terminal_close', 'terminal_input', 'terminal_key', 'terminal_read',
        'terminal_wait', 'edit_soft',
      ],
    },
  },
});

if (process.argv.includes('--import-auth')) {
  const source = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'auth.json');
  const target = join(agentDir, 'auth.json');
  if (existsSync(target)) {
    console.log('Local auth already exists; left unchanged.');
  } else if (existsSync(source)) {
    copyFileSync(source, target);
    console.log('Copied existing Pi authentication into ignored local storage.');
  } else {
    console.log('No existing Pi authentication found. Sign in through Pi using .local/agent.');
  }
}
console.log('Prepared isolated Pi and web UI settings; existing files were preserved.');
console.log('Role prompts are staged. Delegation remains disabled until runtime integration is verified.');
