import assert from "node:assert/strict";
import { test } from "node:test";
import {
	default as jevExtension,
	formatResult,
	lintRequest,
	prepareArguments,
	validateRequest,
	type JevRequest,
	type JevResult,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeStubPi() {
	const tools: Array<Record<string, unknown>> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands: Array<Record<string, unknown>> = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool: (definition: Record<string, unknown>) => tools.push(definition),
		registerCommand: (name: string, options: Record<string, unknown>) => commands.push({ name, options }),
		registerEntryRenderer: () => {},
		sendMessage: () => {},
	};
	return { pi, tools, handlers, commands };
}

const NOUL_REQUEST: JevRequest = {
	state: "hello there",
	questions: { friendly: { type: "noul", instructions: "Is this greeting friendly?" } },
};

// ---------------------------------------------------------------------------
// validateRequest
// ---------------------------------------------------------------------------

test("validateRequest accepts a minimal noul request", () => {
	assert.doesNotThrow(() => validateRequest(NOUL_REQUEST));
});

test("validateRequest rejects choice without criteria", () => {
	assert.throws(
		() => validateRequest({ state: "s", questions: { c: { type: "choice", instructions: "pick" } } }),
		/options map/,
	);
});

test("validateRequest rejects score with fewer than two levels", () => {
	assert.throws(
		() => validateRequest({ state: "s", questions: { sc: { type: "score", instructions: "rate", criteria: ["only"] } } }),
		/ordered array of 2–32/,
	);
});

test("validateRequest rejects missing instructions", () => {
	assert.throws(
		() => validateRequest({ state: "s", questions: { n: { type: "noul" } } } as unknown as JevRequest),
		/instructions: required/,
	);
});

test("validateRequest rejects more than 32 questions", () => {
	const questions: JevRequest["questions"] = {};
	for (let i = 0; i < 33; i++) questions[`q${i}`] = { type: "noul", instructions: `question ${i}` };
	assert.throws(() => validateRequest({ state: "s", questions }), /1–32/);
});

test("validateRequest rejects cyclic state without leaking content", () => {
	const state: Record<string, unknown> = { name: "root" };
	state.self = state;
	assert.throws(() => validateRequest({ state, questions: NOUL_REQUEST.questions }), /plain JSON/);
});

test("validateRequest enforces the 64KiB byte budget", () => {
	assert.throws(
		() => validateRequest({ state: "x".repeat(70_000), questions: NOUL_REQUEST.questions }),
		/64KiB/,
	);
});

// ---------------------------------------------------------------------------
// prepareArguments
// ---------------------------------------------------------------------------

test("prepareArguments folds array questions with ids into a map", () => {
	const folded = prepareArguments({
		state: "s",
		questions: [{ id: "a", type: "noul", instructions: "yes or no?" }],
	}) as { questions: Record<string, { type: string }> };
	assert.deepEqual(Object.keys(folded.questions), ["a"]);
	assert.equal(folded.questions.a.type, "noul");
});

test("prepareArguments leaves map form untouched", () => {
	const input = { state: "s", questions: { a: { type: "noul", instructions: "x" } } };
	assert.deepEqual(prepareArguments(input), input);
});

// ---------------------------------------------------------------------------
// lintRequest
// ---------------------------------------------------------------------------

test("lint warns when a choice lacks a no-match option", () => {
	const warnings = lintRequest({
		state: "s",
		questions: { c: { type: "choice", instructions: "Which team owns this?", criteria: { billing: null, technical: null } } },
	});
	assert.ok(warnings.some((w) => w.includes("no no-match option")), warnings.join("\n"));
});

test("lint stays quiet when a no-match option exists (Chinese included)", () => {
	const warnings = lintRequest({
		state: "s",
		questions: {
			c1: { type: "choice", instructions: "这个工单属于哪类问题?", criteria: { billing: null, technical: null, other: null } },
			c2: { type: "choice", instructions: "这个工单属于哪类问题?", criteria: { billing: null, technical: null, 其他: null } },
		},
	});
	assert.equal(warnings.length, 0);
});

test("lint warns on bare degree words in score levels", () => {
	const warnings = lintRequest({
		state: "s",
		questions: { sc: { type: "score", instructions: "How angry?", criteria: ["low", "medium", "high"] } },
	});
	assert.ok(warnings.some((w) => w.includes("degree words")), warnings.join("\n"));
});

test("lint warns on very short instructions", () => {
	const warnings = lintRequest({
		state: "s",
		questions: { n: { type: "noul", instructions: "ok?" } },
	});
	assert.ok(warnings.some((w) => w.includes("very short")), warnings.join("\n"));
});

test("lint caps at three warnings", () => {
	const warnings = lintRequest({
		state: "s",
		questions: {
			a: { type: "noul", instructions: "ok?" },
			b: { type: "noul", instructions: "ok?" },
			c: { type: "noul", instructions: "ok?" },
			d: { type: "noul", instructions: "ok?" },
		},
	});
	assert.equal(warnings.length, 3);
});

// ---------------------------------------------------------------------------
// formatResult
// ---------------------------------------------------------------------------

const SAMPLE_RESULT: JevResult = {
	model: "jev-1.13.0",
	elapsedMs: 812,
	usage: { input_tokens: 349, output_tokens: 58 },
	estimatedUsd: 349 * (42 / 1e9),
	lint: ['choice "category" has no no-match option'],
	levels: { frustration: ["Calm", "Frustrated", "Very angry"] },
	answers: {
		category: { type: "choice", choice: "billing", confidence: 1, probabilities: { billing: 1, technical: 0, other: 0 } },
		urgent: { type: "noul", noul: 0.93 },
		frustration: { type: "score", score: 1, confidence: 0.7, probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 }, legend: "Frustrated" },
	},
};

test("formatResult shows answers, bars, and lint lines", () => {
	const text = formatResult(SAMPLE_RESULT, false);
	assert.match(text, /jev · jev-1\.13\.0 · 812ms · 349 tok in/);
	assert.match(text, /category: billing · conf 1\.00/);
	assert.match(text, /urgent: P\(yes\) █+·* 0\.930/);
	assert.match(text, /frustration: 1 "Frustrated" · conf 0\.70/);
	assert.match(text, /lint: choice "category" has no no-match option/);
	assert.match(text, /Confidence is distribution concentration/);
});

test("formatResult expanded mode lists score levels with probabilities", () => {
	const text = formatResult(SAMPLE_RESULT, true);
	assert.match(text, /L0 Calm .*0\.10/);
	assert.match(text, /L1 Frustrated .*0\.80/);
	assert.match(text, /L2 Very angry .*0\.10/);
});

// ---------------------------------------------------------------------------
// Extension registration and guards
// ---------------------------------------------------------------------------

test("factory registers jev_ask and the /jev command", () => {
	const { pi, tools, commands } = makeStubPi();
	jevExtension(pi as never);
	const tool = tools.find((t) => t.name === "jev_ask");
	assert.ok(tool, "jev_ask tool missing");
	assert.match(tool.description as string, /TypeSafe/);
	assert.match(tool.description as string, /jev-1\.13\.0/);
	assert.ok(commands.some((c) => c.name === "jev"), "/jev command missing");
});

test("execute throws a configuration error while disabled (opt-in enforced)", async () => {
	delete process.env.PI_TYPESAFE_JEV_ENABLED;
	const { pi, tools } = makeStubPi();
	jevExtension(pi as never);
	const tool = tools.find((t) => t.name === "jev_ask") as {
		execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
	};
	await assert.rejects(
		() => tool.execute("t1", NOUL_REQUEST),
		/jev_ask is disabled/,
	);
});
