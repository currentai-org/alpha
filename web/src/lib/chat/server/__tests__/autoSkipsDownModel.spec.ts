/**
 * Auto stops sending traffic to a model it knows is down, and takes it back on its own. Run
 * against the real `alert_state` table, end to end through the code that writes and reads the marks:
 * the warm probe's verdict (modelProbe.ts) or a turn's failure (modelBusy.ts) sets the mark, the read the
 * chat shell and `/chat/api/busy` share returns it, and Auto's router routes around it. Each test keeps
 * its marks under its own scope, so nothing here reaches another test's reads or a visitor's. (CUR-4629)
 */
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "$lib/chat/server/db/client";
import { alertState } from "$lib/chat/server/db/schema";
import { busyModels, noteFailed } from "$lib/chat/server/modelBusy";
import { probeAndRecord } from "$lib/chat/server/modelProbe";
import type { Endpoint, TextGenerationStreamOutputSimplified } from "$lib/chat/server/endpoints/types";
import { route } from "$lib/chat/routing/router";
import { AUTO, resolveModel } from "$lib/chat/routing/choice";
import { catalog } from "$lib/chat/routing/catalog";
import type { DraftAnalysis } from "$lib/chat/routing/classifier";

const SERVED = catalog.filter((m) => m.status === "live" && m.gatewayId).map((m) => m.gatewayId!);
const DRAFT: DraftAnalysis = {
	language: { value: "eng", confidence: 0.9, alternatives: [], signal: "words" },
	difficulty: { value: "S", confidence: 0.8 },
	skills: [],
	source: "manual",
};
const QUESTION = "What is the capital of France?";

const scopes: string[] = [];
const freshScope = () => {
	const scope = `cur4629-${randomUUID().slice(0, 8)}`;
	scopes.push(scope);
	return scope;
};
afterAll(async () => {
	for (const scope of scopes) await getDb().delete(alertState).where(like(alertState.key, `busy@${scope}:%`));
});

/** Auto's choice for DRAFT with every live model served, given the marks under `scope`. */
async function autoPick(scope: string) {
	return route(DRAFT, SERVED, { busy: await busyModels(new Date(), scope) })!;
}

const answering: Endpoint = async () =>
	(async function* () {
		yield { token: { id: 1, text: "Paris", logprob: 0, special: false }, generated_text: null, details: null } as TextGenerationStreamOutputSimplified;
	})();
const routerNotFound: Endpoint = async () => {
	throw Object.assign(new Error("404 litellm.NotFoundError: OpenAIException - Not Found"), { status: 404 });
};
const probeTarget = (id: string, endpoint: Endpoint) => ({ id, getEndpoint: async () => endpoint });

describe("Auto and a model it knows is down (CUR-4629)", () => {
	it("Auto does not pick a model whose last warm check failed on the router's 404, and picks its next best", async () => {
		const scope = freshScope();
		const usual = await autoPick(scope);
		const down = usual.model.gatewayId!;

		const verdict = await probeAndRecord(probeTarget(down, routerNotFound), { scope, deadlineMs: 5_000 });
		expect(verdict).toMatchObject({ ok: false, reason: "http-404" });

		const after = await autoPick(scope);
		expect(after.model.gatewayId, "Auto still sent the question to the model the probe found down").not.toBe(down);
		expect(after.busy?.gatewayId).toBe(down);
	});

	it("a model marked down returns to Auto after one successful warm check, with no deploy or flag", async () => {
		const scope = freshScope();
		const usual = await autoPick(scope);
		const down = usual.model.gatewayId!;
		await probeAndRecord(probeTarget(down, routerNotFound), { scope, deadlineMs: 5_000 });
		expect((await autoPick(scope)).model.gatewayId).not.toBe(down);

		const verdict = await probeAndRecord(probeTarget(down, answering), { scope, deadlineMs: 5_000 });
		expect(verdict).toMatchObject({ ok: true });
		expect(await busyModels(new Date(), scope), "the answered probe left the mark standing").not.toContain(down);
		expect((await autoPick(scope)).model.gatewayId, "Auto did not take the model back").toBe(down);
	});

	it("two hard turn failures in a row mark a model down, and one does not", async () => {
		const scope = freshScope();
		const down = (await autoPick(scope)).model.gatewayId!;
		await noteFailed(down, scope);
		expect((await autoPick(scope)).model.gatewayId, "one failed turn was enough to mark the model down").toBe(down);
		await noteFailed(down, scope);
		expect((await autoPick(scope)).model.gatewayId).not.toBe(down);
	});

	it("a hand-picked model is used even when marked down", async () => {
		const scope = freshScope();
		const usual = await autoPick(scope);
		const down = usual.model.gatewayId!;
		await probeAndRecord(probeTarget(down, routerNotFound), { scope, deadlineMs: 5_000 });
		const busy = await busyModels(new Date(), scope);
		expect(busy).toContain(down);

		expect(resolveModel(usual.model.id, QUESTION, SERVED, { busy }).modelId).toBe(down);
		expect(resolveModel(AUTO, QUESTION, SERVED, { busy, analysis: DRAFT }).modelId).not.toBe(down);
	});

	it("keeps Auto's normal pick, never a refusal, when every candidate is marked down", async () => {
		const scope = freshScope();
		const usual = await autoPick(scope);
		for (const id of SERVED) await noteFailed(id, scope, { decisive: true });
		const after = await autoPick(scope);
		expect(after.model.gatewayId).toBe(usual.model.gatewayId);
	});
});
