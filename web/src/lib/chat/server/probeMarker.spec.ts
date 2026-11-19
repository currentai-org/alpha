import { beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({ PROBE_MARKER_TOKEN: "" as string | undefined }));
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

import { resolveProbeMarker } from "./probeMarker";

const req = (headers: Record<string, string>) => new Request("http://localhost/chat/conversation/x", { headers });

describe("resolveProbeMarker — only a verified probe token marks a turn", () => {
	beforeEach(() => {
		cfg.PROBE_MARKER_TOKEN = "probe-secret";
	});

	it("names the probe when x-probe-token matches PROBE_MARKER_TOKEN", async () => {
		await expect(resolveProbeMarker(req({ "x-probe-token": "probe-secret", "x-probe-name": "synthetic-turn" }))).resolves.toBe(
			"synthetic-turn"
		);
	});

	it("falls back to the generic name for a verified token with no or a malformed x-probe-name", async () => {
		await expect(resolveProbeMarker(req({ "x-probe-token": "probe-secret" }))).resolves.toBe("probe");
		await expect(resolveProbeMarker(req({ "x-probe-token": "probe-secret", "x-probe-name": "<script>" }))).resolves.toBe("probe");
	});

	it("returns null (row stays unmarked) for a wrong token, a prefix of the token, or no token", async () => {
		await expect(resolveProbeMarker(req({ "x-probe-token": "guess", "x-probe-name": "synthetic-turn" }))).resolves.toBeNull();
		await expect(resolveProbeMarker(req({ "x-probe-token": "probe-secre" }))).resolves.toBeNull();
		await expect(resolveProbeMarker(req({ "x-probe-name": "synthetic-turn" }))).resolves.toBeNull();
	});

	it("returns null for every header when PROBE_MARKER_TOKEN is unset, so an empty header cannot match an empty secret", async () => {
		cfg.PROBE_MARKER_TOKEN = "";
		await expect(resolveProbeMarker(req({ "x-probe-token": "" }))).resolves.toBeNull();
		await expect(resolveProbeMarker(req({ "x-probe-token": "anything" }))).resolves.toBeNull();
		cfg.PROBE_MARKER_TOKEN = undefined;
		await expect(resolveProbeMarker(req({ "x-probe-token": "anything" }))).resolves.toBeNull();
	});
});
