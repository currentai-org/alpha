import { describe, it, expect } from "vitest";
import type { Message } from "$lib/chat/types/Message";
import { routeFor, storageRegionLabel } from "./servingRoute";

const LOCATION_NOT_PUBLISHED = "location not published";
const NOT_RECORDED = "not recorded";

const answer = (routerMetadata?: Message["routerMetadata"]): Message => ({
	id: "a",
	from: "assistant",
	content: "Tokyo.",
	routerMetadata,
});

const roles = (m: Message | undefined, storage?: string) => routeFor(m, storage).map((h) => h.role);
const hop = (m: Message | undefined, role: string, storage?: string) => routeFor(m, storage).find((h) => h.role === role);

describe("routeFor", () => {
	const viaRouter = answer({
		route: "",
		model: "mistral-large-2512",
		backend: "https://api.mistral.ai/v1",
		lane: "router.stg.aipotluck.org",
		appRegion: "fra1",
	});
	const direct = answer({
		route: "",
		model: "mistral-large-2512",
		backend: "https://api.mistral.ai/v1",
		lane: "api.mistral.ai",
		appRegion: "fra1",
	});

	it("a router.stg turn is never direct: it lists the router between the app and Mistral", () => {
		expect(roles(viaRouter, "eu-central-1")).toEqual(["app", "router", "model", "storage"]);
		expect(hop(viaRouter, "router")).toMatchObject({ source: "router.stg.aipotluck.org" });
		expect(hop(viaRouter, "model")).toMatchObject({ orgId: "mistral", source: "api.mistral.ai" });
	});

	it("names an Apertus turn's Phoeniqs host by its catalog org and places it in Switzerland (CUR-4587)", () => {
		const phoeniqs = answer({ route: "", model: "swiss-ai/apertus-v1.5-70b", backend: "https://maas.phoeniqs.com/v1" });
		expect(hop(phoeniqs, "model")).toMatchObject({
			orgId: "phoeniqs",
			name: "Phoeniqs",
			place: "Switzerland",
			outsideEurope: false,
			source: "maas.phoeniqs.com",
		});
	});

	it("a turn sent straight to the vendor has no router hop", () => {
		expect(roles(direct, "eu-central-1")).toEqual(["app", "model", "storage"]);
	});

	it("an unknown router origin reads location not published, never a guess, and carries no Europe tag either way", () => {
		for (const lane of ["router.stg.aipotluck.org", "api-internal.publicai.co", "router.example.test"]) {
			const r = hop(answer({ route: "", model: "m", backend: "https://api.mistral.ai/v1", lane }), "router");
			expect(r?.place, lane).toBe(LOCATION_NOT_PUBLISHED);
			expect(r?.outsideEurope, lane).toBeUndefined();
		}
	});

	it("a turn with no appRegion says not recorded for the app server", () => {
		const old = answer({ route: "", model: "mistral-large-2512", backend: "https://api.mistral.ai/v1" });
		expect(hop(old, "app")?.place).toBe(NOT_RECORDED);
		expect(hop(old, "app")?.source).toBeUndefined();
		expect(hop(old, "app")?.outsideEurope).toBeUndefined();
	});

	it("a hop outside Europe is tagged and one inside is not", () => {
		const us = answer({ route: "", model: "m", backend: "https://api.featherless.ai/v1", appRegion: "iad1" });
		expect(hop(us, "app")).toMatchObject({ place: "Washington, D.C., United States", outsideEurope: true });
		expect(hop(us, "model")).toMatchObject({ place: "United States", outsideEurope: true });
		expect(hop(us, "storage", "us-east-1")).toMatchObject({ outsideEurope: true });
		expect(hop(viaRouter, "app")).toMatchObject({ place: "Frankfurt, Germany", outsideEurope: false });
		expect(hop(viaRouter, "model")).toMatchObject({ place: "France", outsideEurope: false });
		expect(hop(viaRouter, "storage", "eu-central-1")).toMatchObject({ place: "Frankfurt, Germany", outsideEurope: false });
	});

	it("a model host we have never measured reads location not published, with no name made up", () => {
		const m = hop(answer({ route: "", model: "m", backend: "https://unknown.example/v1" }), "model");
		expect(m?.place).toBe(LOCATION_NOT_PUBLISHED);
		expect(m?.name).toBeUndefined();
		expect(m?.outsideEurope).toBeUndefined();
	});

	it("a turn with no backend and no lane says the model host was not recorded", () => {
		expect(hop(answer({ route: "", model: "m" }), "model")).toMatchObject({ place: NOT_RECORDED });
		expect(hop(undefined, "model")).toMatchObject({ place: NOT_RECORDED });
	});

	it("storage with no region label says not recorded, and an unlisted region names its code rather than a place", () => {
		expect(hop(direct, "storage")).toMatchObject({ place: NOT_RECORDED });
		expect(hop(direct, "storage", "eu-south-9")?.place).toBe("AWS region eu-south-9");
		expect(hop(direct, "storage", "eu-south-9")?.outsideEurope).toBeUndefined();
	});
});

describe("storageRegionLabel", () => {
	it("reads the region segment of a Neon host, pooled or direct", () => {
		expect(storageRegionLabel("postgresql://u:p@ep-x-123.eu-central-1.aws.neon.tech/db?sslmode=require")).toBe("eu-central-1");
		expect(storageRegionLabel("postgresql://u:p@ep-x-123-pooler.c-2.us-east-1.aws.neon.tech/db")).toBe("us-east-1");
	});

	it("returns undefined (no claim) for a host with no region or an unparseable string", () => {
		expect(storageRegionLabel("postgresql://u:p@localhost:5432/db")).toBeUndefined();
		expect(storageRegionLabel("not a url")).toBeUndefined();
		expect(storageRegionLabel(undefined)).toBeUndefined();
	});

	it("returns only the label, never any part of the credentials", () => {
		const label = storageRegionLabel("postgresql://secretuser:secretpass@ep-x.eu-central-1.aws.neon.tech/db");
		expect(label).not.toMatch(/secret/);
	});
});
