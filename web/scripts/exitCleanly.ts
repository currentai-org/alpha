// Exit a vite-node script without racing Rolldown's native teardown.
//
// Why. `pnpm verify:cleanup` (and its siblings) run under vite-node, which loads Rolldown, a Rust/napi
// native addon. Calling `process.exit()` while Rolldown's threadsafe functions still hold references can
// abort the process after the script has already printed its result:
//
//   Rolldown panicked. This is a bug in Rolldown, not your code.
//     panicked at napi-3.8.2/src/threadsafe_function.rs:831
//   Aborted (core dumped)                 → exit 134
//
// Whether it happens depends on machine load, so a passing check can go red for a reason unrelated to
// what it measures, which trains people to re-run until green.
//
// The fix: set `process.exitCode` and RETURN, letting Node exit naturally once the loop drains — the
// native addon tears itself down in its own time instead of being yanked out from under. The unref'd
// timer is a backstop: if something unexpectedly holds the loop open we still exit with the right code
// rather than hanging CI forever, and because it is unref'd it never itself keeps the process alive.
//
// Not a workaround for our own leak: these scripts already `await closeDb()` before exiting. The live
// references are Rolldown's, not ours.

const FORCE_EXIT_AFTER_MS = 10_000;

/** Finish a script with `code`, allowing native addons to tear down first. Call instead of process.exit. */
export function exitCleanly(code: number): void {
	process.exitCode = code;
	// Backstop only — .unref() so it cannot be the reason the process stays alive.
	setTimeout(() => process.exit(code), FORCE_EXIT_AFTER_MS).unref();
}
