import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalScheduler } from "../extensions/goal-scheduler.ts";
import { newGoalScheduler, normalizeGoalScheduler, schedulerSummary } from "../extensions/goal-scheduler-state.ts";
import { invalidateGoalSettingsCache } from "../extensions/goal-settings.ts";
import type { GoalCore } from "../extensions/goal-state.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const final = (text = "Watching the job. GOAL_WAIT") => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
function harness(t: any) {
 const cwd = mkdtempSync(join(tmpdir(), "pi-goal-monitor-test-"));
 const previous = { global: process.env.PI_GOAL_GLOBAL_SETTINGS_FILE, local: process.env.PI_GOAL_SETTINGS_FILE };
 process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = join(cwd, "global.json");
 process.env.PI_GOAL_SETTINGS_FILE = join(cwd, "settings.json");
 writeFileSync(process.env.PI_GOAL_GLOBAL_SETTINGS_FILE, "{}");
 writeFileSync(process.env.PI_GOAL_SETTINGS_FILE, "{}");
 invalidateGoalSettingsCache();
 const listeners = new Map<string, Set<(v: any) => void>>();
 const events = {
  on(name: string, fn: (v: any) => void) { const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(fn); return () => set.delete(fn); },
  emit(name: string, v: any) { for (const fn of listeners.get(name) ?? []) fn(v); },
 };
 let active = 1, sequence = 0, queued = 0, accountingCleared = 0, pending = false;
 events.on("pi-monitor:query", q => Object.assign(q, { active, sequence }));
 const goal: any = { id: "goal-1", status: "active", autoContinue: true, objective: "Watch test", usage: { tokensUsed: 17, activeSeconds: 5 }, tokenBudget: 200,
  scheduler: { ...newGoalScheduler("session-1"), used: 3 } };
 const state = { goal };
 let durable = structuredClone(goal);
 const core = {
  state, pi: { events }, runningGoalId: null,
  goalService: { flushForAudit: () => undefined, isTurnBuffered: () => false,
   apply(_ctx: unknown, options: any) { state.goal = options.mutate(structuredClone(state.goal)); durable = structuredClone(state.goal); return { ok: true, goal: state.goal }; } },
  updateUI() {}, reconcileFocusedGoalFromDisk() {},
  runtime: { clearContinuationState() {}, clearContinuationTimer() {}, queueContinuation() { queued++; }, markTurnStopped() {}, setCheckpoint() {} },
  clearActiveAccounting() { accountingCleared++; },
 } as unknown as GoalCore;
 const ctx = { cwd, sessionManager: { getSessionId: () => "session-1" }, ui: { notify() {} }, hasPendingMessages: () => pending } as unknown as ExtensionContext;
 let scheduler = new GoalScheduler(core); scheduler.attach(ctx);
 t.after(() => { scheduler.shutdown(); rmSync(cwd, { recursive: true, force: true });
  for (const [key, value] of [["PI_GOAL_GLOBAL_SETTINGS_FILE", previous.global], ["PI_GOAL_SETTINGS_FILE", previous.local]]) {
   if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  } invalidateGoalSettingsCache(); });
 return {
  core, ctx, state, events, get scheduler() { return scheduler; }, get queued() { return queued; }, get accountingCleared() { return accountingCleared; },
  get sequence() { return sequence; }, setActive(n: number) { active = n; }, setPending(p: boolean) { pending = p; },
  settings(s: unknown) { writeFileSync(join(cwd, "settings.json"), JSON.stringify(s)); invalidateGoalSettingsCache(); },
  start() { scheduler.begin(ctx); scheduler.message(ctx, { role: "user", content: "Watch" }); scheduler.turn(ctx); },
  /** A run opened by the goal's own continuation (the confirmation question after a first GOAL_WAIT). */
  cont() { scheduler.begin(ctx); scheduler.message(ctx, { role: "custom", customType: "pi-goal-event", content: "continue" }); scheduler.turn(ctx); },
  end(messages: unknown[] = [final()]) { scheduler.recordFinalMessage(messages); scheduler.settled(ctx); },
  notify() { sequence++; events.emit("pi-monitor:notification", { id: "monitor-1", sequence }); },
  consumeNotification() { scheduler.message(ctx, { role: "custom", customType: "monitor-event", details: { sequence } }); },
  reload() { scheduler.shutdown(); state.goal = { ...structuredClone(durable), scheduler: normalizeGoalScheduler(JSON.parse(JSON.stringify(durable.scheduler))) }; scheduler = new GoalScheduler(core); scheduler.restore(ctx); },
 };
}

test("active goal + running monitor + GOAL_WAIT confirmed by the next run persist a wait without resetting counters", t => {
 const h = harness(t); h.start(); h.end();
 // The first GOAL_WAIT only asks for confirmation through the continuation.
 assert.equal(h.state.goal.scheduler.monitorWait, undefined); assert.equal(h.queued, 1);
 assert.match(h.scheduler.consumeMonitorWaitFeedback(), /not entered yet[\s\S]*end this turn with GOAL_WAIT again/);
 h.cont(); h.end();
 assert.equal(h.state.goal.status, "active"); assert.equal(h.state.goal.autoContinue, true);
 assert.equal(h.state.goal.scheduler.phase, "waiting"); assert.ok(h.state.goal.scheduler.monitorWait);
 assert.equal(h.state.goal.scheduler.used, 3); assert.equal(h.state.goal.usage.tokensUsed, 17); assert.equal(h.state.goal.tokenBudget, 200);
 assert.equal(h.queued, 1); assert.equal(h.accountingCleared, 1); assert.ok(h.scheduler.isWaiting());
 assert.match(schedulerSummary(h.state.goal.scheduler), /GOAL_WAIT/);
 h.setActive(0); h.reload(); h.scheduler.schedule(h.ctx);
 assert.ok(h.scheduler.isWaiting()); assert.equal(h.queued, 1); assert.equal(h.state.goal.scheduler.used, 3);
});

test("monitor alone continues; marker without a monitor continues with feedback", t => {
 const h = harness(t); h.start(); h.end([final("More work remains")]); assert.equal(h.queued, 1);
 h.setActive(0); h.start(); h.end(); assert.equal(h.queued, 2); assert.equal(h.state.goal.scheduler.monitorWait, undefined);
 assert.match(h.scheduler.consumeMonitorWaitFeedback(), /no exec_command session is running in the background/); assert.equal(h.scheduler.consumeMonitorWaitFeedback(), "");
});

test("only the final assistant stop text counts, not tools, thinking, user text, old or failed messages", t => {
 const h = harness(t);
 for (const messages of [
  [final(), final("Continue")], [{ role: "user", content: "GOAL_WAIT" }],
  [{ role: "toolResult", content: [{ type: "text", text: "GOAL_WAIT" }] }],
  [{ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "GOAL_WAIT" }] }],
  [{ ...final(), stopReason: "toolUse" }], [{ ...final(), stopReason: "error" }],
  [final(), { role: "user", content: "Actually continue" }], [final("goal_wait")],
 ]) { h.start(); h.end(messages); assert.equal(h.state.goal.scheduler.monitorWait, undefined); }
});

test("monitor notification releases the wait without sending a duplicate continuation", t => {
 const h = harness(t); h.start(); h.end(); h.cont(); h.end(); h.notify();
 assert.equal(h.state.goal.scheduler.monitorWait, undefined); assert.equal(h.state.goal.scheduler.phase, "idle"); assert.equal(h.queued, 1);
 assert.equal(h.state.goal.scheduler.used, 3); assert.equal(h.state.goal.status, "active");
 // Each new wait is confirmed again.
 h.scheduler.begin(h.ctx); h.consumeNotification(); h.end(); assert.ok(!h.scheduler.isWaiting());
 h.cont(); h.end(); assert.ok(h.scheduler.isWaiting());
});

test("user input wakes a persisted wait, while unrelated extension chatter cannot", t => {
 const h = harness(t); h.start(); h.end(); h.cont(); h.end(); h.reload();
 h.scheduler.message(h.ctx, { role: "custom", customType: "other-extension", content: "hello" }); assert.ok(h.scheduler.isWaiting());
 h.scheduler.message(h.ctx, { role: "user", content: "What happened?" });
 assert.equal(h.state.goal.scheduler.monitorWait, undefined); assert.equal(h.queued, 1); assert.equal(h.state.goal.scheduler.used, 3);
});

test("a delivered monitor message also wakes a persisted wait without its original bus event", t => {
 const h = harness(t); h.start(); h.end(); h.cont(); h.end(); h.reload(); h.consumeNotification();
 assert.equal(h.state.goal.scheduler.monitorWait, undefined); assert.equal(h.queued, 1);
});

test("notification after final output cannot be lost to a new wait; consumed notification permits a later wait", t => {
 const h = harness(t); h.start(); h.scheduler.recordFinalMessage([final()]); h.notify(); h.scheduler.settled(h.ctx);
 assert.equal(h.state.goal.scheduler.monitorWait, undefined);
 h.start(); h.notify(); h.consumeNotification(); h.end(); h.cont(); h.end(); assert.ok(h.scheduler.isWaiting());
});

test("pending user/monitor messages prevent entering wait", t => {
 const h = harness(t); h.start(); h.setPending(true); h.end(); assert.equal(h.state.goal.scheduler.monitorWait, undefined);
});

test("ownership, stopped goals and replaced goals do not enter or release another goal's wait", t => {
 const h = harness(t);
 for (const status of ["paused", "complete", "blocked", "budget_limited"]) {
  h.state.goal.status = status; h.start(); h.end(); assert.equal(h.state.goal.scheduler.monitorWait, undefined);
 }
 h.state.goal.status = "active"; h.state.goal.scheduler.owner = "another-session"; h.start(); h.end(); assert.equal(h.state.goal.scheduler.monitorWait, undefined);
 h.state.goal.scheduler.owner = "session-1"; h.start(); h.state.goal.id = "different-goal"; h.end(); assert.equal(h.state.goal.scheduler.monitorWait, undefined);
});

test("goal wait does not bypass token or autonomous-run limits", t => {
 const h = harness(t); h.state.goal.usage.tokensUsed = 200; h.start(); h.end();
 assert.equal(h.state.goal.scheduler.monitorWait, undefined); assert.equal(h.state.goal.status, "paused");
 h.state.goal.status = "active"; h.state.goal.autoContinue = true; h.state.goal.usage.tokensUsed = 17;
 h.settings({ maxAutonomousRuns: 3 }); h.start(); h.end();
 assert.equal(h.state.goal.scheduler.monitorWait, undefined); assert.equal(h.state.goal.scheduler.used, 3); assert.equal(h.state.goal.status, "paused");
});

test("normalizer accepts persisted monitor waits and rejects conflicting deadline waits", t => {
 const s = { ...newGoalScheduler("session-1"), phase: "waiting" as const, decision: { kind: "wait" as const }, monitorWait: { since: Date.now() } };
 assert.deepEqual(normalizeGoalScheduler(JSON.parse(JSON.stringify(s))), s);
 assert.equal(normalizeGoalScheduler({ ...s, monitorWait: { since: "bad" } })?.phase, "interrupted");
 assert.equal(normalizeGoalScheduler({ ...s, phase: "idle" })?.phase, "interrupted");
});

test("the confirmation counts only consecutive runs: work inside a run is fine, a run without GOAL_WAIT or new user input resets it", t => {
 const h = harness(t);
 // The confirming run may call tools before its final GOAL_WAIT; only its final message is judged.
 h.start(); h.end(); h.cont();
 h.end([{ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Checking files" }] }, { role: "toolResult", content: [{ type: "text", text: "ok" }] }, final()]);
 assert.ok(h.scheduler.isWaiting());
 h.notify();
 // A run that ends without GOAL_WAIT drops the pending confirmation.
 h.start(); h.end(); h.cont(); h.end([final("Found more to do")]); h.cont(); h.end();
 assert.ok(!h.scheduler.isWaiting());
 // New user input between the two also needs a fresh confirmation.
 h.start(); h.end(); assert.ok(!h.scheduler.isWaiting());
 h.cont(); h.end(); assert.ok(h.scheduler.isWaiting());
});
