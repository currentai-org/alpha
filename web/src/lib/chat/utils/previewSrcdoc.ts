import type { ArtifactKind } from "./artifacts";

/**
 * Builders for sandboxed iframe `srcdoc` documents used by live previews
 * (artifact panel and the fullscreen HTML preview modal).
 *
 * Every document gets a hook script that forwards uncaught errors and
 * unhandled rejections to the parent via postMessage on a per-preview
 * channel. The same script intercepts link activation: in-page fragment
 * links scroll within the preview, links whose raw href is an absolute
 * http(s) URL are forwarded to the parent (which confirms before opening
 * a new tab), everything else is blocked. The raw-attribute check matters:
 * srcdoc documents inherit the parent's base URL, so a relative href would
 * resolve to an app-origin URL the artifact never legitimately points at —
 * and the confirm dialog would then show the app's own trusted hostname
 * over an attacker-chosen path. Navigating from inside the sandbox would
 * be broken anyway — the opened tab would inherit the sandbox's opaque
 * origin.
 */

const END_SCRIPT_TAG = "</scr" + "ipt>";

// The code CDNs the builders below load from and that model-written pages commonly use.
// Script hosts receive a request but give an artifact no way to read a response back from another
// origin, and fetch, XHR, beacons, WebSockets and form posts are all closed below. (CUR-3187)
const CODE_CDNS = [
	"https://cdn.tailwindcss.com",
	"https://unpkg.com",
	"https://cdn.jsdelivr.net",
	"https://cdnjs.cloudflare.com",
];

/**
 * The policy every artifact document carries (CUR-3187). A model-written artifact may run any
 * script, so this policy closes the ways out of the frame instead: no fetch, XHR, beacon or
 * WebSocket (connect-src), no form submission (form-action), no remote images or media, which
 * would carry data in their URLs, no nested frames, and no <base href> rewrite. A srcdoc frame
 * also inherits the page's own policy, and a browser applies both, so the meta can only narrow
 * what the page allows.
 */
const ARTIFACT_CSP = [
	"default-src 'none'",
	// Inline because the preview hook and every builder are inline; eval because the React
	// builder runs Babel's output through it.
	`script-src 'unsafe-inline' 'unsafe-eval' ${CODE_CDNS.join(" ")}`,
	`style-src 'unsafe-inline' ${CODE_CDNS.join(" ")} https://fonts.googleapis.com`,
	`font-src data: ${CODE_CDNS.join(" ")} https://fonts.gstatic.com`,
	"img-src data: blob:",
	"media-src data: blob:",
	"worker-src blob:",
	"connect-src 'none'",
	"form-action 'none'",
	"frame-src 'none'",
	"base-uri 'none'",
].join("; ");

/**
 * The policy as a meta tag. It has to be the first thing the parser meets: a meta CSP governs
 * only what comes after it, so model markup placed ahead of it would run unrestricted.
 */
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;

function buildPreviewHookScript(channel: string): string {
	return `\n<script>\n(function(){\n  var host = window.parent;\n  function send(type, detail){\n    try{ host.postMessage({ type: type, channel: '${channel}', detail: detail }, '*'); }catch(e){}\n  }\n  function nearestAnchor(node){\n    while (node && node !== document) {\n      if (node.tagName && node.tagName.toLowerCase() === 'a') return node;\n      node = node.parentNode;\n    }\n    return null;\n  }\n  function anchorHref(anchor){\n    var href = anchor.href;\n    if (typeof href === 'string') return href;\n    if (href && typeof href.baseVal === 'string') {\n      try { return new URL(href.baseVal, document.baseURI).href; } catch (err) { return ''; }\n    }\n    return '';\n  }\n  function scrollToFragment(raw){\n    var id = raw.slice(1);\n    try { id = decodeURIComponent(id); } catch (err) {}\n    var target = id ? document.getElementById(id) : null;\n    if (target && target.scrollIntoView) target.scrollIntoView();\n  }\n  function intercept(ev){\n    var anchor = nearestAnchor(ev.target);\n    if (!anchor) return;\n    ev.preventDefault();\n    ev.stopPropagation();\n    var raw = anchor.getAttribute('href') || anchor.getAttribute('xlink:href') || '';\n    if (raw.charAt(0) === '#') {\n      scrollToFragment(raw);\n      return;\n    }\n    if (!/^\\s*https?:/i.test(raw)) return;\n    var href = anchorHref(anchor);\n    if (/^https?:/i.test(href)) {\n      send('chatui.preview.openLink', { href: href });\n    }\n  }\n  send('chatui.preview.ready');\n  window.addEventListener('beforeunload', function(){ send('chatui.preview.leaving'); }, true);\n  window.addEventListener('load', function(){ send('chatui.preview.loaded'); });\n  window.addEventListener('click', intercept, true);\n  window.addEventListener('auxclick', intercept, true);\n  window.addEventListener('keydown', function(ev){\n    if (ev.key === 'Enter' || ev.key === ' ') {\n      intercept(ev);\n    }\n  }, true);\n  window.addEventListener('error', function(ev){\n    var msg = ev && ev.message ? ev.message : 'Script error';\n    var stack = ev && ev.error && ev.error.stack ? ev.error.stack : undefined;\n    send('chatui.preview.error', { message: msg, stack: stack });\n  });\n  window.addEventListener('unhandledrejection', function(ev){\n    var r = ev && ev.reason;\n    var msg = (typeof r === 'string') ? r : (r && r.message) ? r.message : 'Unhandled promise rejection';\n    var stack = r && r.stack ? r.stack : undefined;\n    send('chatui.preview.error', { message: msg, stack: stack });\n  });\n})();\n${END_SCRIPT_TAG}`;
}

/** JSON-encode a string for embedding inside an inline <script>, escaping `</` so the HTML parser can't terminate the script early. */
function embedAsJsString(source: string): string {
	return JSON.stringify(source).replace(/<\//g, "<\\/");
}

/**
 * Build a srcdoc for raw HTML or SVG content. Injects <base target="_blank">,
 * and the preview hook into the right spot of the document.
 */
export function buildHtmlSrcdoc(content: string, channel: string): string {
	const trimmed = content.trimStart();
	const svgPattern = /^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+svg[^>]*>\s*)?<svg[\s>]/i;
	const baseTag = '<base target="_blank">';
	const previewHook = buildPreviewHookScript(channel);

	if (svgPattern.test(trimmed)) {
		const svgContent = trimmed
			.replace(/^(<\?xml[^>]*>\s*)/i, "")
			.replace(/^(<!doctype[^>]*>\s*)/i, "");
		// Explicit white canvas: SVGs are usually drawn for light backgrounds, and
		// the panel's iframe backing is dark in dark mode
		const svgBackground = "<style>html { background: #fff; }</style>";
		return `<!doctype html><html><head>${CSP_META}${baseTag}${svgBackground}${previewHook}</head><body>${svgContent}</body></html>`;
	}

	// The policy, base and hook go at the very start of the document, after a doctype only.
	// The parser opens an implied <head> for them; the model's own <html> and <head> tags that follow
	// merge into it. Placing them after the model's <head> would let any markup
	// before that tag run first. The doctype is the model's own when the content opens with one, and
	// ours otherwise, so the page keeps standards mode. A doctype the model put later, after a comment,
	// is a parse error the browser ignores. Nothing here parses comments: `<!-->` is a complete comment
	// to the HTML parser, so a comment-skipping regex would let `<!--><script>…</script>--><!doctype html>`
	// run its script ahead of the policy.
	const leadingDoctype = /^\s*<!doctype[^>]*>/i.exec(content)?.[0];
	const rest = leadingDoctype ? content.slice(leadingDoctype.length) : content;
	return (leadingDoctype ?? "<!doctype html>") + CSP_META + baseTag + previewHook + rest;
}

const REACT_HOOK_PRELUDE = [
	"useState",
	"useEffect",
	"useMemo",
	"useCallback",
	"useRef",
	"useReducer",
	"useContext",
	"useLayoutEffect",
	"useId",
	"useTransition",
	"useDeferredValue",
	"useSyncExternalStore",
	"useImperativeHandle",
	"Fragment",
	"createContext",
	"memo",
	"forwardRef",
]
	.map((name) => `var ${name} = React.${name};`)
	.join(" ");

/**
 * Build a srcdoc that renders a single React component. The component source
 * is transformed in the iframe with Babel standalone (JSX + TypeScript),
 * imports are stripped (React and its hooks are provided as globals, Tailwind
 * classes work via the Play CDN), and the default export is rendered.
 */
export function buildReactSrcdoc(code: string, channel: string): string {
	const previewHook = buildPreviewHookScript(channel);
	return `<!doctype html>
<html>
<head>
${CSP_META}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">${previewHook}
<script src="https://cdn.tailwindcss.com">${END_SCRIPT_TAG}
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js">${END_SCRIPT_TAG}
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js">${END_SCRIPT_TAG}
<script src="https://unpkg.com/@babel/standalone@7/babel.min.js">${END_SCRIPT_TAG}
<style>html, body { margin: 0; min-height: 100%; background: #fff; }</style>
</head>
<body>
<div id="artifact-root"></div>
<script>
(function () {
	var source = ${embedAsJsString(code)};
	function fail(message) {
		var el = document.getElementById("artifact-root");
		if (el) {
			el.innerHTML = "";
			var pre = document.createElement("pre");
			pre.style.cssText = "color:#b91c1c;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;padding:16px;margin:0";
			pre.textContent = message;
			el.appendChild(pre);
		}
		setTimeout(function () { throw new Error(message); }, 0);
	}
	try {
		var prepared = source
			.replace(/^[ \\t]*import[^\\n]*$/gm, "")
			.replace(/^[ \\t]*export\\s+\\{[^}]*\\}\\s*;?[ \\t]*$/gm, "")
			.replace(/\\bexport\\s+default\\s+/, "window.__artifactDefault = ")
			.replace(/^([ \\t]*)export\\s+(const|let|var|function|class)/gm, "$1$2");
		var compiled = Babel.transform(prepared, {
			filename: "artifact.tsx",
			presets: [["react"], ["typescript", { isTSX: true, allExtensions: true }]],
		}).code;
		(0, eval)(${embedAsJsString(REACT_HOOK_PRELUDE)} + "\\n" + compiled);
		var Component = window.__artifactDefault;
		if (typeof Component === "undefined" || Component === null) {
			fail("No default export found. The artifact must use export default for its component.");
			return;
		}
		ReactDOM.createRoot(document.getElementById("artifact-root")).render(
			React.createElement(Component)
		);
	} catch (e) {
		fail(e && e.message ? e.message : String(e));
	}
})();
${END_SCRIPT_TAG}
</body>
</html>`;
}

/** Build a srcdoc that renders a Mermaid diagram, centered on a light canvas. */
export function buildMermaidSrcdoc(code: string, channel: string): string {
	const previewHook = buildPreviewHookScript(channel);
	return `<!doctype html>
<html>
<head>
${CSP_META}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">${previewHook}
<style>
html, body { margin: 0; min-height: 100%; background: #fff; }
#artifact-root { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; box-sizing: border-box; }
#artifact-root svg { max-width: 100%; height: auto; }
</style>
</head>
<body>
<div id="artifact-root"></div>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
const code = ${embedAsJsString(code)};
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
try {
	const { svg } = await mermaid.render("artifact-diagram", code);
	document.getElementById("artifact-root").innerHTML = svg;
} catch (e) {
	const pre = document.createElement("pre");
	pre.style.cssText = "color:#b91c1c;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;padding:16px;margin:0";
	pre.textContent = String((e && e.message) || e);
	const root = document.getElementById("artifact-root");
	root.innerHTML = "";
	root.appendChild(pre);
	setTimeout(() => { throw e; }, 0);
}
${END_SCRIPT_TAG}
</body>
</html>`;
}

/** Dispatch to the right srcdoc builder for an artifact kind. */
export function buildArtifactSrcdoc(kind: ArtifactKind, content: string, channel: string): string {
	switch (kind) {
		case "react":
			return buildReactSrcdoc(content, channel);
		case "mermaid":
			return buildMermaidSrcdoc(content, channel);
		default:
			return buildHtmlSrcdoc(content, channel);
	}
}

/**
 * Notices a preview frame leaving its own document (CUR-3527). A sandboxed frame may still navigate
 * itself, and no CSP directive in the frame governs that, so an artifact's script can swap the
 * preview for any site, which then renders inside our panel with the sandbox's flags.
 *
 * The preview hook runs before any artifact markup and reports three moments: `ready` as it parses,
 * `leaving` from a `beforeunload` listener, and `loaded` from the srcdoc's window load. The guard
 * fires on any of:
 * - `leaving` after this document's `ready`. It arrives as the navigation starts, before the
 *   destination answers, so a page that never finishes loading is still caught. (`pagehide` waits
 *   for the destination to commit, and by then its message no longer comes from the frame's
 *   window.) A `leaving` before `ready` is the previous document unloading after a reset.
 * - a second iframe load for one srcdoc.
 * - an iframe load the hook did not report as `loaded` within `graceMs`.
 *
 * None of this stops the request the navigation makes, and a destination page can post fake
 * reports; only a `frame-src` on the embedding page blocks the navigation itself.
 *
 * Wire `onload` as the iframe's inline handler, pass the hook's messages (already checked for the
 * frame's source and channel) to `onMessage`, and call `reset` whenever the srcdoc changes or the
 * iframe element mounts.
 */
export function createFrameLeaveGuard(
	onLeft: () => void,
	graceMs = 1000
): { onload: () => void; onMessage: (type: string) => void; reset: () => void } {
	let loads = 0;
	let reported = false;
	let ready = false;
	let left = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const leave = () => {
		clearTimeout(timer);
		if (left) return;
		left = true;
		onLeft();
	};
	return {
		onload: () => {
			loads += 1;
			if (loads > 1) return leave();
			timer = setTimeout(() => {
				if (!reported) leave();
			}, graceMs);
		},
		onMessage: (type) => {
			if (type === "chatui.preview.ready") ready = true;
			else if (type === "chatui.preview.loaded") reported = true;
			else if (type === "chatui.preview.leaving" && ready) leave();
		},
		reset: () => {
			clearTimeout(timer);
			loads = 0;
			reported = false;
			ready = false;
			left = false;
		},
	};
}
