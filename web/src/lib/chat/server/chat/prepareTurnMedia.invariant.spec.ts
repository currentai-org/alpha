import { describe, it, expect, vi } from "vitest";
import { ObjectId } from "bson";
import type { Message, MessageFile } from "$lib/chat/types/Message";
import { CLIPBOARD_MIME } from "$lib/chat/constants/mime";
import { MAX_TURN_IMAGES, type FailedUnit } from "$lib/chat/server/guardScreenTypes";
import { AttachmentReadError } from "$lib/chat/server/files/downloadFile";
import { RagExtractError } from "$lib/chat/server/rag/extractFile";
import { prepareTurnMedia, type PrepareTurnMediaDeps } from "./prepareTurnMedia";

// The safety contract of the shared media step, checked over generated turns rather than one
// fixture per path. The guard screens `screen`; the model gets `messages` (or a message's raw content
// when it carried no files). Whatever a change to a failure branch does, these hold:
//
//   1. Everything the model receives was screened: each finalText sits inside the corpus, and each
//      payload image is a screened image with a screening rendition.
//   2. A file is exempt from failedUnits only when none of it reaches the model. A failed unit fails
//      exactly which outcomes may do it (a bucket read error is one of them, CUR-3291).
//   3. No file vanishes without a trace: each one is in the prompt, a failed unit, a named unread
//      file, or an image over the cap. The one exception is a mime the prompt does not carry, which
//      is logged and dropped, and parseRequest refuses at upload.

type Outcome =
	| "text"
	| "clipboard"
	| "pdf"
	| "pdf-scanned"
	| "pdf-crash"
	| "garbled"
	| "image"
	| "image-bad"
	| "unreadable"
	| "missing"
	| "unsupported";

const OUTCOMES: Outcome[] = [
	"text",
	"clipboard",
	"pdf",
	"pdf-scanned",
	"pdf-crash",
	"garbled",
	"image",
	"image-bad",
	"unreadable",
	"missing",
	"unsupported",
];

type PlannedFile = { sha: string; outcome: Outcome; name: string };
type PlannedMessage = { id: string; typed: string; files: PlannedFile[] };

const CONV = new ObjectId();
const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
/** The bytes a file carries, so a leak is findable by substring. */
const marker = (f: PlannedFile) => `BODY-${f.outcome}-${f.sha}`;

/** mulberry32: a seeded generator, so a red case reprints the seed that made it. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function planTurn(seed: number): PlannedMessage[] {
	const r = rng(seed);
	let n = 0;
	const messageCount = 1 + Math.floor(r() * 3);
	return Array.from({ length: messageCount }, (_, i) => ({
		id: `m${i}`,
		typed: `typed-${seed}-${i}`,
		files: Array.from({ length: Math.floor(r() * 5) }, () => {
			const outcome = OUTCOMES[Math.floor(r() * OUTCOMES.length)];
			const sha = `s${seed}x${n++}`;
			return { sha, outcome, name: `${outcome}-${sha}.f` };
		}),
	}));
}

function depsFor(plan: PlannedMessage[]): PrepareTurnMediaDeps {
	const bySha = new Map(plan.flatMap((m) => m.files).map((f) => [f.sha, f]));
	const downloadFile = vi.fn(async (sha: string) => {
		const f = bySha.get(sha)!;
		const record = (mime: string, value: string) => ({
			type: "base64" as const,
			name: `${CONV.toString()}-${sha}`,
			mime,
			value,
		});
		switch (f.outcome) {
			case "unreadable":
				throw new AttachmentReadError("The storage bucket could not be read");
			case "missing":
				throw new Error(`File not found: ${sha}`);
			case "text":
				return record("text/plain", b64(marker(f)));
			case "clipboard":
				return record(CLIPBOARD_MIME, b64(marker(f)));
			case "garbled":
				return record("text/plain", Buffer.from([0xff, 0xfe, 0x80]).toString("base64"));
			case "image":
			case "image-bad":
				return record("image/png", b64(marker(f)));
			case "unsupported":
				return record("application/zip", b64(marker(f)));
			default:
				return record("application/pdf", b64(marker(f)));
		}
	}) as PrepareTurnMediaDeps["downloadFile"];

	const extractDocument = vi.fn(async ({ bytes }: { bytes: Buffer }) => {
		const body = bytes.toString("utf-8");
		if (body.startsWith("BODY-pdf-scanned-")) throw new RagExtractError("No text layer found (scanned PDF?).");
		if (body.startsWith("BODY-pdf-crash-")) throw new Error("worker crashed");
		return { title: "t", text: body, sourceType: "pdf" as const };
	}) as unknown as PrepareTurnMediaDeps["extractDocument"];

	const sharpImpl = vi.fn((source: Buffer) => ({
		resize: () => ({
			jpeg: () => ({
				toBuffer: async () => {
					if (source.toString("utf-8").startsWith("BODY-image-bad-")) throw new Error("sharp boom");
					return Buffer.from(`SCREEN-${source.toString("utf-8")}`);
				},
			}),
		}),
	})) as unknown as PrepareTurnMediaDeps["sharpImpl"];

	return { downloadFile, extractDocument, sharpImpl, readDocuments: true };
}

const toMessages = (plan: PlannedMessage[]): Message[] =>
	plan.flatMap((m, i): Message[] => {
		const files: MessageFile[] = m.files.map((f) => ({ type: "hash", value: f.sha, mime: "x", name: f.name }));
		const user: Message = { from: "user", id: m.id, content: m.typed, ...(files.length ? { files } : {}) };
		return i < plan.length - 1 ? [user, { from: "assistant", id: `a${i}`, content: `reply-${i}` }] : [user];
	});

async function checkTurn(seed: number) {
	const plan = planTurn(seed);
	const out = await prepareTurnMedia(toMessages(plan), CONV, depsFor(plan));
	const why = (s: string) => `seed ${seed}: ${s}\nplan ${JSON.stringify(plan)}`;

	// What the model receives, per message: finalText for a message with files, raw content otherwise.
	const sent = plan.map((m) => ({
		plan: m,
		text: out.messages.get(m.id)?.finalText ?? m.typed,
		images: out.messages.get(m.id)?.images ?? [],
	}));

	// 1. Everything sent was screened.
	for (const s of sent) {
		expect(out.screen.corpus, why(`${s.plan.id}'s prompt text is not inside the screened corpus`)).toContain(
			s.text
		);
		for (const img of s.images) {
			const screened = out.screen.images.find((x) => x.sha === img.sha && x.sourceMessageId === s.plan.id);
			expect(screened?.screenB64, why(`image ${img.sha} goes to the model unscreened`)).toBeTruthy();
		}
	}

	// 2. failedUnits is exactly the files that could not be read and might otherwise have reached the
	// model. An image over the cap never reaches the encoder, so it cannot fail there.
	const files = plan.flatMap((m) => m.files.map((f) => ({ m, f })));
	const imageFiles = files.filter(({ f }) => f.outcome === "image" || f.outcome === "image-bad");
	expect(out.droppedImages, why("the image cap dropped the wrong count")).toBe(
		Math.max(0, imageFiles.length - MAX_TURN_IMAGES)
	);
	// The cap keeps the newest occurrences, so the dropped ones are the oldest in prompt order.
	const overCap = new Set(imageFiles.slice(0, out.droppedImages).map(({ f }) => f.sha));
	const expectedUnits: FailedUnit[] = files.flatMap(({ f }): FailedUnit[] => {
		if (f.outcome === "missing") return [{ kind: "file-hydration", sha: f.sha }];
		if (f.outcome === "garbled") return [{ kind: "text-decode", sha: f.sha }];
		if (f.outcome === "pdf-crash") return [{ kind: "document-extract", sha: f.sha }];
		if (f.outcome === "image-bad" && !overCap.has(f.sha)) return [{ kind: "image-encode", sha: f.sha }];
		return [];
	});
	const byKey = (u: FailedUnit) => `${u.kind}:${u.sha}`;
	expect(out.screen.failedUnits.map(byKey).sort(), why("failedUnits differ from the files that failed")).toEqual(
		expectedUnits.map(byKey).sort()
	);

	// 3. Every file is accounted for, and a file exempt from failedUnits sends none of its bytes.
	const latest = plan.at(-1)!;
	const allSent = sent.map((s) => s.text).join("\n");
	for (const { m, f } of files) {
		const own = sent.find((s) => s.plan === m)!;
		switch (f.outcome) {
			case "text":
			case "clipboard":
			case "pdf":
				expect(own.text, why(`${f.name} is missing from its message`)).toContain(marker(f));
				break;
			case "pdf-scanned":
				expect(own.text, why(`${f.name} is not named as unreadable`)).toContain(`name="${f.name}"`);
				expect(own.text).toContain('unreadable="No text layer found');
				break;
			case "image":
				if (!overCap.has(f.sha)) {
					expect(own.images.map((i) => i.sha), why(`${f.name} was dropped under the cap`)).toContain(f.sha);
				}
				break;
			case "unreadable":
				expect(out.unreadFiles, why(`${f.name} is unread and not named`)).toContainEqual({
					name: f.name,
					reason: "unreadable",
				});
				break;
			case "missing":
				if (m === latest) {
					expect(out.unreadFiles, why(`${f.name} is missing and not named`)).toContainEqual({
						name: f.name,
						reason: "missing",
					});
				}
				break;
		}
		if (["unreadable", "unsupported", "garbled", "pdf-crash", "missing"].includes(f.outcome)) {
			expect(allSent, why(`${f.name} could not be read but its bytes reached the model`)).not.toContain(
				marker(f)
			);
		}
		if (f.outcome === "image-bad" || overCap.has(f.sha)) {
			expect(
				sent.flatMap((s) => s.images.map((i) => i.sha)),
				why(`${f.name} reached the model without a screened rendition`)
			).not.toContain(f.sha);
		}
	}
	expect(out.unreadFiles.length, why("unreadFiles names a file that was read")).toBe(
		files.filter(({ m, f }) => f.outcome === "unreadable" || (f.outcome === "missing" && m === latest)).length
	);
}

describe("prepareTurnMedia safety invariant", () => {
	it("every single outcome, in an older message and the latest: nothing reaches the model unscreened, and a file leaves failedUnits only when none of it is sent", async () => {
		for (const outcome of OUTCOMES) {
			for (const older of [false, true]) {
				const f: PlannedFile = { sha: `one-${outcome}-${older}`, outcome, name: `${outcome}.f` };
				const plan: PlannedMessage[] = older
					? [
							{ id: "m0", typed: "older", files: [f] },
							{ id: "m1", typed: "latest", files: [] },
						]
					: [{ id: "m0", typed: "latest", files: [f] }];
				const out = await prepareTurnMedia(toMessages(plan), CONV, depsFor(plan));
				const sentText = out.messages.get("m0")?.finalText ?? "";
				expect(out.screen.corpus, `${outcome} (older=${older})`).toContain(sentText);
				const failed = out.screen.failedUnits.some((u) => u.sha === f.sha);
				const leaked = sentText.includes(marker(f)) || (out.messages.get("m0")?.images.length ?? 0) > 0;
				// A failed unit and a sent byte never belong to the same file; an exempt file that sent
				// nothing must still be named or be one of the outcomes the prompt carries as text.
				expect(failed && leaked, `${outcome} (older=${older}) failed and was still sent`).toBe(false);
			}
		}
	});

	it("over 500 generated turns mixing every outcome: everything sent is screened, failedUnits is exactly the failed files, and no file is lost silently", async () => {
		for (let seed = 1; seed <= 500; seed++) await checkTurn(seed);
	});
});
