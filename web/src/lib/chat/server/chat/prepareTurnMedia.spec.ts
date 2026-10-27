import { describe, it, expect, vi } from "vitest";
import { ObjectId } from "bson";
import type { Message, MessageFile } from "$lib/chat/types/Message";
import { moderationMarker } from "$lib/chat/messageProvenance";
import { GUARD_CORPUS_CAP, MAX_TURN_IMAGES } from "$lib/chat/server/guardScreenTypes";
import {
	prepareTurnMedia,
	prepareScreenedTurnMedia,
	outputAskerText,
	type PrepareTurnMediaDeps,
} from "./prepareTurnMedia";
import { AttachmentReadError } from "$lib/chat/server/files/downloadFile";

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
const CONV = new ObjectId();

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

type StoreEntry = { mime: string; value: string; name?: string };

/** A fake GridFS-backed downloadFile: sha → hydrated record. Unknown sha throws (404 shape). */
function fakeDownload(store: Record<string, StoreEntry>): PrepareTurnMediaDeps["downloadFile"] {
	return vi.fn(async (sha: string) => {
		const entry = store[sha];
		if (!entry) throw new Error(`File not found: ${sha}`);
		return {
			type: "base64" as const,
			name: entry.name ?? `${CONV.toString()}-${sha}`,
			value: entry.value,
			mime: entry.mime,
		};
	}) as PrepareTurnMediaDeps["downloadFile"];
}

/** A fake sharp that returns a fixed screening buffer, bypassing real image decode. */
const SCREEN_MARKER = Buffer.from("SCREEN-RENDITION");
const fakeSharp = vi.fn(() => ({
	resize: () => ({ jpeg: () => ({ toBuffer: async () => SCREEN_MARKER }) }),
})) as unknown as PrepareTurnMediaDeps["sharpImpl"];

/** A fake sharp whose encode step throws — exercises the image-encode FailedUnit path. */
const throwingSharp = vi.fn(() => ({
	resize: () => ({
		jpeg: () => ({
			toBuffer: async () => {
				throw new Error("sharp boom");
			},
		}),
	}),
})) as unknown as PrepareTurnMediaDeps["sharpImpl"];

const ref = (sha: string): MessageFile => ({ type: "hash", value: sha, mime: "x", name: "ref" });

function userMsg(id: string, content: string, files?: MessageFile[]): Message {
	return { from: "user", id, content, ...(files ? { files } : {}) };
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────────
describe("prepareTurnMedia", () => {
	it("hands every attachment read in one turn the same key store, and a new turn a new one (CUR-4116)", async () => {
		const store = { s1: { mime: "text/plain", value: b64("one") }, s2: { mime: "text/plain", value: b64("two") } };
		const download = fakeDownload(store);
		const msgs = [userMsg("m0", "a", [ref("s1")]), userMsg("m1", "b", [ref("s2")])];
		await prepareTurnMedia(msgs, CONV, { downloadFile: download, sharpImpl: fakeSharp });
		await prepareTurnMedia(msgs, CONV, { downloadFile: download, sharpImpl: fakeSharp });
		const keys = vi.mocked(download!).mock.calls.map(([, , owner]) => owner?.keys);
		expect(keys).toHaveLength(4);
		expect(keys[0]).toBeDefined();
		expect(keys[1]).toBe(keys[0]);
		expect(keys[3]).toBe(keys[2]);
		expect(keys[2]).not.toBe(keys[0]);
	});

	it("zero-file fast path — no hydration call, corpus is the typed texts, empty message map", async () => {
		const download = fakeDownload({});
		const out = await prepareTurnMedia(
			[userMsg("m0", "first"), { from: "assistant", id: "a0", content: "reply" }, userMsg("m1", "second")],
			CONV,
			{ downloadFile: download, sharpImpl: fakeSharp }
		);

		expect(download).not.toHaveBeenCalled();
		expect(fakeSharp).not.toHaveBeenCalled();
		expect(out.messages.size).toBe(0);
		expect(out.screen.corpus).toBe("first\n\nsecond");
		expect(out.screen.typedTurnText).toBe("second");
		expect(out.screen.images).toEqual([]);
		expect(out.screen.failedUnits).toEqual([]);
		expect(out.droppedImages).toBe(0);
	});

	it("a text file renders a <document> wrapper into finalText and the corpus", async () => {
		// downloadFile names what it returns by storage id (`<conv>-<sha>`); the person's name is on the ref.
		const download = fakeDownload({
			t1: { mime: "text/plain", value: b64("SECRET FILE BODY"), name: "c1-t1" },
		});
		const out = await prepareTurnMedia([userMsg("m1", "hello", [{ ...ref("t1"), name: "notes.txt" }])], CONV, {
			downloadFile: download,
		});

		const fm = out.messages.get("m1")!;
		expect(fm.finalText).toContain('<document name="notes.txt" type="text/plain">');
		expect(fm.finalText).not.toContain("c1-t1");
		expect(fm.finalText).toContain("SECRET FILE BODY");
		// documents precede typed content
		expect(fm.finalText.endsWith("hello")).toBe(true);
		expect(out.screen.corpus).toContain("SECRET FILE BODY");
	});

	it("a clipboard file expands into finalText (before typed) and the corpus", async () => {
		const download = fakeDownload({
			c1: { mime: "application/vnd.chatui.clipboard", value: b64("PASTED CLIPBOARD TEXT") },
		});
		const out = await prepareTurnMedia([userMsg("m1", "typed q", [ref("c1")])], CONV, {
			downloadFile: download,
		});

		const fm = out.messages.get("m1")!;
		expect(fm.finalText).toBe("PASTED CLIPBOARD TEXT\n\ntyped q");
		expect(out.screen.corpus).toContain("PASTED CLIPBOARD TEXT");
	});

	// The agent endpoint keeps this part whole for earlier turns, so it must be finalText's
	// attached part exactly, without the typed words. (CUR-4104)
	it("attachedText is finalText's attached part, without the typed text", async () => {
		const download = fakeDownload({
			c1: { mime: "application/vnd.chatui.clipboard", value: b64("PASTED CLIPBOARD TEXT") },
			f1: { mime: "text/plain", value: b64("FILE BODY") },
		});
		const out = await prepareTurnMedia([userMsg("m1", "typed q", [ref("c1"), ref("f1")])], CONV, {
			downloadFile: download,
		});

		const fm = out.messages.get("m1")!;
		expect(fm.attachedText).toContain("PASTED CLIPBOARD TEXT");
		expect(fm.attachedText).toContain("FILE BODY");
		expect(fm.attachedText).not.toContain("typed q");
		expect(fm.finalText).toBe(`${fm.attachedText}\n\ntyped q`);
	});

	it("corpus-superset invariant — every finalText (and every file-derived byte) is contained in corpus", async () => {
		const download = fakeDownload({
			doc: { mime: "text/plain", value: b64("DOCBODY-ALPHA"), name: "a.txt" },
			clip: { mime: "application/vnd.chatui.clipboard", value: b64("CLIP-BETA") },
			doc2: { mime: "application/json", value: b64("JSONBODY-GAMMA"), name: "b.json" },
		});
		const out = await prepareTurnMedia(
			[
				userMsg("m1", "first turn", [ref("clip"), ref("doc")]),
				userMsg("m2", "second turn", [ref("doc2")]),
			],
			CONV,
			{ downloadFile: download }
		);

		for (const [, fm] of out.messages) {
			expect(out.screen.corpus).toContain(fm.finalText);
		}
		for (const byte of ["DOCBODY-ALPHA", "CLIP-BETA", "JSONBODY-GAMMA"]) {
			expect(out.screen.corpus).toContain(byte);
		}
	});

	it("100k typed prefix + violative file tail — file text truncated so corpus <= cap, no file byte in finalText", async () => {
		const typed = "a".repeat(GUARD_CORPUS_CAP);
		const download = fakeDownload({
			bad: { mime: "text/plain", value: b64("VIOLATIVE PAYLOAD"), name: "evil.txt" },
		});
		const out = await prepareTurnMedia([userMsg("m1", typed, [ref("bad")])], CONV, {
			downloadFile: download,
		});

		expect(out.screen.corpus.length).toBeLessThanOrEqual(GUARD_CORPUS_CAP);
		expect(out.messages.get("m1")!.finalText).toBe(typed);
		expect(out.messages.get("m1")!.finalText).not.toContain("VIOLATIVE PAYLOAD");
		expect(out.screen.corpus).not.toContain("VIOLATIVE PAYLOAD");
		expect(out.truncatedFiles).toHaveLength(1);
		expect(out.truncatedFiles[0].droppedBytes).toBeGreaterThan(0);
	});

	it("a benign 100k prefix + violative clipboard suffix — the suffix is truncated, never sent unscreened", async () => {
		const typed = "b".repeat(GUARD_CORPUS_CAP);
		const download = fakeDownload({
			cb: { mime: "application/vnd.chatui.clipboard", value: b64("CLIPBOARD VIOLATION") },
		});
		const out = await prepareTurnMedia([userMsg("m1", typed, [ref("cb")])], CONV, {
			downloadFile: download,
		});

		expect(out.messages.get("m1")!.finalText).toBe(typed);
		expect(out.screen.corpus).not.toContain("CLIPBOARD VIOLATION");
		expect(out.truncatedFiles).toHaveLength(1);
	});

	// The budget fills newest first, so a second cap-sized paste leaves the first one empty.
	// The model never reads it, and the answer has to say older messages were left out. (CUR-2893)
	it("counts an earlier paste the corpus budget cut as an older message left out", async () => {
		const download = fakeDownload({
			old: { mime: "application/vnd.chatui.clipboard", value: b64("o".repeat(GUARD_CORPUS_CAP)) },
			new: { mime: "application/vnd.chatui.clipboard", value: b64("n".repeat(GUARD_CORPUS_CAP)) },
		});
		const out = await prepareTurnMedia(
			[
				userMsg("m1", "which report?", [ref("old")]),
				{ from: "assistant", id: "a1", content: "First." },
				userMsg("m2", "which report?", [ref("new")]),
			],
			CONV,
			{ downloadFile: download }
		);

		expect(out.messages.get("m1")!.finalText).toBe("which report?");
		expect(out.olderMessagesCut).toBe(1);
	});

	it("does not count the newest message's own oversized paste as an older message left out", async () => {
		const download = fakeDownload({
			big: { mime: "application/vnd.chatui.clipboard", value: b64("x".repeat(GUARD_CORPUS_CAP + 10)) },
		});
		const out = await prepareTurnMedia([userMsg("m1", "q", [ref("big")])], CONV, {
			downloadFile: download,
		});

		expect(out.truncatedFiles).toHaveLength(1);
		expect(out.olderMessagesCut).toBe(0);
	});

	it("an image yields a screenB64 rendition and a caption that is the source message's finalText prefix", async () => {
		const download = fakeDownload({ i1: { mime: "image/png", value: b64("PNGDATA") } });
		const out = await prepareTurnMedia([userMsg("m1", "look at this", [ref("i1")])], CONV, {
			downloadFile: download,
			sharpImpl: fakeSharp,
		});

		expect(out.screen.images).toHaveLength(1);
		const img = out.screen.images[0];
		expect(img.screenB64).toBe(SCREEN_MARKER.toString("base64"));
		expect(img.source.toString("utf-8")).toBe("PNGDATA");
		expect(img.sourceMessageId).toBe("m1");
		expect(img.caption).toBe("look at this");
		// the same occurrence is on the per-message media, not only the screen
		expect(out.messages.get("m1")!.images).toHaveLength(1);
	});

	it("an OLD message's image is captioned with the OLD message's text (incl. its clipboard/file context), not the current turn", async () => {
		const download = fakeDownload({
			oldimg: { mime: "image/png", value: b64("OLDPNG") },
			oldclip: { mime: "application/vnd.chatui.clipboard", value: b64("OLD-CLIP-CTX") },
		});
		const out = await prepareTurnMedia(
			[
				userMsg("m0", "OLD QUESTION", [ref("oldclip"), ref("oldimg")]),
				userMsg("m1", "CURRENT QUESTION"),
			],
			CONV,
			{ downloadFile: download, sharpImpl: fakeSharp }
		);

		expect(out.screen.images).toHaveLength(1);
		const img = out.screen.images[0];
		expect(img.sourceMessageId).toBe("m0");
		expect(img.caption).toContain("OLD-CLIP-CTX");
		expect(img.caption).toContain("OLD QUESTION");
		expect(img.caption).not.toContain("CURRENT QUESTION");
	});

	it("dedupes identical image shas WITHIN one message but keeps cross-message occurrences distinct", async () => {
		const download = fakeDownload({ dup: { mime: "image/png", value: b64("DUP") } });
		const out = await prepareTurnMedia(
			[
				userMsg("m0", "first", [ref("dup"), ref("dup")]), // dedupes to one
				userMsg("m1", "second", [ref("dup")]), // distinct occurrence
			],
			CONV,
			{ downloadFile: download, sharpImpl: fakeSharp }
		);

		expect(out.screen.images).toHaveLength(2);
		expect(out.screen.images.map((i) => i.sourceMessageId).sort()).toEqual(["m0", "m1"]);
	});

	it("image cap — the oldest over-cap occurrence is dropped from BOTH screen and payload, droppedImages counts it", async () => {
		const store: Record<string, StoreEntry> = { old: { mime: "image/png", value: b64("OLD") } };
		const currentRefs: MessageFile[] = [];
		for (let i = 0; i < MAX_TURN_IMAGES; i++) {
			store[`cur${i}`] = { mime: "image/png", value: b64(`CUR${i}`) };
			currentRefs.push(ref(`cur${i}`));
		}
		const download = fakeDownload(store);
		const out = await prepareTurnMedia(
			[userMsg("m0", "old turn", [ref("old")]), userMsg("m1", "current turn", currentRefs)],
			CONV,
			{ downloadFile: download, sharpImpl: fakeSharp }
		);

		expect(out.droppedImages).toBe(1);
		expect(out.screen.images).toHaveLength(MAX_TURN_IMAGES);
		// the dropped one is the oldest (m0), keeping the current turn's set
		expect(out.screen.images.every((i) => i.sourceMessageId === "m1")).toBe(true);
		expect(out.screen.images.some((i) => i.sha === "old")).toBe(false);
		expect(out.messages.get("m0")!.images).toHaveLength(0);
	});

	it("a hydration failure is a file-hydration FailedUnit — the file never reaches finalText", async () => {
		const download = fakeDownload({}); // every sha throws (404)
		const out = await prepareTurnMedia([userMsg("m1", "hi", [ref("missing")])], CONV, {
			downloadFile: download,
		});

		expect(out.screen.failedUnits).toContainEqual({ kind: "file-hydration", sha: "missing" });
		expect(out.messages.get("m1")!.finalText).toBe("hi");
	});

	// A file the bucket could not read is named in the turn's reply rather than left out silently. (CUR-3291)
	it("names a file the bucket could not read in unreadFiles, so the turn can say so", async () => {
		const download = vi.fn(async () => {
			throw new AttachmentReadError("The storage bucket could not be read");
		}) as PrepareTurnMediaDeps["downloadFile"];
		const file = { ...ref("busy"), name: "minutes.pdf" };
		const out = await prepareTurnMedia([userMsg("m1", "summarise this", [file])], CONV, { downloadFile: download });
		expect(out.unreadFiles).toEqual([{ name: "minutes.pdf", reason: "unreadable" }]);
	});

	// The unread file never reaches the model, so there is nothing unscreened. Counting it as
	// a failed unit would make the guard fail child safety closed and decline the turn before the notice. (CUR-3291)
	it("leaves a file the bucket could not read out of failedUnits, so the guard does not decline the turn", async () => {
		const download = vi.fn(async () => {
			throw new AttachmentReadError("The storage bucket could not be read");
		}) as PrepareTurnMediaDeps["downloadFile"];
		const out = await prepareTurnMedia([userMsg("m1", "who is on the rota?", [ref("busy")])], CONV, {
			downloadFile: download,
		});
		expect(out.screen.failedUnits).toEqual([]);
		expect(out.messages.get("m1")!.finalText).toBe("who is on the rota?");
	});

	it("names a missing file only on the latest message, so a file gone from an older one is not repeated every turn", async () => {
		const download = fakeDownload({});
		const out = await prepareTurnMedia(
			[
				userMsg("m1", "first", [{ ...ref("gone"), name: "old.txt" }]),
				userMsg("m2", "second", [{ ...ref("gone2"), name: "new.txt" }]),
			],
			CONV,
			{ downloadFile: download }
		);
		expect(out.unreadFiles).toEqual([{ name: "new.txt", reason: "missing" }]);
	});

	it("an undecodable text file is a text-decode FailedUnit — excluded from finalText", async () => {
		// 0xff is invalid in utf-8; a fatal decoder throws → text-decode unit.
		const invalid = Buffer.from([0xff, 0xfe, 0x80]).toString("base64");
		const download = fakeDownload({ garble: { mime: "text/plain", value: invalid, name: "g.txt" } });
		const out = await prepareTurnMedia([userMsg("m1", "hi", [ref("garble")])], CONV, {
			downloadFile: download,
		});

		expect(out.screen.failedUnits).toContainEqual({ kind: "text-decode", sha: "garble" });
		expect(out.messages.get("m1")!.finalText).toBe("hi");
	});

	it("a sharp failure is an image-encode FailedUnit — the image is excluded from screen and payload", async () => {
		const download = fakeDownload({ i1: { mime: "image/png", value: b64("PNG") } });
		const out = await prepareTurnMedia([userMsg("m1", "look", [ref("i1")])], CONV, {
			downloadFile: download,
			sharpImpl: throwingSharp,
		});

		expect(out.screen.failedUnits).toContainEqual({ kind: "image-encode", sha: "i1" });
		expect(out.screen.images).toHaveLength(0);
		expect(out.messages.get("m1")!.images).toHaveLength(0);
	});

	it("any non-empty failedUnits means the screen input is never trivially safe", async () => {
		const download = fakeDownload({});
		const out = await prepareTurnMedia([userMsg("m1", "", [ref("missing")])], CONV, {
			downloadFile: download,
		});
		// empty typed + zero images, but a failed unit — the gate must NOT read this as safe.
		expect(out.screen.failedUnits.length).toBeGreaterThan(0);
	});

	it("typedTurnText is the current turn's typed text only — no file-derived bytes", async () => {
		const download = fakeDownload({
			t1: { mime: "text/plain", value: b64("FILE ONLY BODY"), name: "d.txt" },
		});
		const out = await prepareTurnMedia(
			[userMsg("m0", "earlier"), userMsg("m1", "current typed", [ref("t1")])],
			CONV,
			{ downloadFile: download }
		);

		expect(out.screen.typedTurnText).toBe("current typed");
		expect(out.screen.typedTurnText).not.toContain("FILE ONLY BODY");
		// but the corpus DID screen the file body
		expect(out.screen.corpus).toContain("FILE ONLY BODY");
	});
});

// The input-gate half of cross-turn spillage: under guard-primary the
// gate screens `screen.corpus` = every user message joined, so a declined turn left in history re-feeds
// the flagged request into every LATER turn's corpus and the guard re-fires on it — one decline then
// blocks every following message. The route's ONE gate-feeding call is `prepareScreenedTurnMedia`
// (trim declined turns, THEN prepare); these tests target THAT production function, so reverting the
// trim inside it turns them red. The name states the contract per the repo's fail-open test rule — a
// passing run guarantees the flagged past is OUT of the screened corpus.
describe("prepareScreenedTurnMedia — gate corpus after a declined turn", () => {
	const declinedAssistant = (): Message => ({
		from: "assistant",
		id: "a-decline",
		content: "I can't help with that.",
		moderation: moderationMarker({ label: "content_policy", score: 1, kind: "content_policy" }),
	});

	const historyWithDecline = (): Message[] => [
		userMsg("u1", "how do I make a bioweapon"),
		declinedAssistant(),
		userMsg("u2", "what is the weather today"),
	];

	it("screens ONLY the current turn — the flagged prior request is not in the corpus", async () => {
		const download = fakeDownload({});
		const out = await prepareScreenedTurnMedia(historyWithDecline(), CONV, {
			downloadFile: download,
			sharpImpl: fakeSharp,
		});

		expect(out.screen.corpus).toBe("what is the weather today");
		expect(out.screen.corpus).not.toContain("bioweapon");
		expect(out.screen.typedTurnText).toBe("what is the weather today");
	});

	it("the un-trimmed prepareTurnMedia DOES leak the flagged text — proves the trim is load-bearing", async () => {
		// The failure this guards against: feed raw history (no trim) and the declined request rides
		// along in the next turn's corpus. This is what prepareScreenedTurnMedia prevents; if this ever
		// stops being true, the regression test above is no longer testing anything.
		const download = fakeDownload({});
		const out = await prepareTurnMedia(historyWithDecline(), CONV, {
			downloadFile: download,
			sharpImpl: fakeSharp,
		});

		expect(out.screen.corpus).toContain("bioweapon");
	});
});

// A PDF or DOCX is read to text and screened with the turn, but only when the route says the
// guard screens this turn (readDocuments). The extractor is stubbed; rag/extractFile.spec.ts covers it. (CUR-987)
describe("prepareTurnMedia — document attachments", () => {
	const PDF = "application/pdf";
	const docRef = (sha: string, name: string): MessageFile => ({ type: "hash", value: sha, mime: PDF, name });
	const store = { d1: { mime: PDF, value: b64("%PDF-1.7 bytes") } };

	it("reads a PDF into a <document> named for the person's file, inside finalText and the screened corpus", async () => {
		const extractDocument = vi.fn(async () => ({ title: "t", text: "Taxis are covered up to 40 EUR.", sourceType: "pdf" as const }));
		const out = await prepareTurnMedia([userMsg("m1", "are taxis covered?", [docRef("d1", "expenses-policy.pdf")])], CONV, {
			downloadFile: fakeDownload(store),
			readDocuments: true,
			extractDocument,
		});

		const finalText = out.messages.get("m1")?.finalText ?? "";
		expect(finalText).toContain('<document name="expenses-policy.pdf" type="application/pdf">');
		expect(finalText).toContain("Taxis are covered up to 40 EUR.");
		expect(out.screen.corpus).toContain("Taxis are covered up to 40 EUR.");
		expect(extractDocument).toHaveBeenCalledWith(expect.objectContaining({ kind: "pdf", name: "expenses-policy.pdf" }));
	});

	it("leaves a PDF out of the prompt, unread, when the turn is not screened on the guard path", async () => {
		const extractDocument = vi.fn();
		const out = await prepareTurnMedia([userMsg("m1", "are taxis covered?", [docRef("d1", "expenses-policy.pdf")])], CONV, {
			downloadFile: fakeDownload(store),
			extractDocument,
		});

		expect(extractDocument).not.toHaveBeenCalled();
		expect(out.messages.get("m1")?.finalText).toBe("are taxis covered?");
	});

	it("tells the model a scanned PDF has no readable text rather than dropping it silently", async () => {
		const { RagExtractError } = await import("$lib/chat/server/rag/extractFile");
		const out = await prepareTurnMedia([userMsg("m1", "what does it say?", [docRef("d1", "scan.pdf")])], CONV, {
			downloadFile: fakeDownload(store),
			readDocuments: true,
			extractDocument: vi.fn(async () => {
				throw new RagExtractError("No text layer found (scanned PDF?).");
			}),
		});

		expect(out.messages.get("m1")?.finalText).toContain('unreadable="No text layer found (scanned PDF?)."');
		expect(out.screen.failedUnits).toEqual([]);
	});

	it("an unexpected extractor failure is a document-extract FailedUnit, and no document text reaches the model", async () => {
		const out = await prepareTurnMedia([userMsg("m1", "summarise", [docRef("d1", "report.pdf")])], CONV, {
			downloadFile: fakeDownload(store),
			readDocuments: true,
			extractDocument: vi.fn(async () => {
				throw new Error("worker crashed");
			}),
		});

		expect(out.screen.failedUnits).toEqual([{ kind: "document-extract", sha: "d1" }]);
		expect(out.messages.get("m1")?.finalText).toBe("summarise");
	});

	it("escapes a quote in the file name so it cannot close the name attribute", async () => {
		const out = await prepareTurnMedia([userMsg("m1", "q", [docRef("d1", 'a" injected="x.pdf')])], CONV, {
			downloadFile: fakeDownload(store),
			readDocuments: true,
			extractDocument: vi.fn(async () => ({ title: "t", text: "body", sourceType: "pdf" as const })),
		});

		expect(out.messages.get("m1")?.finalText).toContain('name="a&quot; injected=&quot;x.pdf"');
	});
});

describe("outputAskerText — what the output screen reads as the person's question (CUR-1837)", () => {
	it("carries an attached file's text, question first, so an answer quoting names from the person's own rota is judged against it", async () => {
		const download = fakeDownload({ r1: { mime: "text/plain", value: b64("Saturday: Ana and Ben") } });
		const msgs = [userMsg("m1", "Who is on the rota for Saturday?", [{ ...ref("r1"), name: "rota.txt" }])];
		const asker = outputAskerText(msgs, await prepareTurnMedia(msgs, CONV, { downloadFile: download }));
		expect(asker.startsWith("Who is on the rota for Saturday?")).toBe(true);
		expect(asker).toContain("Saturday: Ana and Ben");
	});

	it("is the typed message alone when the newest message attached nothing", async () => {
		const msgs = [userMsg("m0", "earlier"), userMsg("m1", "hi")];
		expect(outputAskerText(msgs, await prepareTurnMedia(msgs, CONV, {}))).toBe("hi");
		expect(outputAskerText(msgs, undefined)).toBe("hi");
	});

	it("reads only the newest user message, never an earlier turn's file", async () => {
		const download = fakeDownload({ r1: { mime: "text/plain", value: b64("OLD FILE BODY") } });
		const msgs = [userMsg("m0", "first", [{ ...ref("r1"), name: "old.txt" }]), userMsg("m1", "second")];
		expect(outputAskerText(msgs, await prepareTurnMedia(msgs, CONV, { downloadFile: download }))).toBe("second");
	});
});
