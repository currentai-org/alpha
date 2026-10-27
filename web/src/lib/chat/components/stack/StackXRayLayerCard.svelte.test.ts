import StackXRayLayerCard from "./StackXRayLayerCard.svelte";
import { render, cleanup } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { describe, expect, it, afterEach } from "vitest";
import type { StackXRayLayer } from "./stackXRayLayers";

// Every card links outward only (GitHub, Hugging Face, vendor sites) — never to our own /map
// (CUR-1736). This pins it via a real accessible-role query, because a rendered-link text scan and the accessibility tree can
// disagree on this panel, and the tree is the one a visitor gets.
// A source grep on the template string would not catch a regression of it. The row's detail opens on tap (`expanded` only marks the part as used), so
// each test opens it first.
async function openRow() {
	await page.getByRole("button").first().click();
}
const baseLayer: StackXRayLayer = {
	name: "chat",
	label: "Chat",
	emoji: "💬",
	partner: "Hugging Face",
	desc: "Browser-based conversational client.",
	touched: false,
	status: "live",
	mapHref: "/map",
};

describe("StackXRayLayerCard — gap map link (CUR-1736)", () => {
	afterEach(() => {
		cleanup();
	});

	it("links to the product's own gap-map page in a new tab, so the chat stays where it was", async () => {
		await render(StackXRayLayerCard, {
			layer: { ...baseLayer, mapHref: "/product/huggingchat-chat-ui" },
			expanded: true,
		});
		await openRow();
		const link = page.getByRole("link", { name: /gap map/i });
		await expect.element(link).toBeInTheDocument();
		expect(link).toHaveAttribute("href", "/product/huggingchat-chat-ui");
		expect(link).toHaveAttribute("target", "_blank");
	});

	it("falls back to /map when the row names nothing in the catalog", async () => {
		await render(StackXRayLayerCard, { layer: baseLayer, expanded: true });
		await openRow();
		expect(page.getByRole("link", { name: /gap map/i })).toHaveAttribute("href", "/map");
	});

	it("still links to /map on a touched card that also has outward provenance links", async () => {
		const touchedLayer: StackXRayLayer = {
			...baseLayer,
			touched: true,
			provenanceLinks: [{ label: "GitHub", url: "https://github.com/huggingface/chat-ui" }],
		};
		await render(StackXRayLayerCard, { layer: touchedLayer, expanded: true });
		await openRow();
		expect(page.getByRole("link", { name: "GitHub" })).toHaveAttribute(
			"href",
			"https://github.com/huggingface/chat-ui"
		);
		expect(page.getByRole("link", { name: /gap map/i })).toHaveAttribute("href", "/map");
	});

	it("does not render the map link (or anything else in the expanded body) when collapsed", async () => {
		await render(StackXRayLayerCard, { layer: baseLayer, expanded: false });
		await expect
			.element(page.getByRole("link", { name: /gap map/i }))
			.not.toBeInTheDocument();
	});
});

describe("StackXRayLayerCard — maker name and our own page (CUR-1745)", () => {
	afterEach(() => {
		cleanup();
	});

	it("links the maker's name to the maker, and our policy page as a separate link named as ours", async () => {
		await render(StackXRayLayerCard, {
			layer: {
				...baseLayer,
				name: "trust-and-safety",
				label: "trust-and-safety",
				partner: "Mistral AI",
				partnerLink: "https://mistral.ai",
				osProduct: "Shieldstral",
				ownLink: { href: "/trust-and-safety", label: "Our Trust & Safety policy" },
			},
			expanded: true,
		});
		await openRow();
		const maker = page.getByRole("link", { name: "Mistral AI" });
		await expect.element(maker).toHaveAttribute("href", "https://mistral.ai");
		expect(maker).toHaveAttribute("target", "_blank");
		const ours = page.getByRole("link", { name: "Our Trust & Safety policy" });
		await expect.element(ours).toHaveAttribute("href", "/trust-and-safety");
		expect(ours).not.toHaveAttribute("target");
	});

	it("shows no own-page link on a part we have no page about", async () => {
		await render(StackXRayLayerCard, { layer: baseLayer, expanded: true });
		await openRow();
		await expect.element(page.getByRole("link", { name: /gap map/i })).toBeInTheDocument();
		expect(page.getByRole("link", { name: /^Our / }).elements()).toHaveLength(0);
	});
});

// A Mistral Large 3 answer goes straight to Mistral's API, so the router and engine rows stay unlit,
// and their chip must not say "Working" under the finished answer, which reads as still running (CUR-2850).
describe("StackXRayLayerCard — status chip beside an answer (CUR-2850)", () => {
	afterEach(() => {
		cleanup();
	});

	it("says a working part the answer skipped was not used for it, never that it is working", async () => {
		await render(StackXRayLayerCard, { layer: baseLayer, expanded: false, answered: true });
		await expect.element(page.getByText("Not used for this answer")).toBeInTheDocument();
		await expect.element(page.getByText("Working", { exact: true })).not.toBeInTheDocument();
	});

	it("names the platform that stood in for a skipped serving row instead of a bare 'not used' (CUR-3966)", async () => {
		await render(StackXRayLayerCard, {
			layer: { ...baseLayer, bypassedBy: "Mistral AI's La Plateforme in France" },
			expanded: false,
			answered: true,
		});
		await expect.element(page.getByText("Skipped for this answer")).toBeInTheDocument();
		await expect
			.element(page.getByText("Mistral AI's La Plateforme in France ran this answer directly."))
			.toBeInTheDocument();
		await expect.element(page.getByText("Not used for this answer")).not.toBeInTheDocument();
	});

	it("marks a row the answer recorded nothing about as not reported, never as not used (CUR-3966)", async () => {
		await render(StackXRayLayerCard, {
			layer: { ...baseLayer, unreported: true },
			expanded: false,
			answered: true,
		});
		await expect.element(page.getByText("Not reported", { exact: true })).toBeInTheDocument();
		await expect.element(page.getByText("Not used for this answer")).not.toBeInTheDocument();
	});

	it("keeps Working for a live part while no answer is on screen", async () => {
		await render(StackXRayLayerCard, { layer: baseLayer, expanded: false });
		await expect.element(page.getByText("Working", { exact: true })).toBeInTheDocument();
	});

	it("says a built part no offered model runs on is not in use before an answer, never working (CUR-4328)", async () => {
		await render(StackXRayLayerCard, { layer: { ...baseLayer, idle: true }, expanded: false });
		await expect.element(page.getByText("Not in use right now")).toBeInTheDocument();
		await expect.element(page.getByText("Working", { exact: true })).not.toBeInTheDocument();
	});

	it("still lights an idle part as used when an answer did run on it (CUR-4328)", async () => {
		await render(StackXRayLayerCard, {
			layer: { ...baseLayer, idle: true, touched: true },
			expanded: true,
			answered: true,
		});
		await expect.element(page.getByText("Used for this answer")).toBeInTheDocument();
	});

	it("marks a part the answer used as used, answer or not", async () => {
		await render(StackXRayLayerCard, { layer: { ...baseLayer, touched: true }, expanded: true, answered: true });
		await expect.element(page.getByText("Used for this answer")).toBeInTheDocument();
	});
});
