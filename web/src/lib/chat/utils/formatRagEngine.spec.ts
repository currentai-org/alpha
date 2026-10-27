import { describe, it, expect } from "vitest";
import { formatRagEngine } from "./formatRagEngine";

describe("formatRagEngine", () => {
	it("composes SyftHub:<sourceName> for the generic federated engine", () => {
		expect(formatRagEngine({ engine: "SyftHub", sourceName: "epfl-news/epfl-news" })).toBe(
			"SyftHub:epfl-news/epfl-news"
		);
	});

	it("falls back to the bare engine when SyftHub has no sourceName", () => {
		expect(formatRagEngine({ engine: "SyftHub" })).toBe("SyftHub");
	});

	it("renders other engines (incl. legacy labels) verbatim", () => {
		expect(formatRagEngine({ engine: "Potluck" })).toBe("Potluck");
		expect(formatRagEngine({ engine: "Potluck:Community" })).toBe("Potluck:Community");
		expect(formatRagEngine({ engine: "SyftHub:EPFL", sourceName: "ignored" })).toBe("SyftHub:EPFL");
	});
});
