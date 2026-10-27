// Fail a DEPLOY BUILD whose Node has drifted below the pin in .nvmrc — CUR-256.
//
//   node scripts/check-node-pin.mjs
//
// WHY THIS IS ITS OWN BUILD STEP AND NOT A FLAG. It runs in `vercel-build` and nowhere else, because
// `below the pin` only means something where the running Node IS the deploy target's. Its own named
// line in package.json is harder to delete by accident than a `--deploy` flag appended to some other
// script, and a named build step that vanished is visible in a diff.
//
// WHY IT MUST NOT RUN ON A DEV BOX OR IN CI. A dev box below the
// pin is the SAFE direction: a lower Node satisfies fewer `engines.node` floors, so it rejects a
// superset of what the deploy would reject — false positives only, never a false negative. Wiring
// this into `verify:route-configs` (which `ci:local` runs) would block every push from a box on
// 24.13.0 for a condition that could not ship anything broken. In CI the comparison is tautological
// anyway: ci.yml resolves Node from `node-version-file: web/.nvmrc`, so CI equals the pin by
// construction. The pin IS the fix for the CI side; this is the drift alarm for the deploy side, the
// one place the two numbers can diverge without anyone choosing it.
//
// The other host: Jelastic runs `pnpm install` on-node at 26.6.0 via its postDeploy hook
// (scripts/jelastic/vcs-project.sh), not in build-and-publish.sh. As of CUR-444 this runs THERE TOO,
// in front of that install — build-and-publish.sh stages this file, node-pin.mjs and .nvmrc onto the
// node so the hook has something to run. Putting it in build-and-publish.sh instead would compare
// against a dev box, which is the CUR-256 mistake wearing new clothes: it fails in the harmless
// direction while looking like a guard. Lower the pin only if a target ever installs BELOW 24.22.1.
//
// So it now runs on two hosts whose pin file sits at different paths — `web/.nvmrc` in the repo,
// `.nvmrc` beside index.js on the node. It reports the path it actually read rather than a literal,
// because an error naming a file the reader cannot find is most of a wasted debugging session.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareNodePin } from "./node-pin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pinFile = resolve(here, "../.nvmrc");
const pinPath = relative(process.cwd(), pinFile) || pinFile;
const r = compareNodePin(process.version, readFileSync(pinFile, "utf8"));

if (r.verdict === "ok") {
	console.log(`check-node-pin: OK — deploy node ${r.build} matches ${pinPath}.`);
} else if (r.verdict === "stale") {
	// Fail-SAFE direction: CI (at the pin) enforces a stricter floor than this build does, so it
	// rejects a superset. Reported, never failed — failing here would break production the day the
	// host bumps its image, since a push to main deploys unattended.
	console.log(
		`check-node-pin: deploy node ${r.build} is ABOVE ${pinPath} (${r.pin}) — safe, but the pin is stale. Raise it to ${r.build} once every deploy target is at or above that.`
	);
} else if (r.verdict === "below") {
	console.error(
		`check-node-pin: FAIL — deploy node ${r.build} is BELOW ${pinPath} (${r.pin}). CI installs at ${r.pin}, so an engines.node floor between the two passes CI and breaks this deploy (CUR-256). The deploy image moved down: lower the pin to ${r.build} and re-run CI before shipping.`
	);
	process.exit(1);
} else {
	console.error(
		`check-node-pin: FAIL — ${pinPath} is "${r.pin}", not an exact version, so nothing can be compared against deploy node ${r.build}. A floating alias here is the CUR-256 defect itself, and a check that cannot compare is not a check.`
	);
	process.exit(1);
}
