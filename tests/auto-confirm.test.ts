import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The extensions import pi's runtime packages, which this repository does not
// install; load them from the pi installation next to the running node binary.
const sdkRoot = process.env.PI_SDK_ROOT ?? join(dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent");
const sdkRequire = createRequire(join(sdkRoot, "package.json"));
const { createJiti } = sdkRequire("jiti");
const jiti = createJiti(import.meta.url, {
	// The same aliases pi's own extension loader uses for unbundled Node builds.
	alias: {
		"@earendil-works/pi-coding-agent": join(sdkRoot, "dist", "index.js"),
		"@earendil-works/pi-ai": join(sdkRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"),
		"@earendil-works/pi-tui": join(sdkRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
		typebox: sdkRequire.resolve("typebox"),
	},
});
const { registerDraftingTools, startGoalDrafting } = await jiti.import("../extensions/goal-drafting.ts");
const { registerTaskTools } = await jiti.import("../extensions/goal-task-tools.ts");
const { invalidateGoalSettingsCache } = await jiti.import("../extensions/goal-settings.ts");
const { registerGoalCommands } = await jiti.import("../extensions/goal-commands.ts");

const refuseDialog = () => { throw new Error("a confirmation dialog must not open"); };

function harness(t: any) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-goal-auto-confirm-"));
	const previous = { global: process.env.PI_GOAL_GLOBAL_SETTINGS_FILE, local: process.env.PI_GOAL_SETTINGS_FILE };
	process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = join(cwd, "global.json");
	process.env.PI_GOAL_SETTINGS_FILE = join(cwd, "settings.json");
	writeFileSync(process.env.PI_GOAL_GLOBAL_SETTINGS_FILE, "{}");
	writeFileSync(process.env.PI_GOAL_SETTINGS_FILE, "{}");
	invalidateGoalSettingsCache();
	t.after(() => {
		rmSync(cwd, { recursive: true, force: true });
		for (const [key, value] of [["PI_GOAL_GLOBAL_SETTINGS_FILE", previous.global], ["PI_GOAL_SETTINGS_FILE", previous.local]] as const) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		invalidateGoalSettingsCache();
	});
	const tools = new Map<string, any>();
	const state: { goal: any } = { goal: undefined };
	const core: any = {
		state, tasksEnabled: true, runtime: { markTurnStopped() {} },
		pi: { registerTool(tool: any) { tools.set(tool.name, tool); }, appendEntry() {}, sendUserMessage() {} },
		goalService: {
			flushForAudit: () => undefined, isTurnBuffered: () => false,
			apply(_ctx: unknown, options: any) { state.goal = options.mutate(structuredClone(state.goal)); return { ok: true, goal: state.goal }; },
		},
		reconcileFocusedGoalFromDisk() {}, clearContinuationState() {}, clearActiveAccounting() {}, updateUI() {},
		installDraftingToolProfile() {}, installGoalToolProfile() {}, enterGoalModal() {}, exitGoalModal() {},
		focusedOperationToken: (goalId: string) => ({ goalId, revision: 0 }),
		replaceGoal(config: any) { state.goal = { id: "goal-1", status: "active", activePath: join(cwd, "goal.md"), ...config }; },
	};
	const ctx: any = {
		cwd, hasUI: true, mode: "interactive", isIdle: () => true,
		sessionManager: { getSessionId: () => "session-1" },
		ui: { notify() {}, setWorkingVisible() {}, select: refuseDialog, confirm: refuseDialog, input: refuseDialog, custom: refuseDialog },
	};
	return { core, ctx, state, tools };
}

test("propose_goal_draft creates the goal immediately while the UI could show a dialog", async (t) => {
	const h = harness(t);
	registerDraftingTools(h.core);
	await startGoalDrafting(h.core, h.ctx, "goal", "CSV export");

	const result = await h.tools.get("propose_goal_draft").execute("call-1", { objective: "Add CSV export to the reports page", sisyphus: false, tasks: [{ id: "task-1", title: "Write the exporter" }] }, undefined, undefined, h.ctx);

	assert.equal(h.state.goal?.objective, "Add CSV export to the reports page");
	assert.ok(h.state.goal.taskList.tasks.some((task: any) => task.id === "task-1"));
	assert.equal(result.terminate, true);
});

test("set_goal_tasks replaces the task tree immediately while the UI could show a dialog", async (t) => {
	const h = harness(t);
	h.state.goal = { id: "goal-1", status: "active", objective: "Add CSV export", taskList: { tasks: [], blockCompletion: false, proposedAt: "2026-01-01T00:00:00.000Z" } };
	registerTaskTools(h.core);

	const result = await h.tools.get("set_goal_tasks").execute("call-1", { tasks: [{ id: "task-1", title: "Write the exporter" }] }, undefined, undefined, h.ctx);

	assert.ok(h.state.goal.taskList.tasks.some((task: any) => task.id === "task-1"));
	assert.equal(result.terminate, true);
});

test("/goal with an objective starts directly without a drafting dialogue", async (t) => {
	const h = harness(t);
	const commands = new Map<string, any>();
	h.core.pi.registerCommand = (name: string, command: any) => commands.set(name, command);
	registerGoalCommands(h.core);
	await commands.get("goal").handler("  Ship the small change  ", h.ctx);
	assert.equal(h.state.goal?.objective, "Ship the small change");
	assert.equal(h.state.goal?.autoContinue, true);
	assert.equal(h.state.goal?.sisyphus, false);
});
