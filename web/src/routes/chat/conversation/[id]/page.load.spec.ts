import { afterEach, describe, expect, it, vi } from "vitest";
import { isHttpError, isRedirect } from "@sveltejs/kit";
import { get } from "svelte/store";
import superjson from "superjson";

const env = vi.hoisted(() => ({ browser: false }));
vi.mock("$app/environment", () => ({
	get browser() {
		return env.browser;
	},
	building: false,
	dev: false,
	version: "test",
}));

import { load } from "./+page";
import { ERROR_MESSAGES, error } from "$lib/chat/stores/errors";

type LoadEvent = Parameters<typeof load>[0];

function answering(status: number) {
	return vi.fn(async () => new Response(JSON.stringify({ message: "x" }), { status }));
}

async function opening(id: string, fetch: typeof globalThis.fetch): Promise<unknown> {
	const event = {
		params: { id },
		depends: () => {},
		fetch,
		url: new URL(`http://localhost:5173/chat/conversation/${id}`),
		parent: async () => ({}),
	} as unknown as LoadEvent;
	try {
		await load(event);
	} catch (thrown) {
		return thrown;
	}
	return undefined;
}

afterEach(() => {
	env.browser = false;
	error.set(undefined);
	vi.unstubAllGlobals();
});

describe("conversation page load when the chat can't be opened (CUR-2821)", () => {
	it("sends a cut-off id's 400 to the chat home with the unavailable note, like a 404", async () => {
		const thrown = await opening("66f1c2a9b3e4", answering(400));
		expect(isRedirect(thrown) && thrown.location).toMatch(/\/\?unavailable=1$/);
	});

	it("in the browser, sets the unavailable note and redirects to the chat home for a 400", async () => {
		env.browser = true;
		vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
		const thrown = await opening("66f1c2a9b3e4", answering(400));
		expect(isRedirect(thrown) && thrown.location).toMatch(/\/$/);
		expect(get(error)).toBe(ERROR_MESSAGES.conversationUnavailable);
	});

	it("keeps the visitor on the link with a couldn't-open message for a 500, never a silent redirect", async () => {
		const thrown = await opening("66f1c2a9b3e4a5b6c7d8e9f0", answering(500));
		expect(isRedirect(thrown)).toBe(false);
		expect(isHttpError(thrown) && thrown.status).toBe(503);
		expect(isHttpError(thrown) && thrown.body.message).toBe(ERROR_MESSAGES.conversationCouldNotOpen);
	});
});

describe("conversation page load when the chat on screen reloads with no connection (CUR-2805)", () => {
	const ID = "66f1c2a9b3e4a5b6c7d8e9f1";
	const conversation = { id: ID, title: "Glaciers", messages: [], model: "m", modelId: "m", shared: false };
	const serving = vi.fn(async () => new Response(superjson.stringify(conversation), { status: 200 }));
	const offline = vi.fn(async () => {
		throw new TypeError("Failed to fetch");
	});

	async function loading(id: string, fetch: typeof globalThis.fetch): Promise<unknown> {
		const event = {
			params: { id },
			depends: () => {},
			fetch,
			url: new URL(`http://localhost:5173/chat/conversation/${id}`),
			parent: async () => ({}),
		} as unknown as LoadEvent;
		try {
			return await load(event);
		} catch (thrown) {
			return thrown;
		}
	}

	it("keeps the conversation already on screen instead of the couldn't-open page", async () => {
		env.browser = true;
		vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
		expect(await loading(ID, serving)).toMatchObject({ id: ID, title: "Glaciers" });
		expect(await loading(ID, offline)).toMatchObject({ id: ID, title: "Glaciers" });
	});

	it("still shows the couldn't-open page for a different conversation that fails to load", async () => {
		env.browser = true;
		vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
		await loading(ID, serving);
		const thrown = await loading("66f1c2a9b3e4a5b6c7d8e9f2", offline);
		expect(isHttpError(thrown) && thrown.status).toBe(503);
	});

	it("never keeps a conversation on the server, where one module serves every visitor", async () => {
		env.browser = true;
		vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
		await loading(ID, serving);
		env.browser = false;
		const thrown = await loading(ID, offline);
		expect(isHttpError(thrown) && thrown.status).toBe(503);
	});
});
