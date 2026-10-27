import { describe, expect, it } from "vitest";
import { buildArtifactSrcdoc, buildHtmlSrcdoc } from "$lib/chat/utils/previewSrcdoc";

const CSP_TAG = '<meta http-equiv="Content-Security-Policy"';

/** Index of the first model-written marker, which the policy must precede. */
function policyPrecedes(doc: string, marker: string): boolean {
	const policy = doc.indexOf(CSP_TAG);
	const model = doc.indexOf(marker);
	return policy !== -1 && model !== -1 && policy < model;
}

describe("artifact srcdoc policy (CUR-3187)", () => {
	it("closes every way out of the frame: connect, form, frame, base, remote images", () => {
		const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(
			buildHtmlSrcdoc("<p>x</p>", "c")
		)?.[1];
		expect(policy).toBeDefined();
		const directives = new Map(
			(policy ?? "").split(";").map((d) => {
				const [name, ...values] = d.trim().split(/\s+/);
				return [name, values] as const;
			})
		);
		expect(directives.get("default-src")).toEqual(["'none'"]);
		expect(directives.get("connect-src")).toEqual(["'none'"]);
		expect(directives.get("form-action")).toEqual(["'none'"]);
		expect(directives.get("frame-src")).toEqual(["'none'"]);
		expect(directives.get("base-uri")).toEqual(["'none'"]);
		expect(directives.get("img-src")).toEqual(["data:", "blob:"]);
		expect(directives.get("media-src")).toEqual(["data:", "blob:"]);
	});

	const htmlShapes: Array<[string, string]> = [
		["a full document", "<!doctype html><html><head><script>MODEL</script></head><body></body></html>"],
		["a script placed before <head>", "<html><script>MODEL</script><head></head><body></body></html>"],
		["a script before <html>", "<!DOCTYPE html><script>MODEL</script><html><head></head></html>"],
		["a leading comment then doctype", "<!-- hi --><!doctype html><script>MODEL</script>"],
		["an abruptly closed comment hiding a script", "<!--><script>MODEL</script>--><!doctype html>"],
		["a --!> comment close hiding a script", "<!-- a --!><script>MODEL</script>--><!doctype html>"],
		["a bare fragment", "<div>hi</div><script>MODEL</script>"],
		["a head whose attributes hide a tag", '<head data-x="<head>"><script>MODEL</script></head>'],
	];

	it.each(htmlShapes)("puts the policy ahead of any model markup in %s", (_label, content) => {
		const doc = buildHtmlSrcdoc(content, "c");
		expect(policyPrecedes(doc, "MODEL")).toBe(true);
		// Nothing but a doctype may come ahead of the policy: no comment, whose end the HTML parser and a
		// regex can disagree on.
		expect(doc.slice(0, doc.indexOf(CSP_TAG))).toMatch(/^\s*<!doctype[^>]*>$/i);
	});

	it("keeps a leading doctype first, so the page does not fall into quirks mode", () => {
		expect(buildHtmlSrcdoc("<!DOCTYPE html><p>x</p>", "c").startsWith("<!DOCTYPE html>" + CSP_TAG)).toBe(true);
	});

	it("gives content without a leading doctype one of its own, so the page stays in standards mode", () => {
		expect(buildHtmlSrcdoc("<!-- hi --><p>x</p>", "c").startsWith("<!doctype html>" + CSP_TAG)).toBe(true);
	});

	it("puts the policy ahead of the content of an SVG, React and Mermaid artifact", () => {
		expect(policyPrecedes(buildArtifactSrcdoc("svg","<svg><script>MODEL</script></svg>", "c"), "MODEL")).toBe(true);
		expect(policyPrecedes(buildArtifactSrcdoc("react", "export default () => 'MODEL'", "c"), "MODEL")).toBe(true);
		expect(policyPrecedes(buildArtifactSrcdoc("mermaid", "graph TD; MODEL", "c"), "MODEL")).toBe(true);
	});

	it("puts the policy ahead of the CDN scripts and the preview hook in the React builder", () => {
		const doc = buildArtifactSrcdoc("react", "export default () => null", "c");
		expect(policyPrecedes(doc, "https://cdn.tailwindcss.com")).toBe(true);
		expect(policyPrecedes(doc, "chatui.preview.ready")).toBe(true);
	});
});
