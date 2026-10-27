// Where a turn went, hop by hop: the app server, the router (when one stood in between), the model
// host, and where the conversation is stored (CUR-4580). Pure and client-safe: it reads only what the
// turn recorded (`routerMetadata`) and one deployment label the server derived (the database's region),
// and it never guesses. A place nobody published reads "location not published"; a fact the turn did not
// record reads "not recorded". Each hop outside Europe carries a tag, so the storage claim can be checked
// against a visitor's own turn.

import type { Message } from "$lib/chat/types/Message";
import { backendOrg, type OrgId } from "$lib/chat/routing/catalog";
import { backendHost, laneVendor } from "$lib/chat/servingProvenance";

export type HopRole = "app" | "router" | "model" | "storage";

export interface Hop {
	role: HopRole;
	/** Who runs this hop, when it is an organisation in `routing/catalog.ts` (rendered with OrgMention). */
	orgId?: OrgId;
	/** Who runs this hop, when it has no catalog entry. Unset when the turn did not say. */
	name?: string;
	/** Where it ran, in words. */
	place: string;
	/** True outside Europe, false inside, unset when the place is unknown. */
	outsideEurope?: boolean;
	/** The recorded value this hop was read from (a region code or a host), so a check can compare it
	 *  with the persisted record. Unset when nothing was recorded. */
	source?: string;
}

const NOT_RECORDED = "not recorded";
const LOCATION_NOT_PUBLISHED = "location not published";

const EUROPE = new Set([
	"Germany",
	"France",
	"Ireland",
	"United Kingdom",
	"Sweden",
	"Switzerland",
	"Poland",
	"Netherlands",
	"Italy",
	"Spain",
	"Finland",
	"Belgium",
	"Austria",
]);

type Place = { city?: string; country: string };

// Vercel's function regions, by the code `VERCEL_REGION` reports (vercel.com/docs/edge-network/regions).
const VERCEL_REGIONS: Record<string, Place> = {
	fra1: { city: "Frankfurt", country: "Germany" },
	cdg1: { city: "Paris", country: "France" },
	dub1: { city: "Dublin", country: "Ireland" },
	lhr1: { city: "London", country: "United Kingdom" },
	arn1: { city: "Stockholm", country: "Sweden" },
	iad1: { city: "Washington, D.C.", country: "United States" },
	cle1: { city: "Cleveland", country: "United States" },
	sfo1: { city: "San Francisco", country: "United States" },
	pdx1: { city: "Portland", country: "United States" },
	gru1: { city: "São Paulo", country: "Brazil" },
	hnd1: { city: "Tokyo", country: "Japan" },
	kix1: { city: "Osaka", country: "Japan" },
	icn1: { city: "Seoul", country: "South Korea" },
	sin1: { country: "Singapore" },
	syd1: { city: "Sydney", country: "Australia" },
	bom1: { city: "Mumbai", country: "India" },
	hkg1: { country: "Hong Kong" },
	cpt1: { city: "Cape Town", country: "South Africa" },
	dxb1: { city: "Dubai", country: "United Arab Emirates" },
};

// The AWS regions Neon offers, by the region segment of its host names.
const AWS_REGIONS: Record<string, Place> = {
	"eu-central-1": { city: "Frankfurt", country: "Germany" },
	"eu-west-2": { city: "London", country: "United Kingdom" },
	"us-east-1": { city: "Northern Virginia", country: "United States" },
	"us-east-2": { city: "Ohio", country: "United States" },
	"us-west-2": { city: "Oregon", country: "United States" },
	"ap-southeast-1": { country: "Singapore" },
	"ap-southeast-2": { city: "Sydney", country: "Australia" },
	"sa-east-1": { city: "São Paulo", country: "Brazil" },
};

// Routers and gateways a turn can be sent to. None of their operators publishes where the service runs,
// so each reads "location not published" until one does (plan Part A, decision 4).
const ROUTERS: Record<string, { orgId?: OrgId; name: string }> = {
	"router.stg.aipotluck.org": { name: "Potluck's model router" },
	"api-internal.publicai.co": { name: "Public AI's inference gateway" },
	"router.huggingface.co": { orgId: "huggingface", name: "Hugging Face's router" },
	"develop.aipotluck.org": { name: "a preview environment's adapter" },
};

function placeWords(p: Place): string {
	return p.city ? `${p.city}, ${p.country}` : p.country;
}

function placed(p: Place | undefined): Pick<Hop, "place" | "outsideEurope"> {
	return p ? { place: placeWords(p), outsideEurope: !EUROPE.has(p.country) } : { place: LOCATION_NOT_PUBLISHED };
}

/**
 * The region label of a Postgres connection string's host, e.g. `eu-central-1` for a Neon host
 * `ep-….eu-central-1.aws.neon.tech`. Server-side only: the caller passes `DATABASE_URL` and ships the
 * label alone. Undefined for any host that carries no region (a local database, another provider).
 */
export function storageRegionLabel(connectionString?: string): string | undefined {
	if (!connectionString) return undefined;
	let host: string;
	try {
		host = new URL(connectionString).hostname;
	} catch {
		return undefined;
	}
	return /\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/.exec(host)?.[1];
}

/** A hop placed by a region code: the app server (a Vercel region) or storage (an AWS region). An
 *  unrecorded code says so; a code missing from the table names the code rather than a place. */
function regionHop(
	role: "app" | "storage",
	name: string,
	regions: Record<string, Place>,
	provider: string,
	code?: string
): Hop {
	if (!code) return { role, name, place: NOT_RECORDED };
	const region = regions[code];
	return { role, name, ...(region ? placed(region) : { place: `${provider} region ${code}` }), source: code };
}

function modelHop(lane: string | undefined, backend: string | undefined): Hop {
	const host = backendHost(backend);
	if (host) {
		// The catalog's host table names the org and its country (CUR-4587).
		const known = backendOrg(host);
		return {
			role: "model",
			orgId: known?.org.id,
			name: known?.name,
			...(known?.country ? placed({ country: known.country }) : { place: LOCATION_NOT_PUBLISHED }),
			source: host,
		};
	}
	const vendor = laneVendor(lane);
	if (vendor) {
		return {
			role: "model",
			orgId: lane ? backendOrg(lane)?.org.id : undefined,
			name: vendor.label,
			...placed({ country: vendor.country }),
			source: lane,
		};
	}
	return { role: "model", place: NOT_RECORDED };
}

/** The router hop, when the turn was sent to a host other than the one that answered. A vendor lane is
 *  the model host itself, so it has none: a router.stg turn always does (CUR-4577). */
function routerHop(lane: string | undefined, backend: string | undefined): Hop | undefined {
	if (!lane || laneVendor(lane)) return undefined;
	if (lane === backendHost(backend)) return undefined;
	const known = ROUTERS[lane];
	return {
		role: "router",
		orgId: known?.orgId,
		name: known?.name ?? "a model router",
		place: LOCATION_NOT_PUBLISHED,
		source: lane,
	};
}

/**
 * The hops a turn's message went through, in order: app server, router (only when one stood between
 * the app and the model), model host, storage. `storageRegion` is the deployment's database region
 * label, from `storageRegionLabel` on the server.
 */
export function routeFor(message: Message | undefined, storageRegion?: string): Hop[] {
	const rm = message?.routerMetadata;
	const router = routerHop(rm?.lane, rm?.backend);
	return [
		regionHop("app", "Vercel", VERCEL_REGIONS, "Vercel", rm?.appRegion),
		...(router ? [router] : []),
		modelHop(rm?.lane, rm?.backend),
		regionHop("storage", "Neon", AWS_REGIONS, "AWS", storageRegion),
	];
}
