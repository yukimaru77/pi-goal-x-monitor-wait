// Run the installed Pi with the checked-out extension in an isolated project.
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'pi-goal-rpc-smoke-'));
try {
  const profile = join(root, 'profile');
  mkdirSync(profile);
  const settings = join(root, 'goal-settings.json');
  // Disable continuation only in this smoke fixture; it makes no model call.
  writeFileSync(settings, JSON.stringify({maxAutonomousRuns: 0}));
  const extension = resolve(dirname(fileURLToPath(import.meta.url)), '../extensions/goal.ts');
  const objective = 'Isolated direct goal smoke test';
  const request = JSON.stringify({id: 'goal-smoke', type: 'prompt', message: `/goal ${objective}`}) + '\n';
  const env = {...process.env, PI_CODING_AGENT_DIR: profile, PI_GOAL_SETTINGS_FILE: settings,
    PI_GOAL_GLOBAL_SETTINGS_FILE: join(root, 'absent-global.json')};
  const result = spawnSync('pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills',
    '--offline', '-e', extension], {cwd: root, env, input: request, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
  assert.equal(result.status, 0, `Pi failed: ${result.error?.message || result.stderr}`);
  const records = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(records.some(record => record.id === 'goal-smoke' && record.success === true), 'RPC command was not accepted');
  const directory = join(root, '.pi', 'goals');
  const active = readdirSync(directory).filter(name => name.startsWith('active_goal_') && name.endsWith('.md'));
  assert.equal(active.length, 1, 'one goal should be persisted');
  assert.match(readFileSync(join(directory, active[0]), 'utf8'), new RegExp(objective));
  console.log('PASS: actual Pi RPC /goal directly persisted one isolated goal');
} finally {
  rmSync(root, {recursive: true, force: true});
}