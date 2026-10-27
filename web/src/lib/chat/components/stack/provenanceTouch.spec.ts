import { describe, expect, it } from "vitest";
import type { Message } from "$lib/chat/types/Message";
import { provenanceFacts } from "$lib/chat/utils/trace/provenanceFacts";
import { provenanceTouch } from "./provenanceTouch";

const answer = (backend?: string, extra: Partial<Message> = {}): Message =>
	({
		id: "m1",
		from: "assistant",
		content: "An answer.",
		...(backend ? { routerMetadata: { route: "r", model: "m", backend } } : {}),
		...extra,
	}) as Message;

const lit = (m: Message) => provenanceTouch("sovereign-compute", provenanceFacts(m));

describe("the sovereign-compute card lights only for a turn served on Swiss compute (CUR-1883)", () => {
	it("lights when the recorded backend is on the Swiss allowlist", () => {
		expect(lit(answer("https://api.inference.cscs.ch/v1"))).toBe(true);
	});

	it("stays dark when the recorded backend is outside the Swiss allowlist", () => {
		expect(lit(answer("https://api.together.xyz/v1"))).toBe(false);
	});

	it("stays dark when no backend was recorded, rather than assuming Switzerland", () => {
		expect(lit(answer())).toBe(false);
	});

	it("stays dark for a starter served from cache, even with a Swiss backend on record", () => {
		expect(lit(answer("https://api.inference.cscs.ch/v1", { servedFromCache: true }))).toBe(false);
	});

	it("still lights the cards every answered turn touches, whatever the backend", () => {
		expect(provenanceTouch("foundation-model", provenanceFacts(answer("https://api.together.xyz/v1")))).toBe(true);
	});
});
