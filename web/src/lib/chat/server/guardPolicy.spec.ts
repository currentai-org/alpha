// Guard policy (v2, Shieldstral) — the ONE validator (guardPolicyCore.mjs) exercised from its spec
// consumer, plus the typed loader and its helpers. Each named injury from the plan (Step 1) is proven
// BOTH at the validator and through the real build command (`node scripts/check-guard-policy.mjs
// --file …` exits non-zero) — a gate that cannot go red is not a gate, and it must go red for the
// failure it names.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { validateGuardPolicy, tierForKey } from "./guardPolicyCore.mjs";
import RULES from "./rules.json";
import {
	loadGuardPolicy,
	childRules,
	contentRules,
	thresholdFor,
	__resetGuardPolicyForTest,
} from "./guardPolicy";

const here = dirname(fileURLToPath(import.meta.url));
const CHECK_SCRIPT = resolve(here, "../../../../scripts/check-guard-policy.mjs");
const tmp = mkdtempSync(join(tmpdir(), "guard-policy-injury-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A minimal VALID v2 file the injuries mutate: the reserved `_shield` block + one child + one content
 *  rule (the validator requires at least one child-tier block rule). */
function validRules(): Record<string, unknown> {
	return {
		_shield: {
			instruct: "You are a strict safety moderator.",
			categoryThreshold: 0.5,
			concurrency: 6,
			operationDeadlineMs: 20000,
		},
		"chat-block-violence": {
			label: "Violent content",
			guard: { query: "Does this content request violent crime?", action: "block" },
		},
		"chat-block-child-sexual-content": {
			label: "Child safety",
			guard: { query: "Does this content sexualize a minor?", action: "block" },
		},
	};
}

/** Run the REAL build command on an injured file; return its exit code. */
function buildGateExitCode(rules: unknown): number {
	const file = join(tmp, `rules-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, JSON.stringify(rules));
	try {
		execFileSync(process.execPath, [CHECK_SCRIPT, "--file", file], { stdio: "pipe" });
		return 0;
	} catch (e) {
		return (e as { status?: number }).status ?? 1;
	}
}

// Every named injury: [name, mutate]. Each must fail the validator AND exit the build gate non-zero.
const INJURIES: Array<[string, (r: ReturnType<typeof validRules>) => void]> = [
	["missing _shield block", (r) => delete r._shield],
	[
		"empty _shield.instruct (a required global knob blanked)",
		(r) => {
			(r._shield as { instruct: string }).instruct = "  ";
		},
	],
	[
		"a `_sheild` typo key (reserved namespace must fail loud, not fall through as a rule)",
		(r) => {
			r._sheild = { instruct: "x" };
		},
	],
	[
		"threshold outside (0,1)",
		(r) => {
			(r["chat-block-violence"] as { guard: { threshold?: number } }).guard.threshold = 1.5;
		},
	],
	[
		"categoryThreshold outside (0,1)",
		(r) => {
			(r._shield as { categoryThreshold: number }).categoryThreshold = 0;
		},
	],
	[
		"operationDeadlineMs below the per-call timeout",
		(r) => {
			(r._shield as { operationDeadlineMs: number }).operationDeadlineMs = 5000;
		},
	],
	[
		"concurrency not a positive integer",
		(r) => {
			(r._shield as { concurrency: number }).concurrency = 0;
		},
	],
	[
		"action outside block|log",
		(r) => {
			(r["chat-block-violence"] as { guard: { action: string } }).guard.action = "redact";
		},
	],
	[
		"empty guard.query",
		(r) => {
			(r["chat-block-violence"] as { guard: { query: string } }).guard.query = "";
		},
	],
	[
		"a chat-block-child-* rule whose action is not block (child must fail closed)",
		(r) => {
			(r["chat-block-child-sexual-content"] as { guard: { action: string } }).guard.action = "log";
		},
	],
	[
		"a guard-bearing key outside the chat-block-* namespace (a typo key must fail loud, not silently become content tier)",
		(r) => {
			r["chat-redact-oops"] = { label: "x", guard: { query: "q?", action: "block" } };
		},
	],
	[
		"EMPTY guard policy (total policy removal must fail the build, not deploy an all-safe guard)",
		(r) => {
			(r["chat-block-violence"] as Record<string, unknown>).guardExempt = "x";
			delete (r["chat-block-violence"] as { guard?: unknown }).guard;
			(r["chat-block-child-sexual-content"] as Record<string, unknown>).guardExempt = "x";
			delete (r["chat-block-child-sexual-content"] as { guard?: unknown }).guard;
		},
	],
	[
		"no child-tier BLOCK rule (the child fail-closed contract needs a category to fire)",
		(r) => {
			(r["chat-block-child-sexual-content"] as Record<string, unknown>).guardExempt = "x";
			delete (r["chat-block-child-sexual-content"] as { guard?: unknown }).guard;
		},
	],
	[
		"an enforced entry with NEITHER guard nor guardExempt (a category silently dropped from the sync gate)",
		(r) => {
			delete (r["chat-block-violence"] as { guard?: unknown }).guard;
		},
	],
	[
		"an entry with BOTH guard and guardExempt (contradictory — pick one)",
		(r) => {
			(r["chat-block-violence"] as Record<string, unknown>).guardExempt = "also exempt";
		},
	],
	[
		"present-but-empty _shield.outputInstruct (a blank output Instruct would weaken the output screen)",
		(r) => {
			(r._shield as Record<string, unknown>).outputInstruct = "   ";
		},
	],
	[
		"guard.screens naming a screen that does not exist (a typo would silently drop the rule from both screens)",
		(r) => {
			(r["chat-block-violence"] as { guard: Record<string, unknown> }).guard.screens = ["sideways"];
		},
	],
	[
		"an empty guard.screens (a rule asked on no screen is a removal in disguise)",
		(r) => {
			(r["chat-block-violence"] as { guard: Record<string, unknown> }).guard.screens = [];
		},
	],
	[
		"a chat-block-child-* rule behind a flag (child must fail closed, never switch off)",
		(r) => {
			(r["chat-block-child-sexual-content"] as { guard: Record<string, unknown> }).guard.flag = "some-flag";
		},
	],
];

describe("guardPolicyCore v2 — the ONE validator (runtime + spec + build gate share it 1:1)", () => {
	it("outputInstruct is OPTIONAL and defaults to instruct when absent; used verbatim when present (coop-review-plane Step 3b)", () => {
		const absent = validateGuardPolicy(validRules());
		expect(absent.errors).toEqual([]);
		expect(absent.shield!.outputInstruct).toBe(absent.shield!.instruct);
		const r = validRules();
		(r._shield as Record<string, unknown>).outputInstruct = "Judge the assistant's answer.";
		const present = validateGuardPolicy(r);
		expect(present.errors).toEqual([]);
		expect(present.shield!.outputInstruct).toBe("Judge the assistant's answer.");
	});

	it("accepts the SHIPPED rules.json — the file the runtime loads validates clean, with a shield block", () => {
		const { errors, entries, shield } = validateGuardPolicy(RULES as Parameters<typeof validateGuardPolicy>[0]);
		expect(errors).toEqual([]);
		expect(entries.length).toBeGreaterThan(0);
		expect(shield).not.toBeNull();
	});

	it.each(INJURIES)("rejects: %s", (_name, mutate) => {
		const rules = validRules();
		mutate(rules);
		const { errors } = validateGuardPolicy(rules as Parameters<typeof validateGuardPolicy>[0]);
		expect(errors.length).toBeGreaterThan(0);
	});

	it.each(INJURIES)(
		"build command exits non-zero for: %s (the gate can go red for the failure it names)",
		(_name, mutate) => {
			const rules = validRules();
			mutate(rules);
			expect(buildGateExitCode(rules)).not.toBe(0);
		}
	);

	it("build command exits ZERO on the valid file — green is reachable, so red means something", () => {
		expect(buildGateExitCode(validRules())).toBe(0);
	});

	it("derives tier from the key namespace: child prefix wins, content otherwise, null outside", () => {
		expect(tierForKey("chat-block-child-sexual-content")).toBe("child");
		expect(tierForKey("chat-block-violence")).toBe("content");
		// The child prefix is a NAMESPACE: chat-block-childish is content (delimiter required).
		expect(tierForKey("chat-block-childish")).toBe("content");
		expect(tierForKey("chat-redact-x")).toBe(null);
	});
});

describe("guardPolicy v2 — memoized loader + compose helpers", () => {
	it("loads the shipped file into the typed record (byKey serves {key, query, action, tier}) plus the shield block", () => {
		__resetGuardPolicyForTest();
		const policy = loadGuardPolicy();
		expect(policy).not.toBeNull();
		expect(policy!.byKey.get("chat-block-child-sexual-content")).toMatchObject({
			key: "chat-block-child-sexual-content",
			action: "block",
			tier: "child",
		});
		// Policy pin (coop-review-plane Step 2): self-harm and anthro now BLOCK (were "log"). The
		// supportive self-harm message becomes the decline copy; rules.json is the single source of truth.
		expect(policy!.byKey.get("chat-block-self-harm")).toMatchObject({ action: "block", tier: "content" });
		expect(policy!.byKey.get("chat-block-anthro")).toMatchObject({ action: "block", tier: "content" });
		expect(policy!.shield.instruct.length).toBeGreaterThan(0);
		expect(policy!.shield.concurrency).toBeGreaterThan(0);
	});

	it("every self-harm decline links findahelpline.com and 112 before the US 988 line (CUR-2305)", () => {
		// The screen's decline is the whole reply on this path: the model never runs, so the persona's
		// crisis clause (CUR-2136) can't supply a line. Same order as CrisisResources.svelte.
		const supportRules = Object.entries(RULES as Record<string, { label?: string; message?: string }>).filter(
			([, v]) => v.label === "Support needed"
		);
		expect(supportRules.map(([k]) => k).sort()).toEqual(["chat-block-self-harm", "chat-block-self-harm-eating", "chat-block-self-harm-hedged", "chat-block-self-harm-intent", "chat-block-self-harm-passive"]);
		for (const [key, { message = "" }] of supportRules) {
			const at = (s: string) => message.indexOf(s);
			expect(at("[findahelpline.com](https://findahelpline.com)"), key).toBeGreaterThan(-1);
			expect(at("112"), key).toBeGreaterThan(-1);
			expect(at("988"), key).toBeGreaterThan(at("findahelpline.com"));
		}
	});

	it("childRules are all block-action child-tier; contentRules exclude the child tier", () => {
		__resetGuardPolicyForTest();
		const policy = loadGuardPolicy()!;
		const child = childRules(policy);
		expect(child.length).toBeGreaterThan(0);
		expect(child.every((r) => r.tier === "child" && r.action === "block")).toBe(true);
		expect(contentRules(policy).every((r) => r.tier === "content")).toBe(true);
		// Every entry is one tier or the other — no rule is dropped from both lists.
		expect(child.length + contentRules(policy).length).toBe(policy.entries.length);
	});

	it("thresholdFor uses a per-rule override when present, else the shield categoryThreshold", () => {
		const shield = {
			instruct: "i",
			outputInstruct: "o",
			categoryThreshold: 0.5,
			concurrency: 6,
			operationDeadlineMs: 20000,
		};
		const withOverride = { key: "chat-block-violence", query: "q?", action: "block" as const, tier: "content" as const, threshold: 0.8 };
		const noOverride = { key: "chat-block-fraud", query: "q?", action: "block" as const, tier: "content" as const };
		const policy = { entries: [withOverride, noOverride], byKey: new Map(), shield };
		expect(thresholdFor(policy, withOverride)).toBe(0.8);
		expect(thresholdFor(policy, noOverride)).toBe(0.5);
	});
});
