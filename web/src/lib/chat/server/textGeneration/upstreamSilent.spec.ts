import { describe, expect, it } from "vitest";
import { NoFirstChunkError } from "$lib/chat/server/endpoints/failover";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import { upstreamSilentMessage, watchdogCountsTowardBusy, watchdogTimedOutMessage } from "./upstreamSilent";

describe("upstreamSilentMessage (CUR-3939)", () => {
	it("gives a last lane that never sent a first chunk the took-too-long sentence, naming the model (CUR-3295)", () => {
		expect(
			upstreamSilentMessage(new NoFirstChunkError("no first chunk within 20000ms"), "Apertus 1.5 70B")
		).toBe("Apertus 1.5 70B took too long to respond. Please try again.");
	});

	it("returns null for any other error, so the busy, dropped and failed mappers still decide those", () => {
		expect(upstreamSilentMessage(Object.assign(new Error("429"), { status: 429 }), "Apertus 1.5 70B")).toBeNull();
		expect(upstreamSilentMessage(new Error("no first chunk"), "Apertus 1.5 70B")).toBeNull();
	});
});

describe("watchdogTimedOutMessage (CUR-4107)", () => {
	const search = { type: MessageUpdateType.WebSearch } as unknown as MessageUpdate;
	const token = { type: MessageUpdateType.Stream, token: "Hi" } as MessageUpdate;
	const generic = "The request took too long to respond. Please try again.";
	const named = "Apertus 1.5 70B took too long to respond. Please try again.";

	it("does not name the model when one of our tool steps ran after the model call began", () => {
		expect(watchdogTimedOutMessage([token, search], 0, "Apertus 1.5 70B")).toBe(generic);
	});

	it("does not name the model when the stall came before retrieval finished", () => {
		expect(watchdogTimedOutMessage([], undefined, "Apertus 1.5 70B")).toBe(generic);
	});

	it("names the model when it went quiet after retrieval, even if a search was stamped before the call", () => {
		expect(watchdogTimedOutMessage([search], 1, "Apertus 1.5 70B")).toBe(named);
		expect(watchdogTimedOutMessage([search, token], 1, "Apertus 1.5 70B")).toBe(named);
	});
});

describe("watchdogCountsTowardBusy (CUR-4345)", () => {
	const search = { type: MessageUpdateType.WebSearch } as unknown as MessageUpdate;
	const silentTurn = {
		updates: [search],
		generationUpdatesFrom: 1,
		firstTokenAt: undefined,
		faultInjected: false,
		isAgentTurn: false,
		isLocalModel: false,
	};

	it("counts a watchdog-ended turn whose model sent no token after its call began, so SEA-LION and ALIA outages reach the busy mark", () => {
		expect(watchdogCountsTowardBusy(silentTurn)).toBe(true);
	});

	it("does not count a model that had started answering, since a slow answer is not a busy model", () => {
		expect(watchdogCountsTowardBusy({ ...silentTurn, firstTokenAt: new Date() })).toBe(false);
	});

	it("does not count a stall in our own tool step or in retrieval (CUR-4107), which is not the model's", () => {
		expect(watchdogCountsTowardBusy({ ...silentTurn, updates: [search], generationUpdatesFrom: 0 })).toBe(false);
		expect(watchdogCountsTowardBusy({ ...silentTurn, generationUpdatesFrom: undefined })).toBe(false);
	});

	it("never counts a turn with an injected fault, since the mark is shared by everyone on the deployment", () => {
		expect(watchdogCountsTowardBusy({ ...silentTurn, faultInjected: true })).toBe(false);
	});

	it("never counts the agent or a visitor's local model, which Auto does not route to", () => {
		expect(watchdogCountsTowardBusy({ ...silentTurn, isAgentTurn: true })).toBe(false);
		expect(watchdogCountsTowardBusy({ ...silentTurn, isLocalModel: true })).toBe(false);
	});
});

describe("the e2e grade's reading of these sentences (SOL-277)", () => {
	it("counts the named sentence as a model that never answered", async () => {
		const { namesASilentModel } = await import("../../../../../e2e/scenarios/helpers/upstreamAdvisory");
		const named = upstreamSilentMessage(new NoFirstChunkError("no first chunk"), "Apertus 1.5 70B");
		expect(namesASilentModel(`Alpha\n${named}\nRetry`)).toBe(true);
	});

	it("never counts the generic sentence, which means our own step stalled (CUR-4107)", async () => {
		const { namesASilentModel } = await import("../../../../../e2e/scenarios/helpers/upstreamAdvisory");
		const search = { type: MessageUpdateType.WebSearch } as unknown as MessageUpdate;
		expect(namesASilentModel(watchdogTimedOutMessage([search], 0, "Apertus 1.5 70B"))).toBe(false);
	});
});
