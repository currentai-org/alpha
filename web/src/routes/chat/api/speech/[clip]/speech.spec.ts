// Every fetch of a read-aloud clip is a billed synthesis, so a clip plays only for the owner
// of the conversation it was sealed in. A copied URL in anyone else's hands is a 404 that never reaches
// the speech provider. (CUR-3151)
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ObjectId } from "bson";

vi.mock("$lib/chat/server/config", () => ({ config: { BETTER_AUTH_SECRET: "test-secret-for-sealing-clips" } }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// The real condition is "this user's or this guest session's conversations"; the stand-in keeps that
// shape so the route's own filter is what decides.
vi.mock("$lib/chat/server/auth", () => ({
	authCondition: (locals: App.Locals) =>
		locals.user ? { userId: locals.user._id } : { sessionId: locals.sessionId },
}));
const { owner, countDocuments } = vi.hoisted(() => {
	const owner = { conversation: "", sessionId: "owner-session" };
	return {
		owner,
		countDocuments: vi.fn(async (filter: { _id: { toString(): string }; sessionId?: string }) =>
			filter._id.toString() === owner.conversation && filter.sessionId === owner.sessionId ? 1 : 0
		),
	};
});
vi.mock("$lib/chat/server/database", () => ({ collections: { conversations: { countDocuments } } }));
const { rateLimit } = vi.hoisted(() => ({ rateLimit: vi.fn() }));
vi.mock("$lib/chat/server/chat/rateLimit", () => ({ enforceRequestRateLimits: rateLimit }));
const { synthesize } = vi.hoisted(() => ({ synthesize: vi.fn() }));
vi.mock("$lib/chat/server/mcp/readAloudSpeech", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/mcp/readAloudSpeech")>()),
	synthesizeSpeech: synthesize,
}));

const { fault } = vi.hoisted(() => ({ fault: vi.fn() }));
vi.mock("$lib/chat/server/textGeneration/faultInjection", () => ({ resolveFaultInjection: fault }));
vi.mock("$lib/chat/server/mcp", () => ({ CANNED_READ_ALOUD_CLIP: "/e2e/canned-read-aloud.wav" }));

import { GET } from "./+server";
import { speechClipUrl } from "$lib/chat/server/mcp/readAloudSpeech";
import { logger } from "$lib/chat/server/logger";

const guest = (sessionId: string) => ({ sessionId, user: undefined }) as unknown as App.Locals;
const fetchClip = (segment: string, locals: App.Locals) =>
	GET({
		params: { clip: segment },
		locals,
		getClientAddress: () => "203.0.113.7",
		request: new Request("https://preview.test/chat/api/speech/x.mp3"),
	} as unknown as Parameters<typeof GET>[0]);

beforeEach(() => {
	owner.conversation = new ObjectId().toString();
	synthesize.mockReset().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
	rateLimit.mockReset().mockResolvedValue(undefined);
	fault.mockReset().mockResolvedValue(null);
});

const segmentFor = (conversation: string) =>
	speechClipUrl({ text: "Le pain est dans le four.", language: "fr", conversation }).split("/").pop()!;

describe("speech route — a clip plays only for its conversation's owner (CUR-3151)", () => {
	it("synthesizes the clip for the guest session that owns the conversation", async () => {
		const res = await fetchClip(segmentFor(owner.conversation), guest(owner.sessionId));

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
		expect(synthesize).toHaveBeenCalledTimes(1);
	});

	it("answers 404 and bills nothing when someone else fetches a copied clip URL", async () => {
		await expect(fetchClip(segmentFor(owner.conversation), guest("someone-else"))).rejects.toMatchObject({
			status: 404,
		});
		expect(synthesize).not.toHaveBeenCalled();
		expect(rateLimit).not.toHaveBeenCalled();
	});

	it("answers 404 and bills nothing for a segment this server did not seal", async () => {
		await expect(fetchClip("not-a-sealed-clip.mp3", guest(owner.sessionId))).rejects.toMatchObject({
			status: 404,
		});
		expect(synthesize).not.toHaveBeenCalled();
		expect(rateLimit).not.toHaveBeenCalled();
	});
});

describe("speech route — each synthesis counts against the chat limiter (CUR-3519)", () => {
	it("keys the limiter on the owner's session and address before synthesizing", async () => {
		await fetchClip(segmentFor(owner.conversation), guest(owner.sessionId));
		expect(rateLimit).toHaveBeenCalledWith({ userId: owner.sessionId, clientAddress: "203.0.113.7" });
		expect(rateLimit.mock.invocationCallOrder[0]).toBeLessThan(synthesize.mock.invocationCallOrder[0]);
	});

	it("passes the limiter's 429 to the owner and never reaches the speech provider", async () => {
		rateLimit.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
		await expect(fetchClip(segmentFor(owner.conversation), guest(owner.sessionId))).rejects.toMatchObject({
			status: 429,
		});
		expect(synthesize).not.toHaveBeenCalled();
	});
});

describe("speech route — the canned clip stands in for synthesis under the e2e fault (CUR-4085)", () => {
	it("redirects to the canned clip and never reaches the speech provider under tts_canned_clip", async () => {
		fault.mockResolvedValue("tts_canned_clip");
		await expect(fetchClip(segmentFor(owner.conversation), guest(owner.sessionId))).rejects.toMatchObject({
			status: 302,
			location: "/e2e/canned-read-aloud.wav",
		});
		expect(synthesize).not.toHaveBeenCalled();
	});

	it("still answers 404 for someone else's clip under the fault, so it opens nothing new", async () => {
		fault.mockResolvedValue("tts_canned_clip");
		await expect(fetchClip(segmentFor(owner.conversation), guest("someone-else"))).rejects.toMatchObject({
			status: 404,
		});
	});
});

describe("speech route — the synthesis log names the voice that read the clip (CUR-3989)", () => {
	it("logs ff_siwis beside language fr when a French clip is synthesized", async () => {
		vi.mocked(logger.info).mockClear();
		await fetchClip(segmentFor(owner.conversation), guest(owner.sessionId));
		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({ language: "fr", voice: "ff_siwis" }),
			"[read-aloud] clip synthesized"
		);
	});
});
