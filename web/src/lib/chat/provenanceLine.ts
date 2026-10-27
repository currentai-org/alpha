// The one-line provenance for an answer: what model ran, who made it, and which provider and compute
// served THIS request. Written out as the answer footer's title, so a hover (and a test) can read the
// whole record the footer abbreviates to "maker · model". CLIENT-SAFE, like identity.ts.

import { providerDisplay, resolveModelIdentity } from "./identity";
import { backendOrg, type Org } from "./routing/catalog";
import { backendDisplay, backendHost } from "./servingProvenance";

/**
 * Where THIS answer ran, from its routing record (CUR-2921): the backend host's catalogue organisation
 * (`BACKEND_HOSTS`, CUR-4587) when there is one, else the provider the router reported. Undefined when
 * the record names neither, and the caller then says so (CUR-3562). The catalogue's planned host is a
 * forecast, and a direct lane or a fallback can serve the turn somewhere else.
 */
export function ranOn(backend?: string, provider?: string): { label: string; org?: Org } | undefined {
	const known = backendOrg(backendHost(backend));
	if (known) return { label: known.label, org: known.org };
	const via = providerDisplay(provider);
	return via ? { label: via } : undefined;
}

/** "" | "execution" | "judge" | "execution+judge" from agent-service (CUR-756). CUR-4055: these name
 *  the checks the pipeline RAN, not a verdict that the answer is right. An auto-derived check only ever
 *  confirms the file exists and has the asked-for shape — it cannot read whether the content is what the
 *  task wanted — so the word "verified" overclaimed. The footer now describes the process and leaves the
 *  correctness judgement to the reader; a turn that ran no check shows nothing rather than "unverified". */
const VERIFY_LABELS: Record<string, string> = {
	"": "",
	execution: "checks run: execution",
	judge: "checks run: reviewer model",
	"execution+judge": "checks run: execution + reviewer model",
};

export function provenanceLine(turn: {
	modelId: string;
	backup?: boolean;
	provider?: string;
	backend?: string;
	verifyMethod?: string;
}): string {
	const identity = resolveModelIdentity(turn.modelId);
	const compute = backendDisplay(turn.backend);
	const via = providerDisplay(turn.provider);
	const verify =
		turn.verifyMethod !== undefined ? (VERIFY_LABELS[turn.verifyMethod] ?? turn.verifyMethod) : undefined;
	return [
		`${identity.short}${turn.backup ? " (backup — served in place of the primary model)" : ""}`,
		identity.maker,
		identity.openness,
		identity.served ? `served model: ${identity.served}` : undefined,
		via ? `served via ${via}` : undefined,
		compute ? `compute: ${compute}` : undefined,
		via || compute ? undefined : "host not recorded",
		verify,
	]
		.filter(Boolean)
		.join(" · ");
}
