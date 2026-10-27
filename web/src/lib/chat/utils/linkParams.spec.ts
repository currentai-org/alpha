import { describe, expect, it } from "vitest";
import { linkPromptNeedsConfirmation, readLinkPromptRequest } from "./linkParams";

const read = (query: string) => readLinkPromptRequest(new URLSearchParams(query));

describe("readLinkPromptRequest", () => {
	it("returns null when the link carries nothing for the composer", () => {
		expect(read("")).toBeNull();
		expect(read("q=%20%20&attachments=javascript:alert(1)")).toBeNull();
	});

	it("reads q as a send and lets it win over prompt", () => {
		expect(read("q=hello&prompt=other")).toMatchObject({ prompt: "hello", send: true });
		expect(read("prompt=draft me")).toMatchObject({ prompt: "draft me", send: false });
	});

	it("keeps only absolute http(s) attachments without credentials, deduplicated, in link order", () => {
		const request = read(
			"attachments=https://b.example/2,https://a.example/1&attachments=https://b.example/2" +
				"&attachments=https://user:pw@evil.example/x,file:///etc/passwd,/relative"
		);
		expect(request?.attachmentUrls.map((u) => u.href)).toEqual([
			"https://b.example/2",
			"https://a.example/1",
		]);
	});
});

describe("linkPromptNeedsConfirmation", () => {
	it("asks before sending a q prompt, even with no attachments", () => {
		expect(linkPromptNeedsConfirmation(read("q=hello")!)).toBe(true);
	});

	it("asks before fetching any attachment, since no attachment source is trusted", () => {
		expect(linkPromptNeedsConfirmation(read("prompt=hi&attachments=https://a.example/1")!)).toBe(
			true
		);
	});

	it("lets a prompt-only link through: it fills the composer and the visitor still presses send", () => {
		expect(linkPromptNeedsConfirmation(read("prompt=hi")!)).toBe(false);
	});
});
