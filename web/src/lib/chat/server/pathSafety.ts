// Rejects a `/`-joined path built from an untrusted source (a SvelteKit `[...rest]` param, a request
// body field) that could traverse outside the directory it's meant to stay inside. Pulled out as its
// own small, directly-testable function rather than left inline in a route handler, so the check is
// isolated from the rest of the handler. It prevents the agent-artifact-download route building an
// outbound fetch URL straight from an unvalidated filename (CUR-546).
//
// An empty segment (a leading/trailing/doubled `/`) is rejected too, not just `.`/`..` — it's
// malformed input either way, and folding it in here means callers don't need a second check.
export function hasUnsafePathSegment(path: string): boolean {
	return path.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}
