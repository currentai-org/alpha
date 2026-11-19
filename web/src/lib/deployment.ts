/**
 * The installation's own identity: the hosts it serves on, the names it sends in outbound
 * User-Agent headers, and the addresses and publisher it states. Code that redirects between a
 * site and a chat host, scopes a cookie, or names its operator reads it from here.
 *
 * vite.config.ts reads the values at build time from the JSON file DEPLOYMENT_CONFIG names (default
 * `config/deployment.json`, relative to `web/`) and inlines them, so the server and client bundles
 * agree. Each key the file leaves out, and every key when there is no file, takes the neutral
 * default below: no host of its own, so a single-host install redirects nowhere else and pins no
 * cookie or passkey to a domain. A script run outside Vite gets the defaults too.
 *
 * Free of imports, like surface.ts, so hooks, analytics and the chat and site halves can all read it.
 */
export type Deployment = {
	/** Registrable domain all of this installation's hosts sit under. Pins the passkey RP ID on
	 *  production and the scope legacy cookies are expired on. Null: each host stands alone. */
	apexDomain: string | null;
	/** The site's production host, which a chat-surface deployment sends site pages to. */
	siteHost: string | null;
	/** The site's develop host, paired with the chat develop host. */
	siteDevelopHost: string | null;
	/** Chat's production host on a split site/chat installation. */
	chatHost: string | null;
	/** Chat's develop host, paired with the site develop host. */
	chatDevelopHost: string | null;
	/** Older chat hosts; each one 308s to chatHost. */
	chatAliasHosts: string[];
	/** Origins besides the CMS itself that pages may load images from (a CMS media CDN). Read by
	 *  svelte.config.js for the CSP. */
	mediaOrigins: string[];
	/** better-auth origin patterns for this installation's own preview deployments, trusted on a
	 *  preview build only. Empty: none. */
	previewTrustedOrigins: string[];
	/** The model router this installation runs, labelled by name rather than hostname in the UI. */
	modelRouterHost: string | null;
	/** The Better Stack status page the chat's incident banner reads, unless STATUS_PAGE_URL names one. */
	statusPageUrl: string | null;
	/** Product token sent as the User-Agent on outbound API calls. */
	userAgent: string;
	/** Product token for crawler-style fetches (search APIs, source pages), before the contact. */
	crawlerAgent: string;
	/** Address a polite API asks crawlers to give (OpenAlex `mailto`, User-Agent contact). */
	contactEmail: string | null;
	/** Sender of sign-in and notice email, as `Name <address>`. */
	mailFrom: string | null;
	/** Name an exported conversation says it came from. */
	sourceName: string;
	/** The organization the chat page's structured data names as its publisher. Null: none. */
	publisher: Publisher | null;
};

type Publisher = {
	name: string;
	url: string;
	email?: string;
	address?: {
		streetAddress: string;
		postalCode: string;
		addressLocality: string;
		addressCountry: string;
	};
	contactPoints?: { email: string; contactType: string }[];
};

export const NEUTRAL_DEPLOYMENT: Deployment = {
	apexDomain: null,
	siteHost: null,
	siteDevelopHost: null,
	chatHost: null,
	chatDevelopHost: null,
	chatAliasHosts: [],
	mediaOrigins: [],
	previewTrustedOrigins: [],
	modelRouterHost: null,
	statusPageUrl: null,
	userAgent: 'alpha-chat',
	crawlerAgent: 'Alpha/0.1',
	contactEmail: null,
	mailFrom: null,
	sourceName: 'Alpha',
	publisher: null
};

// `typeof` guard: a plain-tsx script that imports this module never went through Vite's define.
export const DEPLOYMENT: Deployment = {
	...NEUTRAL_DEPLOYMENT,
	...(typeof __DEPLOYMENT__ === 'undefined' ? {} : __DEPLOYMENT__)
};
