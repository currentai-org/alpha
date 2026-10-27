// Which models each site's picker offers. Kept apart from inference.ts so client code (the /alpha
// demo) can read the lists without bundling zod; inference.ts re-exports everything here.

import servedAs from "./served-as.json" with { type: "json" };

/**
 * A deployment whose picker differs. Every preview deploy is `develop`; www is `production`; an event
 * instance (INSTANCE on its own Vercel project, CUR-3156) is its own site.
 */
export const pickerSites = ["develop", "production", "mozfest", "lugano"] as const;
export type PickerSite = (typeof pickerSites)[number];

// What www offers. Apertus 1.5 70B Thinking is absent because the gateway no longer serves it
// (CUR-3539). The SEA-LION v4 models are off on every site because a request that gets no
// first chunk from their upstream leaves a visitor waiting 20-45 s for a backup's answer (CUR-3870);
// SEA-LION v4.8 (Nemotron) is not one of them and stays.
// Mistral Medium 3.5 leads every site's list, and so is the default (CUR-4002): through the staging
// router it has the account's highest rate limit, which www, develop and CI all share.
// Mistral Large 4 sits second, so a stage demo can pick it by hand while Medium stays the default
// (CUR-4281). Its lane needs `mistral-large-2610` in each prd config's MISTRAL_MODELS.
// Mistral Large 3 (`mistral-large-2512`) is on no site's picker: Large 4 replaces it, and Medium is
// Large 4's only stand-in (CUR-4683).
const PRODUCTION_PICKER = [
	"mistral-medium-2604",
	"mistral-large-2610",
	"swiss-ai/apertus-v1.5-70b",
	"aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B",
	"BSC-LT/ALIA-40b-instruct",
	"speakleash/Bielik-11B-v3.0-Instruct",
	"zai-org/GLM-5.2",
] as const;

/** A model taken off every site's picker for a while, kept in the lists below so restoring it is one deletion. */
type Withdrawal = { model: string; ticket: string; until: string; why: string; specTag: string };

/**
 * Models off every site's picker. Delete an entry to bring the model back. `until` is the date
 * someone decides again: past it, pickerWithdrawn.spec.ts puts a warning on the unit job, so a withdrawal
 * cannot outlive the reason for it unnoticed. While a model is here, specs tagged with its `specTag` stay out of the
 * scenario run (e2e/playwright.config.ts), and they come back with the model.
 */
export const WITHDRAWN: readonly Withdrawal[] = [];

const withdrawn = new Set(WITHDRAWN.map((w) => w.model));
const offered = (ids: readonly string[]) => ids.filter((id) => !withdrawn.has(id));

/**
 * Which models each site's picker offers before WITHDRAWN, first entry the default. A change here is a
 * PR, reviewed and gated (CUR-3484). On a Vercel
 * deployment PICKER below wins over MODEL_ALLOWLIST; off Vercel (local dev, CI, evals) MODEL_ALLOWLIST
 * still overrides it. Only the /alpha demo reads this list directly: its answers are recordings, so no
 * upstream model call is involved.
 */
export const PICKER_BEFORE_WITHDRAWALS: Readonly<Record<PickerSite, readonly string[]>> = {
	develop: [
		"mistral-medium-2604",
		"mistral-large-2610",
		"swiss-ai/apertus-v1.5-70b",
		"aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B",
		"BSC-LT/ALIA-40b-instruct",
		"speakleash/Bielik-11B-v3.0-Instruct",
		"zai-org/GLM-5.2",
	],
	production: PRODUCTION_PICKER,
	mozfest: PRODUCTION_PICKER,
	lugano: PRODUCTION_PICKER,
};

/** Each site's picker less WITHDRAWN. Everything that serves or offers a model reads this one. */
export const PICKER: Readonly<Record<PickerSite, readonly string[]>> = {
	develop: offered(PICKER_BEFORE_WITHDRAWALS.develop),
	production: offered(PICKER_BEFORE_WITHDRAWALS.production),
	mozfest: offered(PICKER_BEFORE_WITHDRAWALS.mozfest),
	lugano: offered(PICKER_BEFORE_WITHDRAWALS.lugano),
};

/**
 * Other names a router reports for a model id when another host serves the same weights. The staging
 * router answers Mistral Medium 3.5 from Scaleway as well as from Mistral, and Scaleway's copy reports
 * `mistral-medium-3.5-128b` (CUR-4343). A served-model check reads a listed name as the model it asked
 * for, and any other name as a different model. The table is JSON so the Python evaluation refresh
 * (refresh_eval_answers.py `served_matches`) reads the same one.
 */
const SERVED_AS: Readonly<Record<string, readonly string[]>> = servedAs;

/**
 * An id as a served-model check compares it: no `:provider` pin (a response never echoes it), no org
 * prefix (a router may send `mistralai/mistral-medium-2604` for our `mistral-medium-2604`), lower case.
 */
const servedKey = (id: string) => id.split(":")[0].trim().toLowerCase().split("/").pop() ?? "";

/** The model id a SERVED_AS name stands for, so a lookup keyed on our ids finds a host's own name. */
export function modelIdServedAs(served: string): string | undefined {
	const got = servedKey(served);
	return Object.entries(SERVED_AS).find(([, aliases]) => aliases.some((a) => servedKey(a) === got))?.[0];
}

/** Whether `served` names the model `requested` asked for, either by its own id or a SERVED_AS name. */
export function sameServedModel(requested: string, served: string): boolean {
	const want = servedKey(requested);
	const got = servedKey(served);
	if (want === got) return true;
	const aliases = Object.entries(SERVED_AS).find(([id]) => servedKey(id) === want)?.[1] ?? [];
	return aliases.some((a) => servedKey(a) === got);
}
