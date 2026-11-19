// the probes job runs only for the scheduler that holds CRON_SECRET, and runs every group.
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ CRON_SECRET: "cron-secret" as string | undefined }));
vi.mock("$env/dynamic/private", () => ({ env }));
vi.mock("$app/environment", () => ({ dev: false, building: false, browser: false, version: "test" }));
const warmAll = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("$lib/chat/server/warm", () => ({ warmAll }));

import { GET } from "./+server";

function call(authorization?: string) {
	const headers = authorization ? { authorization } : undefined;
	return GET({ request: new Request("http://localhost/chat/api/probes", { headers }), platform: undefined } as never);
}

beforeEach(() => {
	warmAll.mockClear();
	env.CRON_SECRET = "cron-secret";
});

describe("/chat/api/probes — the scheduled job, gated on CRON_SECRET", () => {
	it("runs the full warm (probes, pruning, heartbeat) for the scheduler's bearer and answers 202", async () => {
		const res = await call("Bearer cron-secret");
		expect(res.status).toBe(202);
		expect(warmAll).toHaveBeenCalledTimes(1);
	});

	it("refuses a request with no bearer or the wrong one, and runs nothing", async () => {
		expect((await call()).status).toBe(401);
		expect((await call("Bearer guess")).status).toBe(401);
		expect(warmAll).not.toHaveBeenCalled();
	});

	it("fails closed when CRON_SECRET is unset outside vite dev, rather than running open", async () => {
		env.CRON_SECRET = undefined;
		expect((await call("Bearer ")).status).toBe(401);
		expect((await call()).status).toBe(401);
		expect(warmAll).not.toHaveBeenCalled();
	});
});
