import { describe, it, expect, vi, beforeEach } from "vitest";
import { StorageQuotaExceededError } from "$lib/chat/server/storage/custodialStorage";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Conversation } from "$lib/chat/types/Conversation";

// Holders shared with the mock factories (hoisted above imports). MULTIMODAL_ENABLED and the
// file-size cap are named-import bindings, so they're mocked via getters to stay flippable per test.
const {
	uploadFile,
	usageLimitsMock,
	multimodal,
	fileSize,
	scanCsamHash,
	scanner,
	recordCsamMatch,
	reportCsamMatchToCoop,
	storeChatAttachments,
	resolveFaultInjection,
} = vi.hoisted(() => ({
	resolveFaultInjection: vi.fn(),
	scanner: { configured: true },
	storeChatAttachments: vi.fn(),
	uploadFile: vi.fn(),
	usageLimitsMock: { messageLength: undefined, messages: undefined } as {
		messageLength?: number;
		messages?: number;
	},
	multimodal: { enabled: false },
	fileSize: { bytes: 3_000_000 },
	scanCsamHash: vi.fn(),
	recordCsamMatch: vi.fn(),
	reportCsamMatchToCoop: vi.fn(),
}));

vi.mock("$lib/chat/server/usageLimits", () => ({ usageLimits: usageLimitsMock }));
vi.mock("$lib/chat/server/textOnly", () => ({
	multimodalEnabled: () => multimodal.enabled,
}));
vi.mock("$lib/chat/constants/uploadLimits", async (orig) => ({
	...(await orig<typeof import("$lib/chat/constants/uploadLimits")>()),
	get CHAT_ATTACHMENTS_MAX_BYTES() {
		return fileSize.bytes;
	},
}));
// HmaUnreachableError kept real (not stubbed) — parseRequest.ts checks `instanceof` against it, so
// the test needs to throw the same class the module under test imports.
vi.mock("$lib/chat/server/storage/csamScan", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/chat/server/storage/csamScan")>();
	return { ...actual, scanCsamHash, csamScanConfigured: () => scanner.configured };
});
vi.mock("$lib/chat/server/alerting", () => ({ recordCsamMatch }));
vi.mock("$lib/chat/server/moderation", () => ({ reportCsamMatchToCoop }));
vi.mock("$lib/chat/server/storage/attachmentsToCustodial", async (orig) => ({
	...(await orig<typeof import("$lib/chat/server/storage/attachmentsToCustodial")>()),
	storeChatAttachments,
}));
vi.mock("$lib/chat/server/textGeneration/faultInjection", () => ({ resolveFaultInjection }));
const allowance = vi.hoisted(() => ({ left: vi.fn(), record: vi.fn(), enforced: true }));
vi.mock("$lib/chat/server/db/ipHash", () => ({ hashIp: (ip: string) => `hash:${ip}` }));
vi.mock("$lib/chat/server/db/attachmentAllowance", async (orig) => ({
	...(await orig<typeof import("$lib/chat/server/db/attachmentAllowance")>()),
	attachmentAllowanceLeft: allowance.left,
	recordAttachments: allowance.record,
	attachmentAllowanceEnforced: () => allowance.enforced,
}));
const signIn = vi.hoisted(() => ({ offered: false }));
vi.mock("$lib/chat/server/oidcConfig", async (orig) => ({
	...(await orig<typeof import("$lib/chat/server/oidcConfig")>()),
	loginEnabled: () => signIn.offered,
}));
const deploy = vi.hoisted(() => ({ env: null as string | null }));
vi.mock("$lib/chat/server/deployEnv", async (orig) => ({
	...(await orig<typeof import("$lib/chat/server/deployEnv")>()),
	deployEnv: () => deploy.env,
}));
const documents = vi.hoisted(() => ({ enabled: true, textOnly: false }));
vi.mock("$lib/chat/server/documentAttachmentsGate", () => ({
	documentAttachmentsEnabled: () => documents.enabled,
	documentTextOnlyEnabled: () => !documents.enabled && documents.textOnly,
}));

import { parseChatRequest } from "./parseRequest";
import { CHAT_ATTACHMENTS_MAX_COUNT } from "$lib/chat/constants/uploadLimits";
import {
	HmaUnreachableError,
	UPLOAD_NOT_SCANNED_MESSAGE,
} from "$lib/chat/server/storage/csamScan";

import {
	DOCUMENTS_NOT_ACCEPTED_MESSAGE,
	UNSCANNABLE_FILE_MESSAGE,
} from "$lib/chat/server/storage/embeddedImageScan";
import { DOCUMENT_TEXT_UNREADABLE_MESSAGE } from "$lib/chat/server/storage/documentTextOnly";
import { FILE_TYPE_NOT_ACCEPTED_MESSAGE } from "$lib/chat/server/chat/attachmentType";

const conv = { _id: "c1" } as unknown as Conversation;

/** A synthetic PDF from fixtures/embedded-images, as the composer posts it: base64 under a
 *  `base64;` name. */
function pdfAttachment(fixture: string, name: string): File {
	const path = fixture.includes("/") ? fixture : `../fixtures/embedded-images/${fixture}`;
	const bytes = readFileSync(fileURLToPath(new URL(path, import.meta.url)));
	return new File([bytes.toString("base64")], `base64;${name}`, { type: "application/pdf" });
}
const GEN_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(data: unknown, files: File[] = []): Request {
	const fd = new FormData();
	fd.set("data", JSON.stringify(data));
	for (const f of files) fd.append("files", f);
	return { formData: async () => fd } as unknown as Request;
}

function makeLocals(): App.Locals {
	return { sessionId: "s1", isAdmin: false } as unknown as App.Locals;
}

beforeEach(() => {
	uploadFile.mockReset().mockResolvedValue({ type: "hash", value: "uploaded-hash" });
	usageLimitsMock.messageLength = undefined;
	usageLimitsMock.messages = undefined;
	multimodal.enabled = false;
	fileSize.bytes = 3_000_000;
	// A configured scanner that finds nothing, unless a test overrides it to exercise the
	// unconfigured/match/unreachable paths (CUR-2382: there is no "skipped" any more).
	scanner.configured = true;
	scanCsamHash.mockReset().mockResolvedValue({ status: "clean" });
	recordCsamMatch.mockReset().mockResolvedValue(undefined);
	reportCsamMatchToCoop.mockReset().mockResolvedValue(undefined);
	// The store, stood in for by one `uploadFile` call per file it is handed, so a test reads which
	// files reached storage from either mock.
	storeChatAttachments
		.mockReset()
		.mockImplementation(async (_conv: Conversation, files: { file: File }[]) =>
			Promise.all(files.map(({ file }) => uploadFile(file)))
		);
	resolveFaultInjection.mockReset().mockResolvedValue(null);
	allowance.left.mockReset().mockResolvedValue(null);
	allowance.record.mockReset().mockResolvedValue(undefined);
	allowance.enforced = true;
	documents.enabled = true;
	documents.textOnly = false;
	signIn.offered = false;
	deploy.env = null;
});

describe("parseChatRequest", () => {
	it("parses the data field into the turn's typed inputs", async () => {
		const req = makeRequest({ inputs: "hello", is_retry: false, generationId: GEN_ID });
		const out = await parseChatRequest({ request: req, conv, locals: makeLocals() });
		expect(out).toMatchObject({
			newPrompt: "hello",
			isRetry: false,
			generationId: GEN_ID,
			uploadedFiles: [],
		});
	});

	it("resolves a request with no web search mode to off, so no path reads it as on (CUR-3293)", async () => {
		const out = await parseChatRequest({ request: makeRequest({ inputs: "hi" }), conv, locals: makeLocals() });
		expect(out.webSearchMode).toBe("off");
		const auto = await parseChatRequest({
			request: makeRequest({ inputs: "hi", webSearchMode: "auto" }),
			conv,
			locals: makeLocals(),
		});
		expect(auto.webSearchMode).toBe("auto");
	});

	it("throws 400 when the data field is missing", async () => {
		const fd = new FormData();
		const req = { formData: async () => fd } as unknown as Request;
		await expect(
			parseChatRequest({ request: req, conv, locals: makeLocals() })
		).rejects.toMatchObject({ status: 400 });
	});

	it("attaches the per-turn MCP selection and timezone to locals", async () => {
		const locals = makeLocals();
		const req = makeRequest({
			inputs: "hi",
			timezone: "Europe/Zurich",
			selectedMcpServerNames: ["fs"],
			selectedMcpServers: [
				{ name: "fs", url: "http://x", headers: [{ key: "Authorization", value: "Bearer t" }] },
			],
		});
		await parseChatRequest({ request: req, conv, locals });
		expect(locals.timezone).toBe("Europe/Zurich");
		expect(locals.mcp).toEqual({
			selectedServerNames: ["fs"],
			selectedServers: [{ name: "fs", url: "http://x", headers: { Authorization: "Bearer t" } }],
		});
	});

	it("throws 415 when an attachment is present while the text-only gate is closed", async () => {
		multimodal.enabled = false;
		const file = new File(["aGVsbG8="], "base64;a.txt", { type: "text/plain" });
		const req = makeRequest({ inputs: "hi" }, [file]);
		await expect(
			parseChatRequest({ request: req, conv, locals: makeLocals() })
		).rejects.toMatchObject({ status: 415 });
	});

	describe("CUR-4400: guests cannot use agent mode, on every deployment", () => {
		it("refuses a guest's agent-mode-on turn with 403 and the sign-in line, even where no sign-in is offered", async () => {
			signIn.offered = false;
			await expect(
				parseChatRequest({ request: makeRequest({ inputs: "hi", agentMode: "on" }), conv, locals: makeLocals() })
			).rejects.toMatchObject({ status: 403, body: { message: "Sign in to use agent mode." } });
		});

		it("refuses a guest's re-attach to an agent task the same way", async () => {
			await expect(
				parseChatRequest({ request: makeRequest({ inputs: "hi", agent_attach: true }), conv, locals: makeLocals() })
			).rejects.toMatchObject({ status: 403, body: { message: "Sign in to use agent mode." } });
		});

		it("leaves a guest's auto or off turn to the router, which keeps it on chat", async () => {
			for (const agentMode of ["auto", "off"] as const) {
				await expect(
					parseChatRequest({ request: makeRequest({ inputs: "hi", agentMode }), conv, locals: makeLocals() })
				).resolves.toMatchObject({ agentMode });
			}
		});

		it("takes a signed-in account's agent-mode-on turn, leaving access to agentModeEnabledForUser", async () => {
			const locals = { ...makeLocals(), user: { _id: "u1" } } as unknown as App.Locals;
			await expect(
				parseChatRequest({ request: makeRequest({ inputs: "hi", agentMode: "on" }), conv, locals })
			).resolves.toMatchObject({ agentMode: "on" });
		});
	});

	describe("guests cannot attach files where sign-in is offered (2026-10-14)", () => {
		const text = () => new File(["aGVsbG8="], "base64;a.txt", { type: "text/plain" });
		const longPaste = () =>
			new File([Buffer.from("x".repeat(4_000)).toString("base64")], "base64;Pasted Content", {
				type: "application/vnd.chatui.clipboard",
			});

		it("refuses a guest's file with 403 and the sign-in line, and stores nothing", async () => {
			multimodal.enabled = true;
			signIn.offered = true;
			await expect(
				parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text()]), conv, locals: makeLocals() })
			).rejects.toMatchObject({ status: 403, body: { message: "Sign in to attach files." } });
			expect(uploadFile).not.toHaveBeenCalled();
		});

		it("takes the same file from a signed-in visitor", async () => {
			multimodal.enabled = true;
			signIn.offered = true;
			const locals = { ...makeLocals(), user: { _id: "u1" } } as unknown as App.Locals;
			await expect(
				parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text()]), conv, locals })
			).resolves.toBeDefined();
		});

		it("still takes a guest's long paste, which is message text, not a file", async () => {
			multimodal.enabled = true;
			signIn.offered = true;
			await expect(
				parseChatRequest({ request: makeRequest({ inputs: "hi" }, [longPaste()]), conv, locals: makeLocals() })
			).resolves.toBeDefined();
		});

		it("CUR-4400: refuses a guest's file on preview or production even with sign-in off", async () => {
			multimodal.enabled = true;
			signIn.offered = false;
			for (const env of ["preview", "production"]) {
				deploy.env = env;
				await expect(
					parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text()]), conv, locals: makeLocals() })
				).rejects.toMatchObject({ status: 403, body: { message: "Sign in to attach files." } });
			}
			expect(uploadFile).not.toHaveBeenCalled();
		});

		it("leaves a guest's file to the other checks only in local dev or CI, which offer no sign-in", async () => {
			multimodal.enabled = true;
			signIn.offered = false;
			await expect(
				parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text()]), conv, locals: makeLocals() })
			).resolves.toBeDefined();
		});
	});

	// A long paste becomes a clipboard-typed file in the composer, and counting it as an
	// attachment would fail every send after one where this gate is shut. (CUR-1895)
	const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
	const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

	it("accepts a long text paste while the attachments gate is closed — a paste is not an attachment", async () => {
		multimodal.enabled = false;
		const paste = new File([b64("A pasted article. ".repeat(300))], "base64;Pasted Content", {
			type: "application/vnd.chatui.clipboard",
		});
		const out = await parseChatRequest({
			request: makeRequest({ inputs: "summarise this" }, [paste]),
			conv,
			locals: makeLocals(),
		});
		expect(out.uploadedFiles).toHaveLength(1);
	});

	it("still refuses an image relabelled as a paste while the gate is closed (bytes are sniffed, not the label)", async () => {
		multimodal.enabled = false;
		const disguised = new File([b64(PNG)], "base64;Pasted Content", {
			type: "application/vnd.chatui.clipboard",
		});
		await expect(
			parseChatRequest({ request: makeRequest({ inputs: "hi" }, [disguised]), conv, locals: makeLocals() })
		).rejects.toMatchObject({ status: 415 });
	});

	it("still refuses a stored-file hash reference labelled as a paste while the gate is closed", async () => {
		multimodal.enabled = false;
		const ref = new File(["deadbeef"], "hash;Pasted Content", { type: "application/vnd.chatui.clipboard" });
		await expect(
			parseChatRequest({ request: makeRequest({ inputs: "hi" }, [ref]), conv, locals: makeLocals() })
		).rejects.toMatchObject({ status: 415 });
	});

	it("throws 400 naming the length, the limit and how much to cut when the prompt exceeds the message-length limit", async () => {
		usageLimitsMock.messageLength = 3;
		const req = makeRequest({ inputs: "way too long" });
		await expect(
			parseChatRequest({ request: req, conv, locals: makeLocals() })
		).rejects.toMatchObject({
			status: 400,
			body: { message: "Message too long: 12 characters, the limit is 3. Cut 9 to send it; your text is still here." },
		});
	});

	it("throws 413 naming the per-message limit when the attachments together exceed it, though each fits alone", async () => {
		multimodal.enabled = true; // get past the text-only gate to reach the size check
		fileSize.bytes = 8; // tiny cap: each 5-byte file fits, the two together (10) do not
		// "aGVsbG8=" decodes to "hello" (5 bytes)
		const a = new File(["aGVsbG8="], "base64;a.txt", { type: "text/plain" });
		const b = new File(["aGVsbG8="], "base64;b.txt", { type: "text/plain" });
		const req = makeRequest({ inputs: "hi" }, [a, b]);
		await expect(
			parseChatRequest({ request: req, conv, locals: makeLocals() })
		).rejects.toMatchObject({ status: 413, body: { message: expect.stringMatching(/per message/) } });
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("throws 413 naming the count, and stores nothing, when a message carries one file over the cap, all of them pastes (CUR-3530)", async () => {
		multimodal.enabled = true;
		const pastes = Array.from(
			{ length: CHAT_ATTACHMENTS_MAX_COUNT + 1 },
			(_, i) => new File([b64(`paste ${i}`)], "base64;Pasted Content", { type: "application/vnd.chatui.clipboard" })
		);
		await expect(
			parseChatRequest({ request: makeRequest({ inputs: "hi" }, pastes), conv, locals: makeLocals() })
		).rejects.toMatchObject({
			status: 413,
			body: { message: expect.stringContaining(`up to ${CHAT_ATTACHMENTS_MAX_COUNT} files`) },
		});
		expect(storeChatAttachments).not.toHaveBeenCalled();
		expect(scanCsamHash).not.toHaveBeenCalled();
	});

	it("accepts a message carrying exactly the file count, pastes included (CUR-3530)", async () => {
		multimodal.enabled = true;
		const pastes = Array.from(
			{ length: CHAT_ATTACHMENTS_MAX_COUNT },
			(_, i) => new File([b64(`paste ${i}`)], "base64;Pasted Content", { type: "application/vnd.chatui.clipboard" })
		);
		const out = await parseChatRequest({ request: makeRequest({ inputs: "hi" }, pastes), conv, locals: makeLocals() });
		expect(out.uploadedFiles).toHaveLength(CHAT_ATTACHMENTS_MAX_COUNT);
	});

	it("uploads base64 files and passes hash references through untouched", async () => {
		multimodal.enabled = true;
		const b64 = new File(["aGVsbG8="], "base64;a.txt", { type: "text/plain" });
		const hash = new File(["deadbeef"], "hash;b.txt", { type: "text/plain" });
		const req = makeRequest({ inputs: "hi" }, [b64, hash]);
		const out = await parseChatRequest({ request: req, conv, locals: makeLocals() });
		expect(uploadFile).toHaveBeenCalledTimes(1); // only the base64 file is uploaded
		expect(out.uploadedFiles).toEqual([
			{ type: "hash", value: "uploaded-hash" }, // the uploaded result
			{ type: "hash", value: "deadbeef", mime: "text/plain", name: "b.txt" }, // pass-through
		]);
		expect(scanCsamHash).not.toHaveBeenCalled(); // no image attachment, nothing to scan
	});

	it("hands the store every fresh attachment with a long paste marked as one, and never a hash reference (CUR-2183)", async () => {
		multimodal.enabled = true;
		const signedIn = { _id: "c1", userId: "u1" } as unknown as Conversation;
		const attached = new File(["aGVsbG8="], "base64;notes.txt", { type: "text/plain" });
		const paste = new File([b64("A pasted article. ".repeat(300))], "base64;Pasted Content", {
			type: "application/vnd.chatui.clipboard",
		});
		const hash = new File(["deadbeef"], "hash;old.txt", { type: "text/plain" });
		await parseChatRequest({
			request: makeRequest({ inputs: "hi" }, [attached, paste, hash]),
			conv: signedIn,
			locals: makeLocals(),
		});
		expect(storeChatAttachments).toHaveBeenCalledTimes(1);
		const [owner, files] = storeChatAttachments.mock.calls[0];
		expect(owner).toBe(signedIn);
		expect((files as { file: File; paste: boolean }[]).map(({ file, paste }) => [file.name, paste])).toEqual([
			["notes.txt", false],
			["Pasted Content", true],
		]);
	});

	it("stores real bytes labelled as a paste as an attachment under their sniffed type, so the reader looks where they are (CUR-2183)", async () => {
		multimodal.enabled = true;
		const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0def46b80000000049454e44ae426082", "hex");
		const labelled = new File([png.toString("base64")], "base64;Pasted Content", { type: "application/vnd.chatui.clipboard" });
		await parseChatRequest({
			request: makeRequest({ inputs: "hi" }, [labelled]),
			conv: { _id: "c1", userId: "u1" } as unknown as Conversation,
			locals: makeLocals(),
		});
		const [, files] = storeChatAttachments.mock.calls[0];
		expect((files as { file: File; paste: boolean }[]).map(({ file, paste }) => [file.type, paste])).toEqual([["image/png", false]]);
	});

	it("throws 422 and never uploads when an image attachment matches a known CSAM hash", async () => {
		multimodal.enabled = true;
		scanCsamHash.mockResolvedValue({
			status: "match",
			bankName: "test-bank",
			bankContentId: 42,
			distance: "0",
		});
		const b64 = "aGVsbG8="; // decoded bytes are irrelevant — the scan result is mocked
		const image = new File([b64], "base64;photo.png", { type: "image/png" });
		const req = makeRequest({ inputs: "hi" }, [image]);
		await expect(
			parseChatRequest({ request: req, conv, locals: makeLocals() })
		).rejects.toMatchObject({ status: 422 });
		expect(uploadFile).not.toHaveBeenCalled();
		expect(recordCsamMatch).toHaveBeenCalledWith(
			"c1",
			{ bankName: "test-bank", bankContentId: 42, distance: "0" },
			"refused"
		);
		expect(reportCsamMatchToCoop).toHaveBeenCalledWith({
			reportedItemId: "c1",
			bankName: "test-bank",
			bankContentId: 42,
			distance: "0",
		});
	});

	it("scans a b64 upload by its real bytes, not its declared Content-Type (CUR-1449) — a PNG labeled application/octet-stream must still reach scanCsamHash", async () => {
		multimodal.enabled = true;
		// A real (if trivial) 1x1 transparent PNG — the bare 8-byte PNG signature
		// alone is NOT enough for file-type's sniffer; it needs a real IHDR chunk too.
		const pngB64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		const disguised = new File([pngB64], "base64;photo.bin", {
			type: "application/octet-stream", // the attacker-controlled, client-declared header
		});
		const req = makeRequest({ inputs: "hi" }, [disguised]);
		await parseChatRequest({ request: req, conv, locals: makeLocals() });
		expect(scanCsamHash).toHaveBeenCalledTimes(1);
	});

	it("scans each picture inside a PDF attachment, and refuses the turn with 422 when one matches (CUR-987)", async () => {
		multimodal.enabled = true;
		scanCsamHash.mockResolvedValue({ status: "match", bankName: "test-bank", bankContentId: 7, distance: "0" });
		await expect(
			parseChatRequest({
				request: makeRequest({ inputs: "summarise this" }, [pdfAttachment("xobject.pdf", "report.pdf")]),
				conv,
				locals: makeLocals(),
			})
		).rejects.toMatchObject({ status: 422 });
		expect(scanCsamHash).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/report\.pdf#1\.png$/));
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("drops a PDF whose picture cannot be decoded, keeps the turn's other files, and says why (CUR-987, fail closed)", async () => {
		multimodal.enabled = true;
		const text = new File(["aGVsbG8="], "base64;notes.txt", { type: "text/plain" });
		const out = await parseChatRequest({
			request: makeRequest({ inputs: "hi" }, [pdfAttachment("jpeg2000.pdf", "scan.pdf"), text]),
			conv,
			locals: makeLocals(),
		});
		expect(out.attachmentNotice).toBe(UNSCANNABLE_FILE_MESSAGE);
		expect(out.leftOutFiles).toEqual([{ name: "scan.pdf", mime: "application/pdf" }]);
		expect(uploadFile).toHaveBeenCalledTimes(1);
		expect(uploadFile.mock.calls[0][0].name).toBe("notes.txt");
	});

	it("drops a PDF over the page limit with the page-limit line, not the picture line, and keeps the turn's other files (CUR-3837)", async () => {
		multimodal.enabled = true;
		const text = new File(["aGVsbG8="], "base64;notes.txt", { type: "text/plain" });
		const out = await parseChatRequest({
			request: makeRequest({ inputs: "hi" }, [
				pdfAttachment("../../../../../e2e/scenarios/fixtures/too-many-pages.pdf", "long.pdf"),
				text,
			]),
			conv,
			locals: makeLocals(),
		});
		expect(out.attachmentNotice).toBe("This PDF has more than 1,000 pages, so it wasn't added.");
		expect(out.leftOutFiles).toEqual([{ name: "long.pdf", mime: "application/pdf" }]);
		expect(scanCsamHash).not.toHaveBeenCalled();
		expect(uploadFile).toHaveBeenCalledTimes(1);
		expect(uploadFile.mock.calls[0][0].name).toBe("notes.txt");
	});

	it("drops a PDF unopened, never stored unscanned, when document-attachments does not select the account (CUR-987)", async () => {
		multimodal.enabled = true;
		documents.enabled = false;
		const text = new File(["aGVsbG8="], "base64;notes.txt", { type: "text/plain" });
		const out = await parseChatRequest({
			request: makeRequest({ inputs: "hi" }, [pdfAttachment("xobject.pdf", "report.pdf"), text]),
			conv,
			locals: makeLocals(),
		});
		expect(out.attachmentNotice).toBe(DOCUMENTS_NOT_ACCEPTED_MESSAGE);
		expect(scanCsamHash).not.toHaveBeenCalled();
		expect(uploadFile).toHaveBeenCalledTimes(1);
		expect(uploadFile.mock.calls[0][0].name).toBe("notes.txt");
	});

	it("stores only the text of a PDF, never its bytes or its picture, under document-text-only (CUR-987)", async () => {
		multimodal.enabled = true;
		documents.enabled = false;
		documents.textOnly = true;
		const out = await parseChatRequest({
			request: makeRequest({ inputs: "summarise this" }, [
				pdfAttachment("../../../../../e2e/scenarios/fixtures/garden-report-bank-image.pdf", "report.pdf"),
			]),
			conv,
			locals: makeLocals(),
		});
		expect(out.attachmentNotice).toBeUndefined();
		// Nothing was opened for pictures: the bank image inside never reached the scanner.
		expect(scanCsamHash).not.toHaveBeenCalled();
		expect(uploadFile).toHaveBeenCalledTimes(1);
		const stored: File = uploadFile.mock.calls[0][0];
		expect(stored.name).toBe("report.pdf.txt");
		expect(stored.type).toBe("text/plain");
		expect(await stored.text()).toBe("Quarterly garden report. The picture below is the figure for this quarter.");
	});

	it("drops a picture-only PDF with its own line under document-text-only, since no text is left to keep (CUR-987)", async () => {
		multimodal.enabled = true;
		documents.enabled = false;
		documents.textOnly = true;
		const text = new File(["aGVsbG8="], "base64;notes.txt", { type: "text/plain" });
		const out = await parseChatRequest({
			request: makeRequest({ inputs: "hi" }, [pdfAttachment("xobject.pdf", "scan.pdf"), text]),
			conv,
			locals: makeLocals(),
		});
		expect(out.attachmentNotice).toBe(DOCUMENT_TEXT_UNREADABLE_MESSAGE);
		expect(scanCsamHash).not.toHaveBeenCalled();
		expect(uploadFile).toHaveBeenCalledTimes(1);
		expect(uploadFile.mock.calls[0][0].name).toBe("notes.txt");
	});

	it("drops every file, stores nothing, and still answers the text when the CSAM scanner is unreachable (CUR-2382)", async () => {
		multimodal.enabled = true;
		scanCsamHash.mockRejectedValue(new HmaUnreachableError(new Error("connect timeout")));
		const image = new File(["aGVsbG8="], "base64;photo.png", { type: "image/png" });
		const text = new File(["aGVsbG8="], "base64;notes.txt", { type: "text/plain" });
		const hash = new File(["deadbeef"], "hash;old.txt", { type: "text/plain" });
		const out = await parseChatRequest({
			request: makeRequest({ inputs: "hi" }, [image, text, hash]),
			conv,
			locals: makeLocals(),
		});
		expect(out.newPrompt).toBe("hi");
		expect(out.attachmentNotice).toBe(UPLOAD_NOT_SCANNED_MESSAGE);
		expect(uploadFile).not.toHaveBeenCalled();
		// Both dropped files are named for the sent message; the stored one is not. (CUR-3405)
		expect(out.leftOutFiles).toEqual([
			{ name: "photo.png", mime: "image/png" },
			{ name: "notes.txt", mime: "text/plain" },
		]);
		// Only the already-stored hash reference survives.
		expect(out.uploadedFiles).toEqual([
			{ type: "hash", value: "deadbeef", mime: "text/plain", name: "old.txt" },
		]);
	});

	it("the csam_scanner_down fault refuses a turn's image as an unreachable scanner does, without calling the scanner (CUR-2382)", async () => {
		multimodal.enabled = true;
		resolveFaultInjection.mockResolvedValue("csam_scanner_down");
		const image = new File(["aGVsbG8="], "base64;photo.png", { type: "image/png" });
		const out = await parseChatRequest({
			request: makeRequest({ inputs: "what is this?" }, [image]),
			conv,
			locals: makeLocals(),
		});
		expect(out.newPrompt).toBe("what is this?");
		expect(out.attachmentNotice).toBe(UPLOAD_NOT_SCANNED_MESSAGE);
		expect(scanCsamHash).not.toHaveBeenCalled();
		expect(uploadFile).not.toHaveBeenCalled();
		expect(out.uploadedFiles).toEqual([]);
	});

	it("refuses every attached file, even text, and never calls the scanner when none is configured (CUR-2382 fail closed)", async () => {
		multimodal.enabled = true;
		scanner.configured = false;
		const image = new File(["aGVsbG8="], "base64;photo.png", { type: "image/png" });
		const text = new File(["aGVsbG8="], "base64;notes.txt", { type: "text/plain" });
		const out = await parseChatRequest({
			request: makeRequest({ inputs: "hi" }, [image, text]),
			conv,
			locals: makeLocals(),
		});
		expect(out.attachmentNotice).toBe(UPLOAD_NOT_SCANNED_MESSAGE);
		expect(out.uploadedFiles).toEqual([]);
		expect(uploadFile).not.toHaveBeenCalled();
		expect(scanCsamHash).not.toHaveBeenCalled();
	});

	it("keeps a long paste as message text when no scanner is configured, with no notice (CUR-1895 still holds under CUR-2382)", async () => {
		scanner.configured = false;
		const paste = new File([b64("A pasted article. ".repeat(300))], "base64;Pasted Content", {
			type: "application/vnd.chatui.clipboard",
		});
		const out = await parseChatRequest({
			request: makeRequest({ inputs: "hi" }, [paste]),
			conv,
			locals: makeLocals(),
		});
		expect(out.attachmentNotice).toBeUndefined();
		expect(uploadFile).toHaveBeenCalledTimes(1);
	});

	describe("the type allowlist: only what the composer offers is stored (CUR-3832)", () => {
		const bytes = (hex: string, name: string, type: string) =>
			new File([Buffer.from(hex, "hex").toString("base64")], `base64;${name}`, { type });

		it("refuses a 7z, an executable and an unknown binary with a line, stores none of them, and keeps the text file", async () => {
			multimodal.enabled = true;
			const text = new File(["aGVsbG8="], "base64;notes.txt", { type: "text/plain" });
			const out = await parseChatRequest({
				request: makeRequest({ inputs: "hi" }, [
					bytes("377abcaf271c000400000000000000000000000000000000", "archive.7z", "application/x-7z-compressed"),
					bytes("4d5a90000300000004000000ffff0000", "setup.exe", "application/x-msdownload"),
					bytes("000102030405060708090a0b0c0d0e0f", "blob.bin", "application/octet-stream"),
					text,
				]),
				conv,
				locals: makeLocals(),
			});
			expect(out.attachmentNotice).toBe(FILE_TYPE_NOT_ACCEPTED_MESSAGE);
			expect(uploadFile.mock.calls.map(([file]) => file.name)).toEqual(["notes.txt"]);
			expect(scanCsamHash).not.toHaveBeenCalled();
		});

		it("refuses a spreadsheet even where documents are on, since only PDF and Word are read", async () => {
			multimodal.enabled = true;
			const xlsx = new File(["aGVsbG8="], "base64;sheet.xlsx", {
				type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			});
			const out = await parseChatRequest({ request: makeRequest({ inputs: "hi" }, [xlsx]), conv, locals: makeLocals() });
			expect(out.attachmentNotice).toBe(FILE_TYPE_NOT_ACCEPTED_MESSAGE);
			expect(uploadFile).not.toHaveBeenCalled();
		});

		it("refuses an SVG and a TIFF, which the composer never sends, so neither is rendered for the picture check", async () => {
			multimodal.enabled = true;
			const svg = new File([b64('<svg xmlns="http://www.w3.org/2000/svg"/>')], "base64;logo.svg", {
				type: "image/svg+xml",
			});
			const out = await parseChatRequest({
				request: makeRequest({ inputs: "hi" }, [svg, bytes("49492a00080000000000", "scan.tiff", "image/tiff")]),
				conv,
				locals: makeLocals(),
			});
			expect(out.attachmentNotice).toBe(FILE_TYPE_NOT_ACCEPTED_MESSAGE);
			expect(uploadFile).not.toHaveBeenCalled();
			expect(scanCsamHash).not.toHaveBeenCalled();
		});

		it("stores a text file under its bare type, so no declared parameter or quote reaches the prompt's wrapper", async () => {
			multimodal.enabled = true;
			const text = new File(["aGVsbG8="], "base64;notes.md", { type: 'text/markdown" onload="x' });
			const out = await parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text]), conv, locals: makeLocals() });
			expect(out.attachmentNotice).toBeUndefined();
			expect(uploadFile.mock.calls.map(([file]) => file.type)).toEqual(["text/plain"]);
		});
	});

	it("sets no notice on a clean scan", async () => {
		multimodal.enabled = true;
		const image = new File(["aGVsbG8="], "base64;photo.png", { type: "image/png" });
		const out = await parseChatRequest({
			request: makeRequest({ inputs: "hi" }, [image]),
			conv,
			locals: makeLocals(),
		});
		expect(out.attachmentNotice).toBeUndefined();
		expect(uploadFile).toHaveBeenCalledTimes(1);
	});

	// The bucket's own failures (throttling, a timeout) never reach here, since
	// storeChatAttachments sends those files to the files table; its spec holds that contract. A
	// signed-in person's full quota does reach here (CUR-3235). (CUR-2183)
	describe("the attachment store, as parseChatRequest calls it (CUR-2183)", () => {
		const text = () => new File(["aGVsbG8="], "base64;notes.txt", { type: "text/plain" });

		it("lets any other store failure through as itself, never as a stored file", async () => {
			multimodal.enabled = true;
			storeChatAttachments.mockRejectedValue(new Error("bucket down"));
			await expect(
				parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text()]), conv, locals: makeLocals() })
			).rejects.toThrow("bucket down");
		});

		it("answers 413 with the My files line when the account is full, so the client drops the file and keeps the text (CUR-3235)", async () => {
			multimodal.enabled = true;
			storeChatAttachments.mockRejectedValue(new StorageQuotaExceededError(250_000_000, 3));
			await expect(
				parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text()]), conv, locals: makeLocals() })
			).rejects.toMatchObject({
				status: 413,
				body: { message: "Your files are full (250 MB). Delete a file in My files to attach this one." },
			});
		});

		describe("the 24-hour attachment allowance (CUR-3235)", () => {
			const guestConv = { _id: "c1", sessionId: "guest-session" } as unknown as Conversation;

			it("answers 413 with the guest allowance line and stores nothing when the guest has no files left", async () => {
				multimodal.enabled = true;
				allowance.left.mockResolvedValue({ files: 0, bytes: 25_000_000, resetsAt: new Date(Date.now() + 2 * 3_600_000) });
				await expect(
					parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text()]), conv: guestConv, locals: makeLocals() })
				).rejects.toMatchObject({
					status: 413,
					body: {
						message:
							"You've attached as many files as a guest can in a day. You can attach more in about 2 hours. Sign in for a larger allowance.",
					},
				});
				expect(allowance.left).toHaveBeenCalledWith({ guestSessionId: "guest-session" });
				expect(storeChatAttachments).not.toHaveBeenCalled();
				expect(allowance.record).not.toHaveBeenCalled();
			});

			it("with the attachment-allowance flag off, stores and counts a file past the allowance instead of refusing it (CUR-3600)", async () => {
				multimodal.enabled = true;
				allowance.enforced = false;
				allowance.left.mockResolvedValue({ files: 0, bytes: 0 });
				await parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text()]), conv: guestConv, locals: makeLocals() });
				expect(storeChatAttachments).toHaveBeenCalledTimes(1);
				expect(allowance.record).toHaveBeenCalledWith({ guestSessionId: "guest-session" }, [5]);
			});

			it("counts a guest by network too, and refuses with the network line when the network ran out (CUR-3600)", async () => {
				multimodal.enabled = true;
				allowance.left.mockResolvedValue({ files: 0, bytes: 0, network: true, resetsAt: new Date(Date.now() + 2 * 3_600_000) });
				await expect(
					parseChatRequest({
						request: makeRequest({ inputs: "hi" }, [text()]),
						conv: guestConv,
						locals: makeLocals(),
						clientAddress: "203.0.113.5",
					})
				).rejects.toMatchObject({
					status: 413,
					body: { message: expect.stringContaining("Too many files have been attached from your network today.") },
				});
				expect(allowance.left).toHaveBeenCalledWith({ guestSessionId: "guest-session", ipHash: "hash:203.0.113.5" });
			});

			it("logs a refusal at send with guest and network, so the network ceiling is set from real refusals (CUR-3600)", async () => {
				const { logger } = await import("$lib/chat/server/logger");
				const info = vi.spyOn(logger, "info");
				multimodal.enabled = true;
				allowance.left.mockResolvedValue({ files: 0, bytes: 0, network: true });
				await expect(
					parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text()]), conv: guestConv, locals: makeLocals() })
				).rejects.toMatchObject({ status: 413 });
				expect(info).toHaveBeenCalledWith({ guest: true, network: true, at: "send" }, "[attachment-allowance] refused");
				info.mockRestore();
			});

			it("counts an account's stored file against the account, once it is stored", async () => {
				multimodal.enabled = true;
				allowance.left.mockResolvedValue({ files: 5, bytes: 1_000 });
				const accountConv = { _id: "c1", userId: "u1" } as unknown as Conversation;
				await parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text()]), conv: accountConv, locals: makeLocals() });
				expect(allowance.left).toHaveBeenCalledWith({ userId: "u1" });
				expect(allowance.record).toHaveBeenCalledWith({ userId: "u1" }, [5]);
			});

			it("lets the file through when the count failed, since the allowance fails open", async () => {
				multimodal.enabled = true;
				await parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text()]), conv: guestConv, locals: makeLocals() });
				expect(storeChatAttachments).toHaveBeenCalledTimes(1);
				expect(allowance.record).toHaveBeenCalledWith({ guestSessionId: "guest-session" }, [5]);
			});
		});

		it("passes the request's fault to the store, so a preview spec can drive each fallback", async () => {
			multimodal.enabled = true;
			resolveFaultInjection.mockResolvedValue("storage_quota_full");
			await parseChatRequest({ request: makeRequest({ inputs: "hi" }, [text()]), conv, locals: makeLocals() });
			expect(storeChatAttachments.mock.calls[0][2]).toEqual({ fault: "storage_quota_full" });
		});
	});
});
