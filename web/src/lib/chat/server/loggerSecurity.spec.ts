// Security events go to their own Axiom dataset, kept longer than the app logs. These pin
// which lines reach it: a securityLogger line reaches both datasets, an ordinary line never reaches the
// security one, and with the security dataset unconfigured securityLogger is the ordinary logger. (CUR-4143)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const cfg: Record<string, string | undefined> = {};
const written: Record<string, Record<string, unknown>[]> = {};

vi.mock("$app/environment", () => ({ dev: false }));
vi.mock("$lib/chat/server/config", () => ({ config: new Proxy({}, { get: (_t, k: string) => cfg[k] }) }));
vi.mock("$lib/chat/server/axiomStream", () => ({
	createAxiomStream: ({ dataset }: { dataset: string }) => ({
		write: (line: string) => void (written[dataset] ??= []).push(JSON.parse(line)),
	}),
}));

async function loadLogger() {
	vi.resetModules();
	return import("./logger");
}

describe("securityLogger (CUR-4143)", () => {
	beforeEach(() => {
		for (const k of Object.keys(written)) delete written[k];
		Object.assign(cfg, {
			LOG_LEVEL: "info",
			AXIOM_TOKEN: "app-token",
			AXIOM_DATASET: "app",
			AXIOM_SECURITY_TOKEN: "security-token",
			AXIOM_SECURITY_DATASET: "security",
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});
	afterEach(() => vi.restoreAllMocks());

	it("a security line reaches the security dataset and the app dataset; an ordinary line never reaches the security dataset", async () => {
		const { logger, securityLogger } = await loadLogger();
		securityLogger.info({ event: "sign-in" }, "[security] sign-in");
		logger.info("an ordinary line");

		expect((written.security ?? []).map((l) => l.message)).toEqual(["[security] sign-in"]);
		expect((written.app ?? []).map((l) => l.message)).toEqual(["[security] sign-in", "an ordinary line"]);
	});

	it("with the security dataset unset, securityLogger is the ordinary logger, so no security line is dropped", async () => {
		cfg.AXIOM_SECURITY_TOKEN = undefined;
		cfg.AXIOM_SECURITY_DATASET = undefined;
		const { logger, securityLogger } = await loadLogger();
		expect(securityLogger).toBe(logger);
		securityLogger.info("[security] sign-in");
		expect((written.app ?? []).map((l) => l.message)).toEqual(["[security] sign-in"]);
	});

	it("half-configured security dataset is refused loudly on stderr, naming the missing key", async () => {
		cfg.AXIOM_SECURITY_DATASET = undefined;
		await loadLogger();
		const stderr = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0])).join("");
		expect(stderr).toContain("AXIOM_SECURITY_DATASET is missing");
	});
});
