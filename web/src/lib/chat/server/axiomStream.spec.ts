// Each of these names a way log shipping fails QUIETLY. A stream that swallows its own errors is the
// right design and also the reason none of this can be caught by watching the app: the app is fine in
// every one of these cases, and the only thing that goes wrong is that the logs are not where you
// look for them a week later.
import { describe, expect, it, vi } from "vitest";
import { createAxiomStream } from "./axiomStream";

// Typed with both parameters so mock.calls is a real tuple — an untyped vi.fn() infers [] and the
// assertions below cannot reach the request init at all.
function okFetch() {
	return vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }));
}

describe("axiomStream", () => {
	it("posts NDJSON to the dataset's ingest endpoint with the bearer token", async () => {
		const fetchImpl = okFetch();
		const s = createAxiomStream({
			token: "tok",
			dataset: "app logs",
			url: "https://axiom.test",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		s.write(JSON.stringify({ level: "info", message: "one" }) + "\n");
		s.write(JSON.stringify({ level: "info", message: "two" }) + "\n");
		await s.flushNow();

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		// The dataset goes in a path segment, so a name with a space must not produce a broken URL.
		expect(url).toBe("https://axiom.test/v1/datasets/app%20logs/ingest");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-ndjson");
		// Newline-delimited, not a JSON array — an array is accepted by nothing and fails as a 4xx
		// that only shows up on stderr.
		expect((init.body as string).split("\n")).toHaveLength(2);
	});

	it("posts to the edge's own ingest path when the dataset lives on another edge (api.axiom.co refuses it)", async () => {
		const fetchImpl = okFetch();
		const s = createAxiomStream({
			token: "tok",
			dataset: "app logs",
			edgeUrl: "https://eu-central-1.aws.edge.axiom.co/",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		s.write(JSON.stringify({ message: "one" }) + "\n");
		await s.flushNow();

		expect(fetchImpl.mock.calls[0][0]).toBe("https://eu-central-1.aws.edge.axiom.co/v1/ingest/app%20logs");
	});

	it("stamps _time from the line's own timestamp, not from ingest time", async () => {
		const fetchImpl = okFetch();
		const s = createAxiomStream({
			token: "t",
			dataset: "d",
			url: "https://axiom.test",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		s.write(JSON.stringify({ time: 1_700_000_000_000, message: "x" }) + "\n");
		await s.flushNow();

		const body = fetchImpl.mock.calls[0][1].body as string;
		expect(JSON.parse(body)._time).toBe(new Date(1_700_000_000_000).toISOString());
	});

	it("ships a line it cannot parse rather than dropping it", async () => {
		const fetchImpl = okFetch();
		const s = createAxiomStream({
			token: "t",
			dataset: "d",
			url: "https://axiom.test",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		s.write("this is not json\n");
		await s.flushNow();

		expect(fetchImpl.mock.calls[0][1].body).toBe("this is not json");
	});

	it("bounds the queue and counts what it dropped, instead of growing without limit", async () => {
		// Never resolves: Axiom is up but not answering, which is the case that grows a buffer.
		const hang = vi.fn(() => new Promise<Response>(() => {}));
		const s = createAxiomStream({
			token: "t",
			dataset: "d",
			url: "https://axiom.test",
			fetchImpl: hang as unknown as typeof fetch,
		});

		for (let i = 0; i < 6_000; i++) s.write(JSON.stringify({ message: i }) + "\n");

		// 5,000 is the cap. Without it this test would pass just as happily at 6,000 and the failure
		// would be an OOM in production while Axiom is unreachable.
		expect(s.droppedCount()).toBeGreaterThan(0);
		expect(s.droppedCount()).toBeLessThan(6_000);
	});

	it("does not surface a failed ingest to the caller, and reports it instead", async () => {
		const errors: string[] = [];
		const s = createAxiomStream({
			token: "t",
			dataset: "wrong-name",
			url: "https://axiom.test",
			fetchImpl: (async () => new Response(null, { status: 403 })) as unknown as typeof fetch,
			onError: (m) => errors.push(m),
		});

		s.write(JSON.stringify({ message: "x" }) + "\n");
		await expect(s.flushNow()).resolves.toBeUndefined();

		// A 403 is a token without ingest scope, and a 404 is a wrong dataset name. Both are ours to
		// fix, so the status and the dataset have to be in the message — "ingest failed" is not enough
		// to act on.
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("403");
		expect(errors[0]).toContain("wrong-name");
	});

	it("does not throw when the network is gone", async () => {
		const errors: string[] = [];
		const s = createAxiomStream({
			token: "t",
			dataset: "d",
			url: "https://axiom.test",
			fetchImpl: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
			onError: (m) => errors.push(m),
		});

		s.write(JSON.stringify({ message: "x" }) + "\n");
		await expect(s.flushNow()).resolves.toBeUndefined();
		expect(errors[0]).toContain("ECONNREFUSED");
	});
});
