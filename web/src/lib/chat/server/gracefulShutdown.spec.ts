// a SIGTERM on a plain Node host lets the open stream and the work queued after it finish.
//
// Runs adapter-node's REAL server entry (files/index.js, its own SIGTERM handling) in a child process,
// with a stand-in SvelteKit handler that streams for ~1.5 s and queues background work through the
// real runInBackground. The child sets an idle interval the way the app's DB pool and pollers do, so
// it cannot exit by its event loop running dry: only gracefulShutdown's exit ends it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const adapterFiles = join(dirname(require.resolve("@sveltejs/adapter-node/package.json")), "src");

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "graceful-shutdown-"));
	for (const f of ["index.js", "utils.js", "env.js"]) {
		await cp(join(adapterFiles, f), join(dir, f));
	}
	// env.js imports the build-time ENV_PREFIX through a package `imports` entry that the adapter's
	// build writes; stand in for it with the empty prefix.
	await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module", imports: { "#@sveltejs/adapter-node": "./env-prefix.js" } }));
	await writeFile(join(dir, "env-prefix.js"), 'export const env_prefix = "";\n');

	const bg = pathToFileURL(join(here, "vercelBackground.ts")).href;
	const gs = pathToFileURL(join(here, "gracefulShutdown.ts")).href;
	await writeFile(
		join(dir, "handler.js"),
		`import { runInBackground } from ${JSON.stringify(bg)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const handler = (req, res) => {
	const bgMs = Number(process.env.TEST_BG_MS);
	void runInBackground(sleep(bgMs).then(() => console.log("background-done")));
	res.writeHead(200, { "content-type": "text/plain" });
	let n = 0;
	const t = setInterval(() => {
		res.write("chunk" + n + "\\n");
		if (++n === 15) { clearInterval(t); res.end(); }
	}, 100);
};
`
	);
	await writeFile(
		join(dir, "boot.mjs"),
		`import { installGracefulShutdown } from ${JSON.stringify(gs)};
import { drainBackground } from ${JSON.stringify(bg)};
if (!process.env.TEST_NO_SHUTDOWN) {
	installGracefulShutdown({ drain: drainBackground, log: (msg, f) => console.log(msg, JSON.stringify(f)) });
}
setInterval(() => {}, 1000); // the app's long-lived handles: DB pool, pollers
await import("./index.js");
`
	);
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

function boot(env: Record<string, string>): { child: ChildProcess; out: () => string; port: Promise<number> } {
	const child = spawn(process.execPath, [join(dir, "boot.mjs")], {
		env: { ...process.env, PORT: "0", HOST: "127.0.0.1", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	const port = new Promise<number>((resolve, reject) => {
		child.stdout!.on("data", (b: Buffer) => {
			out += b.toString();
			const m = out.match(/Listening on http:\/\/[^:]+:(\d+)/);
			if (m) resolve(Number(m[1]));
		});
		child.on("exit", () => reject(new Error(`child exited before listening:\n${out}`)));
	});
	child.stderr!.on("data", (b: Buffer) => (out += b.toString()));
	return { child, out: () => out, port };
}

function exited(child: ChildProcess, ms: number): Promise<number | null> {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(null), ms); // null: still running when we stopped waiting
		child.once("exit", (code) => {
			clearTimeout(t);
			resolve(code);
		});
	});
}

describe("SIGTERM on adapter-node drains the open stream and the queued background work, then exits", () => {
	it("a stream open at SIGTERM finishes every chunk, the background work finishes, and the process exits 0", async () => {
		const { child, out, port } = boot({ SHUTDOWN_TIMEOUT: "10", TEST_BG_MS: "2500" });
		try {
			const res = await fetch(`http://127.0.0.1:${await port}/`);
			const reader = res.body!.getReader();
			let body = new TextDecoder().decode((await reader.read()).value);
			const sentAt = Date.now();
			child.kill("SIGTERM");
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				body += new TextDecoder().decode(value);
			}
			expect(body.trim().split("\n")).toHaveLength(15);
			const code = await exited(child, 15_000);
			expect(code, out()).toBe(0);
			expect(out()).toContain("background-done");
			expect(out()).toMatch(/drained; exiting.*"left":0/);
			expect(Date.now() - sentAt).toBeLessThan(10_000);
		} finally {
			child.kill("SIGKILL");
		}
	}, 30_000);

	it("work outlasting the window is cut off at the window: the process exits 0 instead of waiting for SIGKILL", async () => {
		const { child, out, port } = boot({ SHUTDOWN_TIMEOUT: "1", TEST_BG_MS: "60000" });
		try {
			const res = await fetch(`http://127.0.0.1:${await port}/`);
			await res.text();
			const sentAt = Date.now();
			child.kill("SIGTERM");
			const code = await exited(child, 10_000);
			expect(code, out()).toBe(0);
			expect(out()).toMatch(/drained; exiting.*"left":1/);
			expect(out()).not.toContain("background-done");
			expect(Date.now() - sentAt).toBeLessThan(5_000);
		} finally {
			child.kill("SIGKILL");
		}
	}, 30_000);
});
