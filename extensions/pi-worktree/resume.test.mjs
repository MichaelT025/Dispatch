import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSessions, listableSessions, relativeTime, renderPicker, sessionLabel } from './resume.mjs';

const wt = (path, branch, head = 'abcdef1234') => ({ path, branch, head, bare: false, locked: false, prunable: false });
const info = (path, cwd, modified, extra = {}) => ({
  path, cwd, id: path, created: new Date(modified), modified: new Date(modified), messageCount: 3, firstMessage: 'first message here', allMessagesText: '', ...extra
});

const worktrees = [wt('/repo', 'main'), wt('/wt/feat-x', 'feat/x'), wt('/wt/det', null)];

test('empty sessions are never listed', () => {
  const kept = listableSessions([info('/a', '/repo', 1000, { messageCount: 0 }), info('/b', '/repo', 2000)]);
  assert.deepEqual(kept.map(s => s.path), ['/b']);
});

test('sessions group under their checkout, main first, then current, newest first inside', () => {
  const groups = groupSessions(worktrees, [
    info('/s/old-main', '/repo', 1000),
    info('/s/new-main', '/repo', 5000),
    info('/s/feat', '/wt/feat-x', 9000),
    info('/s/gone', '/removed-worktree', 9999)
  ], '/wt/det');
  assert.deepEqual(groups.map(g => [g.worktree.branch, g.isMain, g.isCurrent, g.sessions.map(s => s.path)]), [
    ['main', true, false, ['/s/new-main', '/s/old-main']],
    [null, false, true, []],
    ['feat/x', false, false, ['/s/feat']]
  ]);
});

test('remaining checkouts order by their newest session', () => {
  const groups = groupSessions([wt('/repo', 'main'), wt('/wt/a', 'a'), wt('/wt/b', 'b')], [
    info('/s/a', '/wt/a', 1000),
    info('/s/b', '/wt/b', 2000)
  ], '/repo');
  assert.deepEqual(groups.map(g => g.worktree.branch), ['main', 'b', 'a']);
});

test('picker lines: headers, indented sessions, live marker, parallel targets', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0);
  const groups = groupSessions([wt('/home/me/repo', 'main'), wt('/home/me/.pi/worktrees/repo/feat-x', 'feat/x')], [
    info('/s/one.jsonl', '/home/me/repo', now - 3600_000, { name: 'Fix worker guard release' }),
    info('/s/two.jsonl', '/home/me/.pi/worktrees/repo/feat-x', now - 120_000, { messageCount: 1 })
  ], '/home/me/.pi/worktrees/repo/feat-x');
  const { lines, targets } = renderPicker(groups, { currentSessionFile: '/s/two.jsonl', home: '/home/me', now });
  assert.deepEqual(lines, [
    'main  →  ~/repo  (main)',
    '    Fix worker guard release  ·  3 msgs · 1h ago',
    'feat/x  →  ~/.pi/worktrees/repo/feat-x  (current)',
    '  ● first message here  ·  1 msg · 2m ago'
  ]);
  assert.equal(targets.length, lines.length);
  assert.deepEqual(targets[0], { kind: 'worktree', path: '/home/me/repo', branch: 'main' });
  assert.equal(targets[1].kind, 'session');
  assert.equal(targets[1].path, '/s/one.jsonl');
  assert.equal(targets[3].live, true);
});

test('a checkout without sessions is still offered as a target', () => {
  const groups = groupSessions([wt('/repo', 'main')], [], '/repo');
  const { lines, targets } = renderPicker(groups, { home: '/nowhere' });
  assert.equal(lines.length, 2);
  assert.match(lines[1], /no sessions/);
  assert.deepEqual(targets[1], { kind: 'worktree', path: '/repo', branch: 'main' });
});

test('labels prefer the name, collapse whitespace and truncate', () => {
  assert.equal(sessionLabel({ name: 'Named', firstMessage: 'ignored' }), 'Named');
  assert.equal(sessionLabel({ firstMessage: '  so   the fast\nagent ' }), 'so the fast agent');
  assert.equal(sessionLabel({ firstMessage: 'x'.repeat(60) }, 10), 'xxxxxxxxx…');
  assert.equal(sessionLabel({}), '(untitled)');
});

test('relative time is coarse', () => {
  const now = Date.UTC(2026, 8, 15);
  assert.equal(relativeTime(new Date(now - 10_000), now), 'just now');
  assert.equal(relativeTime(new Date(now - 5 * 60_000), now), '5m ago');
  assert.equal(relativeTime(new Date(now - 3 * 3600_000), now), '3h ago');
  assert.equal(relativeTime(new Date(now - 2 * 86400_000), now), '2d ago');
  assert.equal(relativeTime(new Date(now - 40 * 86400_000), now), '2026-08-06');
});
