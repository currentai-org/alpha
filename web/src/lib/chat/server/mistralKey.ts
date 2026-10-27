// Which La Plateforme key a deployment bills. A preview built from a per-ticket branch is driven almost
// entirely by CI's scenario suite, which makes most of the preview Mistral calls. Mistral
// limits a whole workspace, so those branches bill MISTRAL_API_KEY_CI, a key in a second workspace, and the
// integration branches keep MISTRAL_API_KEY and its limit to themselves. Unset, per-ticket previews take the router lane like develop.
import { config } from "$lib/chat/server/config";
import refs from "../../../../scripts/lib/integration-refs.json";

const INTEGRATION_REFS = new Set<string>([refs.production, ...refs.staging]);

// A preview built from a per-ticket branch: not production, not develop, and known at all.
function isTicketBranch(branch = process.env.VERCEL_GIT_COMMIT_REF ?? ""): boolean {
	return Boolean(branch) && !INTEGRATION_REFS.has(branch);
}

export function mistralKeyEnv(
	branch = process.env.VERCEL_GIT_COMMIT_REF ?? ""
): "MISTRAL_API_KEY" | "MISTRAL_API_KEY_CI" {
	const ci = (Reflect.get(config, "MISTRAL_API_KEY_CI") as string | undefined) ?? "";
	return ci && isTicketBranch(branch) ? "MISTRAL_API_KEY_CI" : "MISTRAL_API_KEY";
}

// The default chat model on a per-ticket preview is TASK_MODEL (Mistral Small on preview), not the
// picker's first entry, which costs several times Small's price per token. Nearly all of those turns are the scenario suite's, and every spec reads the
// default from /chat/api/v2/models or pins the model it tests (helpers/servedModel.ts), so the suite
// follows. Develop and production keep the picker's order, and with it the model every eval grades.
// Nothing else is added, so a model in MISTRAL_MODELS that no site offers stays off the picker (CUR-4683).
export function ticketBranchAllowlist(
	spec: string,
	branch = process.env.VERCEL_GIT_COMMIT_REF ?? "",
	taskModel = ((Reflect.get(config, "TASK_MODEL") as string | undefined) ?? "").trim()
): string {
	if (!taskModel || !isTicketBranch(branch) || ["*", "all"].includes(spec.toLowerCase())) return spec;
	const rest = spec
		.split(",")
		.map((s) => s.trim())
		.filter((id) => id && id !== taskModel);
	return [taskModel, ...rest].join(",");
}

function mistralApiKey(branch?: string): string {
	return (Reflect.get(config, mistralKeyEnv(branch)) as string | undefined) ?? "";
}

/** Where chat's Mistral models are sent: the host, its key, and the env var that key came from. */
export interface MistralChatLane {
	baseURL: string;
	apiKey: string;
	keyEnv: string;
	/** Our model id → the id this host knows it by, for a host that names them differently. */
	wireIds: Record<string, string>;
}

/**
 * Chat's Mistral lane: the staging router when MISTRAL_CHAT_BASE_URL and MISTRAL_CHAT_API_KEY are
 * both set (CUR-2928), otherwise La Plateforme on MISTRAL_BASE_URL. Every caller that sends a turn or a
 * probe to a Mistral model reads its host and key here, so unsetting MISTRAL_API_KEY where the router
 * is configured takes La Plateforme out of the path entirely (CUR-3193).
 *
 * @remarks
 * A per-ticket preview stays on La Plateforme only while MISTRAL_API_KEY_CI is set, so CI's scenario
 * suite can spend its own workspace rather than the router's limit (CUR-2716). With it unset, those
 * previews share the router lane and its key.
 */
export function mistralChatLane(branch = process.env.VERCEL_GIT_COMMIT_REF ?? ""): MistralChatLane {
	const env = (key: string) => ((Reflect.get(config, key) as string | undefined) ?? "").trim();
	const routerURL = env("MISTRAL_CHAT_BASE_URL");
	const routerKey = env("MISTRAL_CHAT_API_KEY");
	if (routerURL && routerKey && mistralKeyEnv(branch) !== "MISTRAL_API_KEY_CI") {
		return {
			baseURL: routerURL,
			apiKey: routerKey,
			keyEnv: "MISTRAL_CHAT_API_KEY",
			wireIds: parseWireIds(env("MISTRAL_CHAT_MODEL_MAP")),
		};
	}
	return {
		baseURL: env("MISTRAL_BASE_URL"),
		apiKey: mistralApiKey(branch),
		keyEnv: mistralKeyEnv(branch),
		wireIds: { ...PLATEFORME_WIRE_IDS },
	};
}

/**
 * La Plateforme itself, for the one read only Mistral's own API answers: its model list with each
 * model's aliases (`mistralVersions.ts`). Null when no La Plateforme key is set, which leaves an
 * answer's dated version unverified rather than failing the turn (CUR-3193).
 */
export function mistralPlateforme(branch?: string): { baseURL: string; apiKey: string } | null {
	const baseURL = ((Reflect.get(config, "MISTRAL_BASE_URL") as string | undefined) ?? "").trim().replace(/\/+$/, "");
	const apiKey = mistralApiKey(branch).trim();
	return baseURL && apiKey ? { baseURL, apiKey } : null;
}

/**
 * Our ids that La Plateforme names differently. Large 4 (preview) is `mistral-large-2610` on the
 * router and here, and `mistral-large-4-0` on La Plateforme, which lists no 2610 id (`/v1/models`), so sending ours unmapped fails every turn over to the backup (CUR-3027).
 */
const PLATEFORME_WIRE_IDS: Readonly<Record<string, string>> = Object.freeze({
	"mistral-large-2610": "mistral-large-4-0",
});

/** `ours=theirs,ours=theirs` → a map. A pair missing either side is skipped. */
export function parseWireIds(raw: string): Record<string, string> {
	const ids: Record<string, string> = {};
	for (const pair of raw.split(",")) {
		const [ours, theirs] = pair.split("=").map((s) => s?.trim() ?? "");
		if (ours && theirs) ids[ours] = theirs;
	}
	return ids;
}
