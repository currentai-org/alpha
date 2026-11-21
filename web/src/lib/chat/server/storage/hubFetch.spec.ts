import { afterEach, describe, expect, test, vi } from "vitest";

const warn = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn } }));

const { runWithRequestContext } = await import("$lib/chat/server/requestContext");
const { hubCallSummary, hubFetch } = await import("./hubFetch");

// The count is what names the route spending the shared storage token's Hub budget.

afterEach(() => {
	vi.unstubAllGlobals();
	warn.mockClear();
});

function stubFetch(status = 200, headers: Record<string, string> = {}) {
	const spy = vi.fn(async () => new Response("{}", { status, headers }));
	vi.stubGlobal("fetch", spy);
	return spy;
}

describe("each call is named by its Hub operation, never the repo or file", () => {
	const kind = (method: string, url: string) => {
		stubFetch();
		return runWithRequestContext(async () => {
			await hubFetch(url, { method });
			return hubCallSummary().hub_call_kinds;
		});
	};

	test("a recursive bucket listing is a tree call", async () => {
		expect(
			await kind("GET", "https://huggingface.co/api/buckets/ns/name/tree/main/users/x?recursive=true")
		).toBe("GET tree:1");
	});

	test("repo info, preupload, commit and whoami", async () => {
		expect(await kind("GET", "https://huggingface.co/api/datasets/ns/name")).toBe("GET info:1");
		expect(await kind("POST", "https://huggingface.co/api/models/ns/name/preupload/main")).toBe(
			"POST preupload:1"
		);
		expect(await kind("POST", "https://huggingface.co/api/datasets/ns/name/commit/main")).toBe(
			"POST commit:1"
		);
		expect(await kind("GET", "https://huggingface.co/api/whoami-v2")).toBe("GET whoami-v2:1");
	});

	test("a file download is a resolve call", async () => {
		expect(
			await kind("GET", "https://huggingface.co/datasets/ns/name/resolve/main/users/x/a.txt")
		).toBe("GET resolve:1");
	});

	test("another host is named by its host", async () => {
		expect(await kind("POST", "https://cas-server.xethub.hf.co/xorb/default/abc")).toBe(
			"POST cas-server.xethub.hf.co:1"
		);
	});
});

describe("hubFetch counts each call against the request making it", () => {
	test("tallies by kind and reports the total on the request's summary", async () => {
		const spy = stubFetch();
		const summary = await runWithRequestContext(async () => {
			await hubFetch("https://huggingface.co/api/buckets/ns/b/tree/main/u?recursive=true");
			await hubFetch(new URL("https://huggingface.co/api/buckets/ns/b/tree/main/u"));
			await hubFetch("https://huggingface.co/api/datasets/ns/b/commit/main", { method: "post" });
			return hubCallSummary();
		});
		expect(spy).toHaveBeenCalledTimes(3);
		expect(summary).toEqual({
			hub_calls: 3,
			hub_throttled: 0,
			hub_call_kinds: "GET tree:2,POST commit:1",
		});
	});

	test("counts a 429 as throttled and still hands the response back", async () => {
		stubFetch(429);
		const [status, summary] = await runWithRequestContext(async () => {
			const res = await hubFetch(new Request("https://huggingface.co/api/whoami-v2"));
			return [res.status, hubCallSummary()] as const;
		});
		expect(status).toBe(429);
		expect(summary).toMatchObject({ hub_calls: 1, hub_throttled: 1 });
	});

	test("two concurrent requests keep separate tallies", async () => {
		stubFetch();
		const one = (n: number) =>
			runWithRequestContext(async () => {
				for (let i = 0; i < n; i++) await hubFetch("https://huggingface.co/api/whoami-v2");
				return hubCallSummary().hub_calls;
			});
		expect(await Promise.all([one(1), one(4)])).toEqual([1, 4]);
	});
});

describe("hubCallSummary adds nothing to a request that made no Hub call", () => {
	test("empty inside a request with no calls", () => {
		expect(runWithRequestContext(() => hubCallSummary())).toEqual({});
	});

	test("empty outside any request, and the call still goes through", async () => {
		const spy = stubFetch();
		await hubFetch("https://huggingface.co/api/whoami-v2");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(hubCallSummary()).toEqual({});
	});
});

describe("a 429 logs which Hub quota ran out", () => {
	const policy = '"fixed window";"api";q=3000;w=300, "fixed window";"resolvers";q=20000;w=300';

	test("the ratelimit headers and the call kind reach the log line, the file path never does", async () => {
		stubFetch(429, { ratelimit: '"resolvers";r=0;t=41', "ratelimit-policy": policy, "retry-after": "41" });
		await runWithRequestContext(() =>
			hubFetch("https://huggingface.co/buckets/ns/b/resolve/main/users/x/secret-name.txt")
		);
		expect(warn).toHaveBeenCalledTimes(1);
		const [fields, message] = warn.mock.calls[0];
		expect(message).toBe("hub rate limited");
		expect(fields).toEqual({
			hub_call_kind: "GET resolve",
			hub_ratelimit: '"resolvers";r=0;t=41',
			hub_ratelimit_policy: policy,
			hub_retry_after: "41",
		});
		expect(JSON.stringify(fields)).not.toContain("secret-name");
	});

	test("a 429 outside any request is logged too", async () => {
		stubFetch(429, { ratelimit: '"api";r=0;t=12' });
		const res = await hubFetch("https://huggingface.co/api/whoami-v2");
		expect(res.status).toBe(429);
		expect(warn.mock.calls[0][0]).toEqual({ hub_call_kind: "GET whoami-v2", hub_ratelimit: '"api";r=0;t=12' });
	});

	test("a call that is not throttled logs nothing", async () => {
		stubFetch(200, { ratelimit: '"api";r=2990;t=200' });
		await hubFetch("https://huggingface.co/api/whoami-v2");
		expect(warn).not.toHaveBeenCalled();
	});
});
