/**
 * Unit coverage for the curated rule catalog (rules.json): a known action resolves to its reviewed public
 * label and its optional per-rule decline message; an unknown/empty action resolves to null (so the generic
 * safety copy stands); and the kill switch suppresses every label AND message without touching the decline
 * itself. The raw action is never humanized.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	ACTION_LABELS,
	isSupportRule,
	resolveActionLabel,
	resolveActionMessage,
	ruleLabelCatalog,
} from "$lib/chat/server/ruleLabel";

beforeEach(() => {
	vi.stubEnv("COOP_SURFACE_RULE_LABEL", "");
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe("resolveActionLabel", () => {
	it("maps a known action to its curated label", () => {
		expect(resolveActionLabel("chat-block-violence")).toBe("Violent content");
	});

	it("returns null for an unmapped action (generic copy stands — never the raw code)", () => {
		expect(resolveActionLabel("chat-block-some-new-rule")).toBeNull();
	});

	it("returns null for empty / undefined / null input", () => {
		expect(resolveActionLabel("")).toBeNull();
		expect(resolveActionLabel(undefined)).toBeNull();
		expect(resolveActionLabel(null)).toBeNull();
	});

	it("never auto-humanizes the slug — only an explicit rules.json entry produces a label", () => {
		for (const [action, label] of Object.entries(ACTION_LABELS)) {
			expect(resolveActionLabel(action)).toBe(label);
			// the label is reviewed copy, not the raw code echoed back
			expect(label).not.toBe(action);
		}
	});

	it("kill switch (COOP_SURFACE_RULE_LABEL=false) suppresses ALL labels", () => {
		vi.stubEnv("COOP_SURFACE_RULE_LABEL", "false");
		expect(resolveActionLabel("chat-block-violence")).toBeNull();
		vi.stubEnv("COOP_SURFACE_RULE_LABEL", "off");
		expect(resolveActionLabel("chat-block-violence")).toBeNull();
		vi.stubEnv("COOP_SURFACE_RULE_LABEL", "0");
		expect(resolveActionLabel("chat-block-violence")).toBeNull();
	});

	it("any other value (incl. unset) keeps labels on", () => {
		vi.stubEnv("COOP_SURFACE_RULE_LABEL", "true");
		expect(resolveActionLabel("chat-block-violence")).toBe("Violent content");
	});
});

describe("resolveActionMessage", () => {
	it("maps an action with a curated message to that message", () => {
		expect(resolveActionMessage("chat-block-privacy")).toMatch(
			/^This chatbot is not able to help with requests that involve finding, sharing, or exposing someone's personal or private information\./
		);
	});

	it("a policy decline names who set the limit and the rule (CUR-3205)", () => {
		expect(resolveActionMessage("chat-block-violence")).toBe(
			"This request was declined because it goes against our content policy.\n\nCurrent AI set this limit (rule: Violent content)."
		);
	});

	it("crisis-support copy carries no policy attribution, so a person in crisis reads only the support (CUR-3205)", () => {
		for (const key of ["chat-block-self-harm", "chat-block-self-harm-passive"]) {
			const text = resolveActionMessage(key) ?? "";
			expect(text).toMatch(/findahelpline\.com/);
			expect(text).not.toContain("set this limit");
		}
	});

	it("chat-block-prompt has curated decline copy (CUR-831: it used to fall through to the generic content-policy text)", () => {
		expect(resolveActionLabel("chat-block-prompt")).toBe("Prompt injection");
		expect(resolveActionMessage("chat-block-prompt")).toMatch(/override this assistant's instructions/i);
	});

	it("returns null for an unmapped / empty / null action", () => {
		expect(resolveActionMessage("chat-block-some-new-rule")).toBeNull();
		expect(resolveActionMessage("")).toBeNull();
		expect(resolveActionMessage(undefined)).toBeNull();
		expect(resolveActionMessage(null)).toBeNull();
	});

	it("kill switch suppresses custom messages too (generic decline stands)", () => {
		vi.stubEnv("COOP_SURFACE_RULE_LABEL", "false");
		expect(resolveActionMessage("chat-block-privacy")).toBeNull();
	});
});

describe("ruleLabelCatalog (public client catalog)", () => {
	it("returns one entry per curated label, with a valid tier, never a raw action code", () => {
		const cat = ruleLabelCatalog();
		expect(cat.length).toBeGreaterThan(0);
		for (const r of cat) {
			expect(Object.values(ACTION_LABELS)).toContain(r.label); // labels only — no raw codes
			expect(["content", "child"]).toContain(r.kind);
		}
		// a chat-block-* content action → content tier
		expect(cat.find((r) => r.label === "Violent content")?.kind).toBe("content");
	});

	it("dedupes by label (two actions sharing a label yield one card)", () => {
		const labels = ruleLabelCatalog().map((r) => r.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("is empty when the kill switch suppresses labels (no rule names anywhere)", () => {
		vi.stubEnv("COOP_SURFACE_RULE_LABEL", "false");
		expect(ruleLabelCatalog()).toEqual([]);
	});
});

describe("isSupportRule", () => {
	it("is true for each self-harm rule, so its decline brings the Support resources card (CUR-2111)", () => {
		for (const key of ["chat-block-self-harm", "chat-block-self-harm-passive", "chat-block-self-harm-hedged"]) {
			expect(isSupportRule(key), key).toBe(true);
		}
	});

	it("is false for a policy rule, an unknown action and an empty one, so no other decline shows the card", () => {
		expect(isSupportRule("chat-block-anthro")).toBe(false);
		expect(isSupportRule("not-a-rule")).toBe(false);
		expect(isSupportRule(null)).toBe(false);
		expect(isSupportRule(undefined)).toBe(false);
	});

	it("holds with the rule-label kill switch off, since the card is crisis support, not a label", () => {
		vi.stubEnv("COOP_SURFACE_RULE_LABEL", "false");
		expect(isSupportRule("chat-block-self-harm-hedged")).toBe(true);
	});
});
