// Compare the Node a build is running on against the pin in `.nvmrc` (CUR-256).
//
// WHY THE PIN IS EXACT. `web/.npmrc` sets engine-strict=true, so an `engines.node` floor is enforced
// in CI and at deploy, but only agrees between them when both run the same version. A floating
// `.nvmrc` alias (`lts/krypton`) resolves in CI to the newest release, which can sit above the host's
// build image: a dependency whose `engines.node` floor falls between the two installs cleanly in CI
// and fails at deploy. With CI the newer of the two, CI is STRUCTURALLY unable to see a constraint
// that breaks the deploy.
//
// WHICH DIRECTION IS THE HAZARD. Only one. A build node BELOW the pin means the install that ships
// was validated against something newer, so an `engines.node` floor between the two installs
// cleanly in CI and fails the deploy. A build node ABOVE the pin is the fail-safe
// direction: CI enforces a stricter floor than the deploy target, rejecting a superset. It is stale,
// not dangerous, and it is reported without failing. Failing there would break production the day
// the host bumps its image, since a push to main deploys unattended.
//
// WHAT THIS DOES NOT CATCH, stated plainly. An `engines.node` UPPER bound (`>=20 <25`) inverts the
// argument: a lower CI node installs it happily and a higher deploy node rejects it. Nothing here
// sees that, and pinning to the LOWEST deploy target cannot. Upper bounds are rare enough that the
// floor case is worth fixing on its own; it is not a claim of coverage.

/** `24.15.0` → [24,15,0]. Anything not exactly three numeric parts is not a pin. */
export function parsePin(text) {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? "").trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	return 0;
}

/**
 * @returns {{verdict: "ok"|"below"|"stale"|"unpinned", build: string, pin: string}}
 *   `below`    — build node is older than the pin. THE BUG. Callers must exit non-zero.
 *   `stale`    — build node is newer than the pin. Safe direction; report, do not fail.
 *   `unpinned` — `.nvmrc` is not an exact version (e.g. still `lts/krypton`), so there is nothing to
 *                compare against. This is the original defect wearing its original clothes, so it
 *                counts as a failure rather than a skip — a check that cannot compare is not a check.
 */
export function compareNodePin(buildVersion, pinText) {
	const build = parsePin(buildVersion);
	const pin = parsePin(pinText);
	const shown = { build: String(buildVersion ?? "").trim(), pin: String(pinText ?? "").trim() };
	if (!pin || !build) return { verdict: "unpinned", ...shown };
	const c = cmp(build, pin);
	return { verdict: c < 0 ? "below" : c > 0 ? "stale" : "ok", ...shown };
}
