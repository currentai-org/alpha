import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { agentRunFiles } from "./agentAttachments";
import type { EndpointMessage } from "../types";

async function png(width: number, height: number): Promise<string> {
	const buf = await sharp({ create: { width, height, channels: 3, background: { r: 16, g: 64, b: 208 } } })
		.png()
		.toBuffer();
	return buf.toString("base64");
}

const user = (files: EndpointMessage["files"], content = "q"): EndpointMessage =>
	({ from: "user", content, files }) as EndpointMessage;

describe("agentRunFiles: the conversation's photos for an agent run", () => {
	it("sends an attached photo whole, under the person's name, with a model-sized rendition", async () => {
		const data = await png(2048, 1536);
		const [file, ...rest] = await agentRunFiles([
			user([{ type: "base64", value: data, mime: "image/png", name: "shapes.png" }]),
		]);
		expect(rest).toEqual([]);
		expect(file).toMatchObject({ name: "shapes.png", mime: "image/png", data });
		expect(file.image?.mime).toMatch(/^image\/(jpeg|png)$/);
		const meta = await sharp(Buffer.from(file.image!.data, "base64")).metadata();
		expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1024);
	});

	it("sends each photo once, from every user turn, and nothing from the assistant's or a document", async () => {
		const a = await png(8, 8);
		const b = await png(9, 9);
		const files = await agentRunFiles([
			user([{ type: "base64", value: a, mime: "image/png", name: "a.png" }]),
			{ from: "assistant", content: "x", files: [{ type: "base64", value: b, mime: "image/png", name: "gen.png" }] } as EndpointMessage,
			user([
				{ type: "base64", value: a, mime: "image/png", name: "a.png" },
				{ type: "base64", value: b, mime: "image/png", name: "b.png" },
				{ type: "base64", value: "JVBERi0=", mime: "application/pdf", name: "doc.pdf" },
			]),
		]);
		expect(files.map((f) => f.name)).toEqual(["a.png", "b.png"]);
	});

	it("sends a turn with no photos no files", async () => {
		expect(await agentRunFiles([user(undefined)])).toEqual([]);
	});
});
