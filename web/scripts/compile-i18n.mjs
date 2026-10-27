import { paraglideOptions } from "../paraglide.config.js";

// `prepare` runs this on every install, including `pnpm install --prod`, which leaves out this
// devDependency: the scheduled sign-in probe's install fails without it (SOL-194).
// `--if-installed` lets that one caller skip; check and build still fail loudly without it.
let compile;
try {
	({ compile } = await import("@inlang/paraglide-js"));
} catch (err) {
	if (!process.argv.includes("--if-installed") || err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
	console.log("i18n:compile skipped: @inlang/paraglide-js is not installed (a --prod install)");
	process.exit(0);
}

await compile(paraglideOptions);
