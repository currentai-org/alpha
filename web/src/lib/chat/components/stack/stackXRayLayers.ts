// Derives Stack X-Ray rows from roadmap provenance products + per-turn touch state.

import type { Message } from "$lib/chat/types/Message";
import { provenanceFacts } from "$lib/chat/utils/trace/provenanceFacts";
import { PROVENANCE_PRODUCTS } from "./provenanceProducts.generated";
import type { ProvenanceProductStatus } from "./provenanceProducts.generated";
import { provenanceTouch } from "./provenanceTouch";
import { formatProductAttribution } from "./provenanceProductLine";
import { entityBases } from "$lib/website";
import { resolveModelIdentity } from "$lib/chat/identity";
import { backendHost, laneVendor, publicModelPage } from "$lib/chat/servingProvenance";
import { backendOrg } from "$lib/chat/routing/catalog";

export interface StackXRayLayer {
	name: string;
	label: string;
	emoji: string;
	partner: string;
	partnerLink?: string;
	/** A page of ours about this part, shown as its own link so the maker's name keeps pointing at
	 *  the maker (CUR-1745). */
	ownLink?: { href: string; label: string };
	osProduct?: string;
	osProductUrl?: string;
	productAttribution?: string;
	desc: string;
	touched: boolean;
	status: ProvenanceProductStatus;
	provenance?: string;
	provenanceLinks?: { label: string; url: string }[];
	location?: string;
	/** Where "See on the gap map" goes: the product's own catalog page, or the map when the row
	 *  names nothing in the catalog. Absent when the gap map is not part of this build. */
	mapHref?: string;
	/**
	 * Per-user reachability, for a product ALSO gated by a per-request feature flag (CUR-1447) —
	 * `undefined` for every product not behind one, which is every product except the one(s) named in
	 * `FLAG_GATED_PRODUCTS` below. Where it applies, `status: "building"` alone can't distinguish "not
	 * built yet" from "built, but not for you": a visitor without agent-mode access saw the exact same
	 * `agent-service` row as one with it. This field is what StackXRayLayerCard renders as
	 * present-and-unavailable instead of a silent absence.
	 */
	available?: boolean;
	/** The maker's own platform, when it served this answer directly and so stood in for this row
	 *  (CUR-3966). Without it a skipped row reads like a part that sat idle while something unnamed ran
	 *  the model. */
	bypassedBy?: string;
	/** The answer recorded nothing that says whether this row took part: no backend, so no reading
	 *  either way (CUR-3966). Shown as unmeasured, never as "not used". */
	unreported?: boolean;
	/** Built and running elsewhere, but no model this app offers is served on it (CUR-4328). Before an
	 *  answer it reads as not in use rather than as working. */
	idle?: boolean;
}

/** Our own page about a part, linked beside the maker's name rather than in place of it. */
const OWN_LINKS: Record<string, { href: string; label: string }> = {
	"trust-and-safety": { href: "/trust-and-safety", label: "Our Trust & Safety policy" },
};

/**
 * Options carrying per-request flag state resolved server-side (layoutData.ts's `agentEnabled`,
 * itself `agentModeEnabledForUser(locals)`) — deliberately a plain boolean prop, not a flag read in
 * this module or in StackXRay.svelte. Availability is a per-user, per-request fact; only the caller
 * that has `locals` can answer it, and passing the resolved value keeps this module free of any
 * dependency on the server flag/PostHog stack, in either direction.
 */
export interface StackXRayAvailability {
	agentAvailable?: boolean;
	/** The `auto-routing` flag as layoutData.ts resolved it: Auto is this app's model chooser. */
	autoAvailable?: boolean;
}

/** X-ray's chips read the roadmap's ecosystem status as a claim about this app, which is wrong for
 *  two rows (CUR-4328). Auto already chooses the model, though the roadmap still lists a chooser as
 *  being built. The public computers exist, but no model offered on any deployment is served from
 *  them (`pnpm models:matrix`; prod answers by backend host). So before an answer that row says it is not
 *  in use, where "Working" claimed a part nothing ran on. A turn that reaches Swiss compute still
 *  lights it as used. Drop this when a Swiss-served model returns to the picker. */
const MODEL_CHOOSER_ROW = "model-router";
const COMPUTE_ROW_IDLE = true;

/** Products additionally gated by a feature flag, mapped to the field in StackXRayAvailability that
 *  resolves it. Every product not listed here is available whenever its `status` says so — most of
 *  the roadmap's declared set isn't behind a per-user flag at all. */
const FLAG_GATED_PRODUCTS: Partial<Record<string, keyof StackXRayAvailability>> = {
	"agent-service": "agentAvailable",
};

/** The roadmap names our own products by their production URL ("https://aipotluck.org/chat"). On a
 *  preview or local build that link would leave for production, so it becomes a path on whatever
 *  origin is serving the page. Every other URL passes through unchanged. */
function sameSiteAsPath(url: string | null | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		if (parsed.hostname === "aipotluck.org" || parsed.hostname === "www.aipotluck.org") {
			return `${parsed.pathname}${parsed.search}${parsed.hash}`;
		}
	} catch {
		// not an absolute URL — leave it as the roadmap wrote it
	}
	return url;
}

function partnerLink(product: (typeof PROVENANCE_PRODUCTS)[number]): string | undefined {
	return product.maintainers_url[0] ?? sameSiteAsPath(product.os_product_url);
}

/** Rows that stand between the app and the model: the gateway, the router behind it, the serving
 *  engine, the metering layer and the public compute. An answer from a maker's own API (a `vendor`
 *  host, CUR-2274) passed through none of them, so none of them lights (CUR-2287). */
const INTERMEDIARY_ROWS = new Set([
	"inference-platform",
	"compute-router",
	"inference-engine",
	"api-management",
	"sovereign-compute",
]);

const MODEL_ROW = "foundation-model";
const COMPUTE_ROW = "sovereign-compute";

/**
 * The model row as the served model, when that model is not the Apertus the roadmap row describes.
 * The roadmap's copy (maker, description, links) is Apertus's own, so none of it carries over: the row
 * names the served model and its maker, and links the public card only when there is one (CUR-2287).
 */
function servedModelRow(layer: StackXRayLayer, servedModelId: string): StackXRayLayer {
	const identity = resolveModelIdentity(servedModelId);
	const card = publicModelPage(servedModelId);
	return {
		...layer,
		osProduct: identity.short,
		osProductUrl: card,
		partner: identity.maker,
		partnerLink: undefined,
		productAttribution: layer.touched ? `${identity.short} by ${identity.maker}` : undefined,
		provenance: layer.touched ? `${identity.short}, ${identity.openness}, by ${identity.maker}.` : undefined,
		provenanceLinks: layer.touched && card ? [{ label: "HuggingFace", url: card }] : undefined,
		mapHref: entityBases && `${entityBases.product}/stack/${MODEL_ROW}?model=${encodeURIComponent(identity.short)}`,
	};
}

/** The roadmap's compute row is CSCS's. A turn served by another host names that host's catalog org
 *  (`BACKEND_HOSTS`, CUR-4587). */
const ROADMAP_COMPUTE_ORG = "cscs";

/**
 * The compute row as the Swiss host that served the turn, when that host is not CSCS. The roadmap's
 * copy ("hosted by CSCS in Lugano") is CSCS's own, so none of it carries over (CUR-1883).
 */
function servedComputeRow(layer: StackXRayLayer, backend: string | undefined): StackXRayLayer {
	const host = backendHost(backend);
	const known = host ? backendOrg(host) : undefined;
	if (!layer.touched || !host || known?.org.id === ROADMAP_COMPUTE_ORG) return layer;
	const name = known?.name ?? host;
	const url = known?.org.url;
	return {
		...layer,
		osProduct: name,
		osProductUrl: url,
		partner: name,
		partnerLink: url,
		productAttribution: name,
		provenance: `Sovereign compute, hosted by ${name} in Switzerland.`,
		provenanceLinks: url ? [{ label: name, url }] : undefined,
		location: "Switzerland",
	};
}

/** One row per display_in_provenance product, in sheet id order. */
export function deriveStackXRayLayers(
	message: Message | undefined,
	availability: StackXRayAvailability = {}
): StackXRayLayer[] {
	const facts = message ? provenanceFacts(message) : undefined;
	// What actually answered, as the endpoint recorded it (CUR-2283). Unset on turns persisted before
	// direct lanes recorded it, which keep the roadmap rows as they were.
	const servedModelId = message?.routerMetadata?.model || undefined;
	const servedOther = !!servedModelId && !/apertus/i.test(resolveModelIdentity(servedModelId).short);
	// Direct only when the host we SENT to is the maker's own API (CUR-4577). The backend is the
	// vendor's host on a router turn too, so reading it would call a router turn "served directly".
	const vendor = laneVendor(message?.routerMetadata?.lane);
	const direct = !!vendor;
	const ranModel = !!facts?.answered && !facts.servedFromCache;
	const backendRecorded = !!message?.routerMetadata?.backend;

	return PROVENANCE_PRODUCTS.map((product) => {
		const isChooser = product.name === MODEL_CHOOSER_ROW && !!availability.autoAvailable;
		const touched = isChooser
			? ranModel && !!message?.autoRoute
			: facts && !(direct && INTERMEDIARY_ROWS.has(product.name))
				? provenanceTouch(product.name, facts)
				: false;
		const status: ProvenanceProductStatus = isChooser ? "live" : product.status;
		const provenance = product.os_product_description ?? undefined;
		const provenanceLinks = product.os_product_links.length ? product.os_product_links : undefined;
		const osProduct = product.os_product?.trim() || undefined;
		const productAttribution = touched ? formatProductAttribution(product) : undefined;
		const availabilityField = FLAG_GATED_PRODUCTS[product.name];
		// Fail-closed when the caller didn't pass the flag's resolved value at all — same posture as
		// agent-mode-access's own documented default (flagKeys.ts): "a per-person gate that cannot
		// reach PostHog must not guess that the person is allowed".
		const available = availabilityField ? (availability[availabilityField] ?? false) : undefined;

		const layer: StackXRayLayer = {
			name: product.name,
			label: product.name,
			emoji: product.emoji,
			partner: product.maintainers[0] ?? "",
			partnerLink: partnerLink(product),
			ownLink: OWN_LINKS[product.name],
			osProduct,
			osProductUrl: sameSiteAsPath(product.os_product_url),
			productAttribution,
			desc: product.description ?? "",
			touched,
			status,
			provenance: touched ? provenance : undefined,
			provenanceLinks: touched ? provenanceLinks : undefined,
			location: product.location,
			// Resolved on click against the gap map database; lands on /map when nothing matches.
			mapHref: entityBases && `${entityBases.product}/stack/${encodeURIComponent(product.name)}`,
			available,
			bypassedBy:
				ranModel && vendor && INTERMEDIARY_ROWS.has(product.name)
					? `${vendor.label} in ${vendor.country}`
					: undefined,
			unreported: ranModel && !backendRecorded && product.name === COMPUTE_ROW ? true : undefined,
			idle: product.name === COMPUTE_ROW && COMPUTE_ROW_IDLE ? true : undefined,
		};
		if (product.name === COMPUTE_ROW) return servedComputeRow(layer, message?.routerMetadata?.backend);
		return product.name === MODEL_ROW && servedOther && servedModelId
			? servedModelRow(layer, servedModelId)
			: layer;
	});
}
