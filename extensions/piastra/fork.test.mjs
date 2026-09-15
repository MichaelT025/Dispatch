import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UPSTREAM_DELEGATION_TOOLS, FORK_DISABLED_AGENT_TOOLS, FORK_TERMINAL_TOOLS } from './policy.mjs';
import { agentTools, agentOrder } from './agents.mjs';

test('upstream delegation tool list matches the fork tool catalog and excludes delegate', () => {
  assert.deepEqual(
    [...UPSTREAM_DELEGATION_TOOLS].sort(),
    ['delegate_task', 'subagent_get_result', 'subagent_list', 'subagent_spawn', 'subagent_steer', 'subagent_stop', 'subagent_templates', 'subagent_wait_all'],
  );
  assert.ok(!UPSTREAM_DELEGATION_TOOLS.includes('delegate'));
});

test('fork disabled-seed list covers delegation, terminal and soft-edit tools', () => {
  for (const tool of [...UPSTREAM_DELEGATION_TOOLS, ...FORK_TERMINAL_TOOLS, 'edit_soft']) {
    assert.ok(FORK_DISABLED_AGENT_TOOLS.includes(tool), tool);
  }
  assert.ok(!FORK_DISABLED_AGENT_TOOLS.includes('bash'));
});

test('role tools are exact allowlists; unknown tools never leak into any role', () => {
  const expected = {
    orchestrator: ['read', 'grep', 'find', 'ls', 'inspect_git', 'fetch_url', 'web_search', 'run_checks', 'read_note', 'list_notes', 'bash', 'edit', 'write', 'write_note', 'delegate'],
    general: ['read', 'grep', 'find', 'ls', 'inspect_git', 'fetch_url', 'web_search', 'run_checks', 'read_note', 'list_notes', 'bash', 'edit', 'write', 'write_note'],
    fast: ['read', 'grep', 'find', 'ls', 'inspect_git', 'fetch_url', 'web_search', 'run_checks', 'read_note', 'list_notes', 'bash', 'edit', 'write', 'write_note'],
    review: ['read', 'grep', 'find', 'ls', 'inspect_git', 'fetch_url', 'web_search', 'run_checks', 'read_note', 'list_notes'],
  };
  // Unknown/foreign tools (fork extras, upstream delegation, arbitrary mutations)
  // are active before the switch and must all be stripped from every role.
  const foreign = ['terminal_create', 'terminal_input', 'edit_soft', 'todo_list', 'subagent_spawn', 'delegator_admin', 'filesystem_cleanup', 'skipped_tool'];
  for (const role of agentOrder) {
    assert.deepEqual([...agentTools(role, foreign)].sort(), [...expected[role]].sort(), role);
  }
  const review = agentTools('review');
  for (const tool of ['bash', 'powershell', 'edit', 'write', 'write_note', 'edit_soft', 'delegate', 'terminal_create', 'terminal_input', 'terminal_wait', 'subagent_spawn']) {
    assert.ok(!review.includes(tool), tool);
  }
});
