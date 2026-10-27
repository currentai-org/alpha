import { render, cleanup } from "vitest-browser-svelte";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	addBackgroundGeneration,
	clearBackgroundGenerations,
} from "$lib/chat/stores/backgroundGenerations";

// The harness's createConversationsStore() pulls in $lib/chat/APIClient (for its unused refresh()
// method), which imports bson-objectid — a CJS package this project's client vitest config can't
// pre-bundle (optimizeDeps.noDiscovery/include:[] in vite.config.ts, set deliberately for OTHER
// component imports; this store was simply never reached by a client-project test before). Stubbed
// rather than widening that shared config for one test that never calls refresh() anyway.
vi.mock("$lib/chat/APIClient", () => ({
	useAPIClient: () => {
		throw new Error("not stubbed for this test");
	},
	handleResponse: (r: unknown) => r,
}));

const { default: Harness } = await import("./BackgroundGenerationPoller.harness.svelte");

// The live tab's recovery path for a turn that finished server-side but whose stream this tab lost
// is armFirstTokenWatchdog -> handleStalledConnection -> addBackgroundGeneration -> this poller
// opening an SSE to pick up the terminal write (CUR-1157). A network capture cannot settle whether
// that SSE opens, because EventSource isn't XHR/fetch, so this pins down the CLIENT WIRING claim
// directly: does adding an entry to the shared store actually cause a real `new EventSource(...)`
// construction, in a real browser, through the real reactive chain (module $state -> $effect.root
// -> $effect)?
let opened: string[] = [];

class FakeEventSource {
	url: string;
	onerror: (() => void) | null = null;
	constructor(url: string | URL) {
		this.url = url.toString();
		opened.push(this.url);
	}
	addEventListener() {
		/* no-op: this test only asserts the connection was OPENED */
	}
	close() {
		/* no-op */
	}
}

describe("BackgroundGenerationPoller — opens an EventSource once a generation is tracked (CUR-1157)", () => {
	let originalEventSource: typeof EventSource;

	beforeEach(() => {
		clearBackgroundGenerations();
		opened = [];
		originalEventSource = globalThis.EventSource;
		// @ts-expect-error test stub, not a spec-compliant EventSource
		globalThis.EventSource = FakeEventSource;
	});

	afterEach(() => {
		// vitest-browser-svelte does not auto-unmount between tests in the same file: without this,
		// the PRIOR test's poller instance stays mounted and reacts too when the next test mutates the
		// module-level backgroundGenerationEntries store, opening a second EventSource nobody asked for
		// (two "opening SSE stream" logs for one addBackgroundGeneration call).
		cleanup();
		clearBackgroundGenerations();
		globalThis.EventSource = originalEventSource;
	});

	it("does not open a connection with nothing tracked", async () => {
		await render(Harness);
		expect(opened).toEqual([]);
	});

	it("opens /api/v2/conversations/updates as soon as addBackgroundGeneration registers an entry", async () => {
		await render(Harness);
		expect(opened).toEqual([]);

		addBackgroundGeneration({ id: "conv-cur1157", startedAt: Date.now() });

		await vi.waitFor(() => {
			expect(opened.length).toBe(1);
		});
		expect(opened[0]).toContain("/api/v2/conversations/updates");
	});
});
