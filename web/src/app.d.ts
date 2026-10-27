/// <reference types="@sveltejs/kit" />
/// <reference types="unplugin-icons/types/svelte" />

import type { Locale } from '$lib/i18n/locales';
import type { User } from '$lib/chat/types/User';
import type { GapMapMeta } from '$lib/types/scores';

// See https://svelte.dev/docs/kit/types#app.d.ts for information about these interfaces.
declare global {
	namespace App {
		/** Per-turn MCP server selection the client attaches to a chat POST, normalized
		 *  for the text-generation pipeline. Forward-looking plumbing: MCP tools are gated
		 *  off in the alpha, so nothing consumes this yet (see $lib/chat/server/mcp). */
		interface RequestMcpSelection {
			selectedServerNames?: string[];
			selectedServers: Array<{
				name: string;
				url: string;
				headers?: Record<string, string>;
			}>;
		}

		interface Locals {
			locale?: Locale;
			sessionId: string;
			user?: User;
			isAdmin: boolean;
			token?: string;
			/** Organization to bill inference requests to (from settings) */
			billingOrganization?: string;
			/** MCP selection forwarded by the client for this turn (see RequestMcpSelection). */
			mcp?: RequestMcpSelection;
			/** User's IANA timezone for this turn, so the tool prompt can localize the time. */
			timezone?: string;
			/** This request minted its guest session (it arrived with no cookie, or one the server never
			 *  issued). Read by routes that must not hand out a session, such as api/fetch-url (CUR-3191). */
			guestSessionMinted?: boolean;
			/** This render served a stand-in for the CMS (a snapshot, an older value, an empty nav), so the
			 *  CDN may hold it only briefly (CUR-1597, `$lib/cache/cdn.ts`). */
			servedStandIn?: boolean;
			/** Set only on /chat/api/v2/sync/*. `clientId` names the OAuth client whose sync token (CUR-4312)
			 *  authenticated the request; `error` says why none did (401 or 403). */
			sync?:
				| { clientId: string; error?: undefined }
				| { clientId?: undefined; error: 'unauthenticated' | 'not_permitted' };
		}

		interface Error {
			message: string;
			errorId?: ReturnType<typeof crypto.randomUUID>;
			/** Stable machine-readable cause code, set by routes whose client needs to tell error
			 *  causes apart rather than show one generic failure message for all of them (e.g.
			 *  agent-confirm's flag-off vs ownership-mismatch vs not-found, CUR-779). Optional —
			 *  most routes only set `message`. */
			reason?: string;
			/** On a 429 that knows its window: whole seconds until a retry can pass (CUR-3216). */
			retryAfterSeconds?: number;
		}
		/** Root-layout data every page carries (src/routes/+layout.server.ts). null when the gap map
		 *  database could not be read; absent on routes outside the root layout's load. */
		interface PageData {
			locale?: Locale;
			gapMapMeta?: GapMapMeta | null;
		}

		interface Platform {
			/** Vercel request context (adapter-vercel) — `waitUntil` keeps the function alive to finish
			 *  background work (e.g. a fire-and-forget warm) after the response is sent. */
			context?: { waitUntil?(promise: Promise<unknown>): void };
		}

		interface PageState {
			/** First message text carried from the home/model page to a new conversation. */
			pendingMessage?: string;
			/** Nonce for looking up File[] in the client-side pendingFiles Map. */
			pendingFilesNonce?: string;
			/**
			 * A map view's table sort after a header click. The URL carries it too, but replaceState
			 * records the pre-click URL for a later Back, so the sort comes back from here.
			 */
			mapSort?: { id: string; desc: boolean };
			/** The dataset's openness filter after a click, for the same reason as `mapSort`. */
			mapOpenness?: string[];
			/** The dataset's collapsed categories, so Back from a product page restores them. */
			mapCollapsed?: string[];
		}
	}

	// Injected by Vite `define` from package.json's "version" field.
	const __APP_VERSION__: string;
	// Injected by Vite `define`: canonical site origin (https://…) on Vercel, else
	// '' (URLs fall back to root-relative). Used for absolute og:image.
	const __SITE_ORIGIN__: string;
	// Injected by Vite `define`: whether this build has copy edit mode (every build but Vercel production).
	const __COPY_EDIT__: boolean;
	// Injected by Vite `define` from APP_SURFACE: which app this build serves (src/lib/surface.ts).
	const __APP_SURFACE__: 'site' | 'chat';
}

export {};
