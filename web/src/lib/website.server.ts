// Server-side counterpart of website.ts: the website's data and request hooks, loaded only when its
// files are in the build. Each function returns what "the website is not here" looks like (an empty
// list, null, a no-op) when they are not. Callers keep their own error handling, as they had when
// they imported the modules directly.
import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import type { AlphaLandingContent } from '$lib/alpha-landing/content';
import type { Locale } from '$lib/i18n/locales';

type Fetch = typeof fetch;

async function load<T>(found: Record<string, () => Promise<T>>): Promise<T | undefined> {
	const loader = Object.values(found)[0];
	return loader ? loader() : undefined;
}

type CachedClient = {
	getMaintenanceBannerCached(
		f: Fetch
	): Promise<{ enabled?: boolean | null; message?: string | null }>;
	getPageByPathCached(f: Fetch, path: string[]): Promise<Record<string, unknown> | null>;
};
const cachedClient = import.meta.glob<CachedClient>('/src/lib/payload/cached-client.ts');

/** True when a CMS origin is set. A self-hosted build carries the CMS client but has no CMS to ask. */
const hasCmsOrigin = () => Boolean(env.PUBLIC_CMS_PAYLOAD_URL?.trim());

/** The CMS maintenance banner; off when there is no CMS. */
export async function maintenanceBanner(
	f: Fetch
): Promise<{ enabled?: boolean | null; message?: string | null }> {
	const cms = hasCmsOrigin() ? await load(cachedClient) : undefined;
	return cms ? cms.getMaintenanceBannerCached(f) : { enabled: false };
}

/** The CMS page at `/chat`, which contributes only SEO fields; null when there is no CMS or no page. */
export async function chatLandingSeoPage(f: Fetch): Promise<Record<string, unknown> | null> {
	const cms = hasCmsOrigin() ? await load(cachedClient) : undefined;
	return cms ? cms.getPageByPathCached(f, ['chat']) : null;
}

const client = import.meta.glob<{
	getPageByPath(f: Fetch, path: string[]): Promise<{ title: string; content: unknown } | null>;
}>('/src/lib/payload/client.ts');

/** A CMS page by path segments; null when there is no CMS or no page. */
export async function cmsPage(
	f: Fetch,
	path: string[]
): Promise<{ title: string; content: unknown } | null> {
	const cms = await load(client);
	return cms ? cms.getPageByPath(f, path) : null;
}

const alphaLandingModule = import.meta.glob<{
	getAlphaLandingCached(
		f: Fetch,
		locale: Locale,
		previewSecret?: string
	): Promise<AlphaLandingContent>;
}>('/src/lib/payload/alpha-landing.ts');
const previewModule = import.meta.glob<{
	resolvePreviewSecret(url: URL, cookies: Cookies): string | undefined;
}>('/src/lib/payload/preview.server.ts');

/** The /alpha landing copy from the CMS; undefined means the page uses its built-in copy. */
export async function alphaLandingContent(
	f: Fetch,
	locale: Locale,
	url: URL,
	cookies: Cookies
): Promise<{ content: AlphaLandingContent | undefined; previewSecret: string | undefined }> {
	const [cms, preview] = await Promise.all([load(alphaLandingModule), load(previewModule)]);
	if (!cms) return { content: undefined, previewSecret: undefined };
	const previewSecret = preview?.resolvePreviewSecret(url, cookies);
	return { content: await cms.getAlphaLandingCached(f, locale, previewSecret), previewSecret };
}

const roadmapModule = import.meta.glob<{ ROADMAP_PUBLIC_PRODUCTS: RoadmapOpenGap[] }>(
	'/src/lib/roadmap/roadmapPublic.generated.ts'
);
export type RoadmapOpenGap = {
	id: number;
	name: string;
	emoji: string | null;
	description: string | null;
	status: string | null;
	gaps: string[];
};

/** The roadmap's public products; empty when the roadmap is not part of this build. */
export async function roadmapPublicProducts(): Promise<RoadmapOpenGap[]> {
	return (await load(roadmapModule))?.ROADMAP_PUBLIC_PRODUCTS ?? [];
}

const aliasModule = import.meta.glob<{
	productAliasTarget(slug: string): Promise<string | undefined>;
	orgAliasTarget(slug: string): Promise<string | undefined>;
}>('/src/lib/server/gapMapPayload.ts');

/** The gap map's rename for a product or organization slug; undefined when there is none or no gap map. */
export async function gapMapAliasTarget(
	kind: 'product' | 'org',
	slug: string
): Promise<string | undefined> {
	const map = await load(aliasModule);
	return map
		? kind === 'product'
			? map.productAliasTarget(slug)
			: map.orgAliasTarget(slug)
		: undefined;
}

const redirectsModule = import.meta.glob<{
	lookupCmsRedirect(
		f: Fetch,
		pathname: string
	): Promise<{ location: string; status: 301 | 302 } | null>;
}>('/src/lib/payload/redirects-cached.ts');

/** A CMS-managed redirect for a pathname; null when there is none or no CMS. */
export async function cmsRedirect(f: Fetch, pathname: string) {
	const cms = await load(redirectsModule);
	return cms ? cms.lookupCmsRedirect(f, pathname) : null;
}

const droppedDocModule = import.meta.glob<{
	setDroppedDocSink(sink: (detail: { id: string; issues: unknown }, message: string) => void): void;
}>('/src/lib/payload/log.ts');

const hostServicesModule = import.meta.glob<{
	setSiteHostServices(services: {
		logger?: SiteHostLogger;
		flagEnabledOr?: (key: string, fallback: () => boolean) => boolean;
		onCmsPublish?: (body: unknown) => Promise<void>;
	}): void;
}>('/src/lib/payload/hostServices.ts');

type SiteHostLogFn = (detail: Record<string, unknown>, message: string) => void;
type SiteHostLogger = { info: SiteHostLogFn; warn: SiteHostLogFn; error: SiteHostLogFn };

/**
 * Server start-up for the CMS client: report dropped docs to `sink`, and hand site code the host
 * app's logger and flag reader (payload/hostServices.ts), so site code imports neither from chat. It
 * opens no database connection and starts no timer, on any surface: a publish clears the receiving
 * instance's cache and the others refresh on their TTL.
 */
export async function startCms(
	sink: (detail: { id: string; issues: unknown }, message: string) => void,
	services: {
		logger?: SiteHostLogger;
		flagEnabledOr?: (key: string, fallback: () => boolean) => boolean;
		onCmsPublish?: (body: unknown) => Promise<void>;
	} = {}
): Promise<void> {
	(await load(droppedDocModule))?.setDroppedDocSink(sink);
	(await load(hostServicesModule))?.setSiteHostServices(services);
}

const invalidationKeysModule = import.meta.glob<{
	keysForInvalidation(req: never): (readonly unknown[])[];
}>('/src/lib/payload/invalidationKeys.ts');
// The CMS reads' server cache leaves the build with the website (the public snapshot drops both).
const queryClientModule = import.meta.glob<{
	getServerQueryClient(): {
		invalidateQueries(filters: { queryKey: readonly unknown[] }): Promise<void>;
	};
}>('/src/lib/cache/query-client.ts');

/**
 * Clear this instance's cached CMS reads that a publish (the body Payload sent) changed, such as the
 * maintenance banner chat shows, and return the cache-key prefixes cleared. Nothing to clear, and an
 * empty list, when the website's CMS client is not in the build.
 */
export async function clearCmsReads(body: unknown): Promise<(readonly unknown[])[]> {
	const [keysModule, qcModule] = await Promise.all([
		load(invalidationKeysModule),
		load(queryClientModule)
	]);
	if (!keysModule || !qcModule) return [];
	const keys = keysModule.keysForInvalidation(body as never);
	const qc = qcModule.getServerQueryClient();
	await Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
	return keys;
}

const layoutModule = import.meta.glob<{
	siteLayoutData(event: {
		fetch: Fetch;
		route: { id: string | null };
		locals: App.Locals;
	}): Promise<Record<string, unknown>>;
}>('/src/lib/website/layoutData.ts');

/** The site chrome's data (menus, footer, gap map version); empty when the website is not here. */
export async function siteLayoutData(event: {
	fetch: Fetch;
	route: { id: string | null };
	locals: App.Locals;
}): Promise<Record<string, unknown>> {
	const site = await load(layoutModule);
	return site ? site.siteLayoutData(event) : {};
}
