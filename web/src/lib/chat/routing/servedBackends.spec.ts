import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKEND_HOSTS, SWISS_BACKEND_HOSTS, backendOrg } from "./catalog";
import { SERVED_BACKENDS_FILE, servedBackendsJson } from "../../../../scripts/gen-served-backends";

// The catalog's host table is the one place a served backend is written. These pin what it
// claims, so a diff that moves the Swiss claim shows up here, and keep the generated copy agent-service
// reads from drifting away from it.
describe("BACKEND_HOSTS", () => {
	// The claim "sovereign public compute in Switzerland" may stand for an answer from exactly these
	// hosts. Adding one here is a claim that it is in Switzerland: make it by setting the org's region,
	// once verified, and this list changes in the same diff.
	it("claims Swiss compute for exactly the hosts whose org region is Switzerland: CSCS (gateway and direct), Infomaniak, Phoeniqs", () => {
		expect([...SWISS_BACKEND_HOSTS]).toEqual([
			"api.inference.cscs.ch",
			"api.infomaniak.com",
			"api.swissai.svc.cscs.ch",
			"maas.phoeniqs.com",
		]);
		for (const host of Object.keys(BACKEND_HOSTS)) {
			expect(backendOrg(host)?.swiss, host).toBe(backendOrg(host)?.org.region === "Switzerland");
		}
	});

	it("names a known non-Swiss host with its own country and never counts it Swiss ", () => {
		expect(backendOrg("api.featherless.ai")).toMatchObject({ label: "Featherless (United States)", swiss: false });
		expect(backendOrg("api.sea-lion.ai")).toMatchObject({ label: "AI Singapore (Singapore)", swiss: false });
		expect(backendOrg("api.mistral.ai")?.label).toBe("Mistral AI La Plateforme (France)");
		// An org whose country is on no record gets a name and no country, never a guessed one.
		expect(backendOrg("api.nextbit256.com")).toMatchObject({ label: "NextBit", country: undefined, swiss: false });
	});

	it("knows nothing about a host outside the table, including an inherited object key", () => {
		expect(backendOrg("api.example.com")).toBeUndefined();
		expect(backendOrg("constructor")).toBeUndefined();
	});
});

describe("agent-service/api/served_backends.json", () => {
	// proxy.py's SWISS_BACKENDS reads this copy, the one inside agent-service's Docker context. A stale
	// copy counts an agent turn's backend Swiss or not differently from the chat for the same host. Fix
	// a failure with `pnpm gen:served-backends`, never by hand.
	it("is byte-identical to what pnpm gen:served-backends writes from the catalog (fails on a hand edit or a stale copy)", () => {
		expect(readFileSync(SERVED_BACKENDS_FILE, "utf8")).toBe(servedBackendsJson());
	});
});
