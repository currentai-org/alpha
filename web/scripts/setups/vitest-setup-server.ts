import { vi } from "vitest";
import dotenv from "dotenv";
import { resolve } from "path";
import fs from "fs";
import { setInterval as realSetInterval } from "node:timers";
import { Worker } from "node:worker_threads";
import { allKeys } from "../../config/env-manifest.mjs";

// Parse .env for key presence (svelte $env mocks) without treating blank scaffold
// values as intentional empties on process.env. Code that uses `??` / "unset → default"
// (e.g. COOP_BLOCK_ACTION_PREFIX, PG_POOL_MAX) must see undefined, not "".
//
// Vite loads `.env` into process.env before setupFiles run, so blank scaffold keys
// may already be present as "". Delete those; only inject non-empty file values,
// and never overwrite a real value already set by the CI job / shell.
//
// The key list comes from the manifest, which is committed. `.env` is untracked: CI copies the
// generated `.env.ci` there, and a fresh worktree has none, so it only layers values on top.
const envPath = resolve(__dirname, "../../.env");
const envVars: Record<string, string> = {
	...Object.fromEntries(allKeys().map((k: string) => [k, ""])),
	...(fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, "utf-8")) : {}),
};

const publicEnv: Record<string, string> = {};
const privateEnv: Record<string, string> = {};

for (const [key, value] of Object.entries(envVars)) {
	if (key.startsWith("PUBLIC_")) {
		publicEnv[key] = value;
	} else {
		privateEnv[key] = value;
	}
	if (value === "") {
		// Clear Vite-injected empties so `??` / "unset → default" still works.
		// Never wipe a real non-empty value already set by the CI job or shell.
		if (process.env[key] === "") {
			delete process.env[key];
		}
	} else if (!process.env[key]) {
		process.env[key] = value;
	}
}

vi.mock("$env/dynamic/public", () => ({
	env: publicEnv,
}));

// Persistence is Postgres (doc-store adapter). Server tests run against the parsed env.
vi.mock("$env/dynamic/private", () => ({
	env: privateEnv,
}));

/**
 * A fork worker sometimes stops reporting inside a spec and is killed minutes later as
 * "Worker exited unexpectedly", with no test named. A per-test timeout cannot fire while the event
 * loop is blocked, so this watches from another thread instead.
 *
 * The main thread posts a heartbeat every second. When none arrives for `stallMs`, the watcher pauses
 * the main thread through the inspector and writes the paused stack to fd 2 directly, because a
 * worker's `process.stderr` is relayed through the main thread, which is the one that is stuck. A
 * pause that does not land means the thread is blocked in native code, and it says that instead.
 *
 * The heartbeat timer comes from `node:timers`, never the global, so a spec's `vi.useFakeTimers()` does not stop the
 * heartbeat and read as a stall. (SOL-205)
 */
const WATCHER = `
const { parentPort, workerData } = require("node:worker_threads");
const inspector = require("node:inspector");
const fs = require("node:fs");
const { stallMs, label } = workerData;
const write = (s) => fs.writeSync(2, "\\n[blocked-loop-watchdog] " + label + ": " + s + "\\n");
let last = Date.now();
parentPort.on("message", () => { last = Date.now(); });
const tick = setInterval(() => {
	if (Date.now() - last < stallMs) return;
	clearInterval(tick);
	const blockedFor = Date.now() - last;
	const session = new inspector.Session();
	session.connectToMainThread();
	const native = setTimeout(
		() => write("no heartbeat for " + blockedFor + " ms and the inspector could not pause it: blocked in native code"),
		5000
	);
	const urls = new Map();
	session.on("Debugger.scriptParsed", ({ params }) => urls.set(params.scriptId, params.url));
	session.on("Debugger.paused", ({ params }) => {
		clearTimeout(native);
		const frames = params.callFrames
			.map((f) => "    at " + (f.functionName || "<anonymous>") + " (" + (urls.get(f.location.scriptId) || f.url || "?") + ":" + (f.location.lineNumber + 1) + ":" + (f.location.columnNumber + 1) + ")")
			.join("\\n");
		write("no heartbeat for " + blockedFor + " ms; main thread stack:\\n" + frames);
		session.post("Debugger.resume", () => session.post("Debugger.disable", () => session.disconnect()));
	});
	session.post("Debugger.enable", () => session.post("Debugger.pause"));
}, 1000);
`;

const STARTED = Symbol.for("sol-205.blockedLoopWatchdog");

function startBlockedLoopWatchdog(label: string, stallMs = 20_000): void {
	const g = globalThis as Record<symbol, unknown>;
	if (g[STARTED]) return;
	g[STARTED] = true;
	const worker = new Worker(WATCHER, { eval: true, workerData: { stallMs, label } });
	worker.unref();
	const beat = realSetInterval(() => worker.postMessage(0), 1000);
	beat.unref();
}

if (process.env.CI) startBlockedLoopWatchdog(`pid ${process.pid}`);
