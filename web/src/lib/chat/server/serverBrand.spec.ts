import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND_DEFAULTS, resolveBrand } from "$lib/chat/brand";
import { buildPersonaPrompt } from "$lib/chat/server/textGeneration/persona";
import { nativeSystemPrompt } from "$lib/chat/server/textGeneration/native";
import { buildProvenanceFacts } from "$lib/chat/server/textGeneration/provenanceFacts";
import { agentIdentityPreamble } from "$lib/chat/server/endpoints/agent/endpointAgent";

const FEATURES = { dictation: false, textFiles: false, images: false, documents: false, readAloud: false };
const NATIVE = { modelId: "m", fence: "Q_x", web: true, today: "2026-10-01", account: { loginOffered: true, signedIn: false }, features: FEATURES };
const TOKENS = /\{(product|organisation|assistantName|aboutProject)\}/;

describe("resolveBrand: an install names itself from env, and today's names are the default", () => {
	it("reads all three names and trims them", () => {
		expect(
			resolveBrand({ BRAND_ORGANISATION_NAME: " Acme ", BRAND_PRODUCT_NAME: "Acme Chat", BRAND_ASSISTANT_NAME: "Ada" })
		).toEqual({ organisation: "Acme", product: "Acme Chat", assistant: "Ada" });
	});

	it("keeps a default for each name that is unset or blank", () => {
		expect(resolveBrand({})).toEqual(BRAND_DEFAULTS);
		expect(resolveBrand({ BRAND_ORGANISATION_NAME: "  ", BRAND_PRODUCT_NAME: "", BRAND_ASSISTANT_NAME: " " })).toEqual(
			BRAND_DEFAULTS
		);
	});

	it("takes Open WebUI's WEBUI_NAME as the product name, and BRAND_PRODUCT_NAME over it", () => {
		expect(resolveBrand({ WEBUI_NAME: "Team Chat" }).product).toBe("Team Chat");
		expect(resolveBrand({ WEBUI_NAME: "Team Chat", BRAND_PRODUCT_NAME: "Acme Chat" }).product).toBe("Acme Chat");
	});
});

describe("the model is told this install's names, and today's when none are set", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("with no brand set, every prompt says AI Potluck and Current AI, with no token left unfilled", () => {
		const prompts = [
			buildPersonaPrompt("m", undefined, { features: FEATURES }),
			nativeSystemPrompt(NATIVE),
			buildProvenanceFacts({ modelId: "m" }),
			agentIdentityPreamble("m"),
		];
		for (const p of prompts) {
			expect(p).toContain("AI Potluck, a chat app that Current AI runs");
			expect(p).not.toMatch(TOKENS);
		}
	});

	it("with a brand set, every prompt names the install and its operator, never ours as the operator", () => {
		vi.stubEnv("BRAND_ORGANISATION_NAME", "Acme");
		vi.stubEnv("BRAND_PRODUCT_NAME", "Acme Chat");
		const prompts = [
			buildPersonaPrompt("m", undefined, { features: FEATURES }),
			nativeSystemPrompt(NATIVE),
			buildProvenanceFacts({ modelId: "m" }),
			agentIdentityPreamble("m"),
		];
		for (const p of prompts) {
			expect(p).toContain("Acme Chat, a chat app that Acme runs; Acme did not build you");
			expect(p).not.toContain("Current AI runs");
			expect(p).not.toMatch(TOKENS);
		}
		const persona = prompts[0];
		expect(persona).toContain("not sent to Acme");
		// The project the app comes from keeps its own name as a credit.
		expect(persona).toContain("chat surface of Acme Chat, built from AI Potluck");
	});

	it("an assistant name is given alongside the real model, and only when set", () => {
		const unnamed = buildPersonaPrompt("m");
		expect(unnamed).not.toContain("On this app you are called");
		vi.stubEnv("BRAND_ASSISTANT_NAME", "Ada");
		const named = buildPersonaPrompt("m");
		expect(named).toMatch(/On this app you are called Ada; when asked your name, say you are Ada, running on \S/);
		expect(named).not.toContain("{model}");
		expect(agentIdentityPreamble("m")).toContain("On this app you are called Ada");
	});
});
