// Integration with the actual background exec provider, not a simulated monitor.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter, once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'pi-goal-exec-pair-'));
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = join(root, 'global.json');
process.env.PI_GOAL_SETTINGS_FILE = join(root, 'local.json');
const sdk = process.env.PI_SDK_ROOT || join(dirname(process.execPath), '..', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
const req = createRequire(join(sdk, 'package.json'));
const {createJiti} = req('jiti');
const jiti = createJiti(import.meta.url, {alias: {
  '@earendil-works/pi-coding-agent': join(sdk, 'dist', 'index.js'),
  '@earendil-works/pi-ai': join(sdk, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'compat.js'),
  '@earendil-works/pi-tui': join(sdk, 'node_modules', '@earendil-works', 'pi-tui', 'dist', 'index.js'),
  typebox: req.resolve('typebox'),
}});
const {GoalScheduler} = await jiti.import('../extensions/goal-scheduler.ts');
const {newGoalScheduler} = await jiti.import('../extensions/goal-scheduler-state.ts');
const toolsRoot = process.env.PI_CODEX_TOOLS_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pi-codex-tools-ssh');
const {default: codexTools} = await jiti.import(join(toolsRoot, 'src/index.ts'));
const bus = new EventEmitter(), tools = new Map(), handlers = new Map(), messages = [];
const events = {on(name, fn) { bus.on(name, fn); return () => bus.off(name, fn); }, emit: (name, value) => bus.emit(name, value)};
const pi = {events, registerTool: tool => tools.set(tool.name, tool), registerCommand() {},
  on: (name, fn) => handlers.set(name, [...(handlers.get(name) || []), fn]),
  sendMessage: (message, options) => messages.push({message, options}),
  getActiveTools: () => [], setActiveTools() {}, getAllTools: () => []};
let queued = 0;
const core = {state: {goal: {id: 'test-goal', status: 'active', autoContinue: true, usage: {tokensUsed: 0}, scheduler: newGoalScheduler('test-session')}}, pi,
  goalService: {flushForAudit: () => undefined, isTurnBuffered: () => false,
    apply: (_ctx, operation) => {core.state.goal = operation.mutate(structuredClone(core.state.goal)); return {ok: true, goal: core.state.goal};}},
  updateUI() {}, clearActiveAccounting() {}, reconcileFocusedGoalFromDisk: () => true,
  runtime: {clearContinuationState() {}, clearContinuationTimer() {}, queueContinuation() {queued++;}}};
const ctx = {cwd: root, hasUI: true, hasPendingMessages: () => false, model: {id: 'gpt-6'},
  sessionManager: {getSessionId: () => 'test-session'}, ui: {setStatus() {}, notify() {}}};
const scheduler = new GoalScheduler(core);
codexTools(pi);
scheduler.attach(ctx);
try {
  // Subscribe before launching: notifications are edge-triggered.
  const notification = once(bus, 'pi-monitor:notification', {signal: AbortSignal.timeout(10000)});
  const start = await tools.get('exec_command').execute('test', {
    cmd: "node -e 'setTimeout(() => console.log(\"DONE\"), 1200)'", yield_time_ms: 100, login: false, notify: 'exit',
  }, undefined, undefined, ctx);
  assert.equal(typeof start.details.session_id, 'number');
  scheduler.begin(ctx);
  scheduler.recordFinalMessage([{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'Waiting. GOAL_WAIT'}]}]);
  scheduler.settled(ctx, true);
  assert.ok(scheduler.isWaiting(), 'one GOAL_WAIT must wait for the real background job');
  await notification;
  assert.ok(!scheduler.isWaiting(), 'real exit notification wakes the goal');
  assert.equal(queued, 0, 'notification itself is the next turn, without a duplicate goal turn');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.customType, 'monitor-event');
  assert.equal(messages[0].options.triggerTurn, true);
  console.log('PASS: real exec_command → one GOAL_WAIT → exit notification; no duplicate continuation');
} finally {
  scheduler.shutdown();
  for (const fn of handlers.get('session_shutdown') || []) await fn({}, ctx);
  await rm(root, {recursive: true, force: true});
}