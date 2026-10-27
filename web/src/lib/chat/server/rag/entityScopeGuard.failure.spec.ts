import { describe, it, expect, vi, beforeEach } from "vitest";

// classifyEntityMatch through the REAL generateFromDefaultEndpoint, so the failure shape is the one the
// wrapper actually produces (it never throws; a failed call returns ""). Only the endpoint is faked.
// The sibling entityScopeGuard.spec.ts mocks the wrapper whole, so it does not cover this.
const h = vi.hoisted(() => ({ endpoint: vi.fn() }));

vi.mock("$lib/chat/server/models", () => {
	const m = { id: "test-model", name: "test-model", getEndpoint: async () => h.endpoint };
	return { models: [m], defaultModel: m, taskModel: m };
});
vi.mock("$lib/chat/server/config", () => ({ config: {} }));
vi.mock("$lib/chat/server/failOpen", () => ({ failOpenDeparture: vi.fn() }));

import { failOpenDeparture } from "$lib/chat/server/failOpen";
import { classifyEntityMatch } from "./entityScopeGuard";

const HIT = { title: "Safety screen", snippet: "Our taxonomy of safety screens." };

function answering(text: string) {
	return async function* () {
		yield { token: { text }, generated_text: text };
	};
}

describe("classifyEntityMatch records an entity-scope departure when it keeps a hit without a verdict (CUR-2123)", () => {
	beforeEach(() => {
		h.endpoint.mockReset();
		vi.mocked(failOpenDeparture).mockReset();
	});

	it("a refused call keeps the hit AND records one departure", async () => {
		h.endpoint.mockImplementation(async function* () {
			yield* [];
			throw Object.assign(new Error("503 upstream refused"), { status: 503 });
		});
		expect(await classifyEntityMatch("is Anthropic's safety team any good", HIT, undefined)).toBe(true);
		expect(vi.mocked(failOpenDeparture)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(failOpenDeparture)).toHaveBeenCalledWith(
			"entity-scope",
			"error",
			expect.objectContaining({ status: 503 })
		);
	});

	it("an unparseable reply keeps the hit AND records one departure", async () => {
		h.endpoint.mockImplementation(answering("maybe"));
		expect(await classifyEntityMatch("is Anthropic's safety team any good", HIT, undefined)).toBe(true);
		expect(vi.mocked(failOpenDeparture)).toHaveBeenCalledWith(
			"entity-scope",
			"unparseable",
			expect.any(Object)
		);
	});

	it("a real 'no' drops the hit and records nothing", async () => {
		h.endpoint.mockImplementation(answering("no"));
		expect(await classifyEntityMatch("is Anthropic's safety team any good", HIT, undefined)).toBe(false);
		expect(vi.mocked(failOpenDeparture)).not.toHaveBeenCalled();
	});

	it("a real 'yes' keeps the hit and records nothing", async () => {
		h.endpoint.mockImplementation(answering("yes"));
		expect(await classifyEntityMatch("who runs Current AI", HIT, undefined)).toBe(true);
		expect(vi.mocked(failOpenDeparture)).not.toHaveBeenCalled();
	});
});
