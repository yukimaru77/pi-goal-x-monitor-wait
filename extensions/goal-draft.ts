import type { GoalTask, GoalTaskList } from "./goal-record.ts";
import { promptSafeObjective } from "./goal-contract.ts";

export type GoalDraftingFocus = "goal" | "sisyphus";

export interface GoalConfirmationIntentLike {
	focus: GoalDraftingFocus;
	originalTopic: string;
	startedAt?: number;
}

export interface DraftProposalInput {
	intent: GoalConfirmationIntentLike | null;
	hasUnfinishedGoal: boolean;
	objective: string;
	sisyphus?: boolean;
	draftId?: string;
}

export type DraftProposalValidation =
	| { ok: true; objective: string; expectedSisyphus: boolean }
	| { ok: false; message: string; clearDrafting?: boolean };

export type ToolGateDecision =
	| { block: false }
	| { block: true; reason: string };

/** Render a task tree as checklist lines for proposal displays. */
export function renderProposalTasks(tasks: readonly GoalTask[], indent: number): string[] {
	const prefix = "  ".repeat(indent);
	const lines: string[] = [];
	for (const t of tasks) {
		const lw = t.lightweightSubtasks ? " (lightweight)" : "";
		const contract = t.verificationContract ? ` contract: ${t.verificationContract}` : "";
		lines.push(`${prefix}[ ] ${t.id}: ${t.title}${lw}${contract}`);
		if (t.subtasks && t.subtasks.length > 0) {
			lines.push(...renderProposalTasks(t.subtasks, indent + 1));
		}
	}
	return lines;
}

export function evaluateDraftingToolGate(args: {
	toolName: string;
	draftingFocus?: GoalDraftingFocus | null;
	tweakDraftingGoalId?: string | null;
	activeGoalId?: string | null;
	proposeToolName?: string;
	tweakApplyToolName?: string;
	getGoalToolName?: string;
}): ToolGateDecision {
	// Staying in drafting is prompt-guided, not runtime-enforced. The agent should
	// avoid substantive work before the goal is created, but minimal reconnaissance is allowed.
	void args;
	return { block: false };
}

export function validateGoalDraftProposal(input: DraftProposalInput): DraftProposalValidation {
	if (input.intent === null) {
		return {
			ok: false,
			message: "propose_goal_draft REJECTED: no /goal-draft, /sisyphus, or /goal-tweak guided draft is in progress.",
		};
	}

	const expectedSisyphus = input.intent.focus === "sisyphus";
	const actualSisyphus = input.sisyphus === true;
	if (actualSisyphus !== expectedSisyphus) {
		return {
			ok: false,
			message: `propose_goal_draft REJECTED (focus gate): the user invoked ${input.intent.focus === "sisyphus" ? "/sisyphus" : "/goal"} but you passed sisyphus=${actualSisyphus}. Set sisyphus=${expectedSisyphus} to match their choice.`,
		};
	}

	const objective = input.objective.trim();
	if (!objective) {
		return { ok: false, message: "propose_goal_draft REJECTED: objective is empty." };
	}

	return { ok: true, objective, expectedSisyphus };
}

export function goalDraftingPrompt(topic: string, focus: GoalDraftingFocus): string {
	const safeTopic = promptSafeObjective(topic.trim() || "(no topic provided — ask the user what they want to accomplish)");
	const header = focus === "sisyphus"
		? "[GOAL CONFIRMATION focus=sisyphus]\nThe user invoked Sisyphus intent discussion (/sisyphus). Help turn their request into a goal contract they agree with. Do NOT start substantive work yet."
		: "[GOAL CONFIRMATION focus=goal]\nThe user invoked guided goal drafting (/goal). Help turn their request into a goal contract they agree with. Do NOT start substantive work yet.";

	const commonProtocol = [
		"Drafting protocol:",
		"- Treat this as a lightweight conversation with the user, not a separate long-running runtime phase.",
		"- If the topic is vague, ask one focused question with a recommended default. Use goal_question or goal_questionnaire when a structured answer would help, but plain conversation is acceptable.",
		"- Targeted read-only research is allowed when it helps define a better goal contract; do not start implementation before the goal is created.",
		"- If the topic is already concrete, you may proceed directly to propose_goal_draft.",
		"- The goal contract should make the objective, success criteria, boundaries, constraints, and blocker rule explicit.",
		"- Keep grilling assumptions until the objective, success criteria, boundaries, constraints, and blocker rule are clear enough to create the goal.",
		"- If the objective naturally decomposes into trackable milestones, you MUST include the task list in the `tasks` parameter of `propose_goal_draft` so the goal is created together with its tasks. Do NOT propose the goal without tasks and then call `propose_task_list` separately.",
		"- For simple single-step goals, no task list is required. The `tasks` parameter can be omitted.",
		"- After goal creation, `propose_task_list` is still available for user-requested task additions or structural changes.",
		"- propose_goal_draft creates and focuses the goal (or applies the tweak) immediately; there is no confirmation dialog, so propose only once the user has agreed to the contract in conversation.",
		"- Call propose_goal_draft with the complete structured proposal. The tool call renderer is the scrollable, complete human presentation of the objective and task tree — do NOT duplicate the full proposal in a preceding prose message. A brief orientation sentence is fine.",
		"- create_goal is not a shortcut. Direct create_goal calls are rejected so the user keeps explicit say in goal creation.",
	];

	const goalFocusItems = [
		"For /goal, propose a normal goal in this shape when ready:",
		"=== Goal ===",
		"Objective: <one-sentence outcome>",
		"Success criteria: <observable evidence the goal is done>",
		"Boundaries: <in scope / out of scope>",
		"Constraints: <hard rules>",
		"Verification contract: <optional — what verification evidence is required before marking complete, e.g. 'Run npm test (0 failures), grep for remaining references, re-read requirements and confirm every item is addressed'>",
		"If blocked: <default = stop and ask the user>",
		"Call propose_goal_draft with sisyphus=false and autoContinue=true unless the user asked otherwise.",
	];

	const sisyphusFocusItems = [
		"For /sisyphus, remember that Sisyphus is a prompt/criteria style, not a separate step-counter mechanism.",
		"Propose a Sisyphus goal in this shape when ready:",
		"=== Sisyphus Goal ===",
		"Objective: <one-sentence outcome>",
		"Success criteria: <observable evidence the whole ordered goal is done>",
		"Boundaries: <in scope / out of scope>",
		"Constraints: <hard rules, files not to touch, etc.>",
		"Verification contract: <optional — what verification evidence is required before marking complete>",
		"Ordered steps: <preserve the user's requested steps and ordering; do not add preflight or reconnaissance steps they did not ask for>",
		"If blocked / unclear / failing: <default = stop and ask the user>",
		"Sisyphus reminder: Work patiently and sequentially. No rushing, no unrequested preflight steps, no improvising around blockers.",
		"Call propose_goal_draft with sisyphus=true and autoContinue=true unless the user asked otherwise.",
	];

	return [
		header,
		"",
		"Topic the user provided:",
		"<goal_topic>",
		safeTopic,
		"</goal_topic>",
		"",
		...commonProtocol,
		"",
		...(focus === "sisyphus" ? sisyphusFocusItems : goalFocusItems),
	].join("\n");
}


// ── §14 durable proposal summary ─────────────────────────────────────────────

export interface ProposalSummaryArgs {
	objective: string;
	taskList?: GoalTaskList;
	verificationContract?: string;
	autoContinue: boolean;
	auditorEnabled: boolean;
}

/**
 * Durable proposal summary written to the terminal transcript (plan §14):
 * proposed objective, proposed plan (numbered top-level tasks), verification,
 * automatic-continuation state, and auditor state. Produced when the proposal
 * is applied so the user can review what was created or revised.
 */
export function buildProposalSummary(args: ProposalSummaryArgs): string {
	const lines: string[] = ["Proposed objective:", args.objective.trim()];
	if (args.taskList && args.taskList.tasks.length > 0) {
		lines.push("", "Proposed plan:");
		lines.push(...renderProposalPlan(args.taskList.tasks));
	}
	if (args.verificationContract?.trim()) {
		lines.push("", "Verification:", args.verificationContract.trim());
	}
	lines.push("", `Automatic continuation: ${args.autoContinue ? "enabled" : "disabled"}`);
	lines.push(`Independent auditor: ${args.auditorEnabled ? "enabled" : "disabled"}`);
	return lines.join("\n");
}

function renderProposalPlan(tasks: GoalTask[]): string[] {
	const lines: string[] = [];
	let index = 1;
	for (const t of tasks) {
		lines.push(`${index}. ${t.title}`);
		if (t.subtasks && t.subtasks.length > 0) {
			for (const child of t.subtasks) {
				lines.push(`   - ${child.title}`);
			}
		}
		index++;
	}
	return lines;
}
