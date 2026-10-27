import { base } from "$lib/chat/paths";
import { browser } from "$app/environment";
import { tryDemoApiFetch } from "$lib/chat/demoApiFetch";
import superjson from "superjson";
import ObjectId from "bson-objectid";

superjson.registerCustom<ObjectId, string>(
	{
		isApplicable: (value): value is ObjectId => {
			if (typeof value !== "string" && ObjectId.isValid(value)) {
				const str = value.toString();
				return /^[0-9a-fA-F]{24}$/.test(str);
			}
			return false;
		},
		serialize: (value) => value.toString(),
		deserialize: (value) => new ObjectId(value),
	},
	"ObjectId"
);

type FetchFn = typeof globalThis.fetch;

interface ApiResponse<T = unknown> {
	data: T | null;
	error: unknown;
	status: number;
}

async function apiCall<T = unknown>(
	fetcher: FetchFn,
	url: string,
	method: string,
	body?: unknown,
	query?: Record<string, string | number | undefined>
): Promise<ApiResponse<T>> {
	const u = new URL(url);
	if (query) {
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined && v !== null) {
				u.searchParams.set(k, String(v));
			}
		}
	}

	const init: RequestInit = { method };
	if (body !== undefined && body !== null) {
		init.headers = { "Content-Type": "application/json" };
		init.body = JSON.stringify(body);
	}

	const demoResponse = tryDemoApiFetch(u.toString(), init);
	const res = demoResponse ?? (await fetcher(u.toString(), init));
	if (!res.ok) {
		let errorBody: unknown;
		try {
			errorBody = await res.json();
		} catch {
			errorBody = await res.text().catch(() => res.statusText);
		}
		return { data: null, error: errorBody, status: res.status };
	}

	// Handle empty responses (e.g. POST /user/settings returns empty body)
	const text = await res.text();
	if (!text) {
		return { data: null, error: null, status: res.status };
	}

	return { data: text as unknown as T, error: null, status: res.status };
}

function endpoint(fetcher: FetchFn, baseUrl: string) {
	return {
		get(opts?: { query?: Record<string, string | number | undefined> }) {
			return apiCall(fetcher, baseUrl, "GET", undefined, opts?.query);
		},
		post(body?: unknown) {
			return apiCall(fetcher, baseUrl, "POST", body);
		},
		patch(body?: unknown) {
			return apiCall(fetcher, baseUrl, "PATCH", body);
		},
		delete(opts?: { query?: Record<string, string | number | undefined> }) {
			return apiCall(fetcher, baseUrl, "DELETE", undefined, opts?.query);
		},
	};
}

export function useAPIClient({
	fetch: customFetch,
	origin,
}: {
	fetch?: FetchFn;
	origin?: string;
} = {}) {
	const fetcher = customFetch ?? globalThis.fetch;
	const baseUrl = browser
		? `${window.location.origin}${base}/api/v2`
		: `${origin ?? `http://localhost:5173`}${base}/api/v2`;

	return {
		conversations: Object.assign(
			// client.conversations({ id: "..." }) — returns endpoint for /conversations/:id
			(params: { id: string }) => ({
				...endpoint(fetcher, `${baseUrl}/conversations/${params.id}`),
				message: (msgParams: { messageId: string }) =>
					endpoint(fetcher, `${baseUrl}/conversations/${params.id}/message/${msgParams.messageId}`),
			}),
			// client.conversations.get(), .delete()
			{
				...endpoint(fetcher, `${baseUrl}/conversations`),
				"import-share": endpoint(fetcher, `${baseUrl}/conversations/import-share`),
			}
		),
		user: {
			...endpoint(fetcher, `${baseUrl}/user`),
			settings: endpoint(fetcher, `${baseUrl}/user/settings`),
			reports: endpoint(fetcher, `${baseUrl}/user/reports`),
			"billing-orgs": endpoint(fetcher, `${baseUrl}/user/billing-orgs`),
			// client.user["local-inference-endpoints"].get()/.post(body), or
			// client.user["local-inference-endpoints"]({ id }).delete() for one row. (CUR-1262)
			// .managed.post(body) provisions a managed (tunnel) endpoint;
			// ({ id }).status.get() polls its online/offline state; .managed.availability.get() checks
			// whether Pangolin is actually reachable right now (Settings UI's Pair-button disable). (CUR-1266)
			"local-inference-endpoints": Object.assign(
				(params: { id: string }) => ({
					...endpoint(fetcher, `${baseUrl}/user/local-inference-endpoints/${params.id}`),
					status: endpoint(fetcher, `${baseUrl}/user/local-inference-endpoints/${params.id}/status`),
				}),
				endpoint(fetcher, `${baseUrl}/user/local-inference-endpoints`),
				{
					managed: Object.assign(
						endpoint(fetcher, `${baseUrl}/user/local-inference-endpoints/managed`),
						{
							availability: endpoint(
								fetcher,
								`${baseUrl}/user/local-inference-endpoints/managed/availability`
							),
						}
					),
				}
			),
		},
		models: {
			...endpoint(fetcher, `${baseUrl}/models`),
			old: endpoint(fetcher, `${baseUrl}/models/old`),
		},
		"public-config": endpoint(fetcher, `${baseUrl}/public-config`),
		"feature-flags": endpoint(fetcher, `${baseUrl}/feature-flags`),
		debug: {
			config: endpoint(fetcher, `${baseUrl}/debug/config`),
		},
		export: endpoint(fetcher, `${baseUrl}/export`),
	};
}

// Callers that need to tell "not found/not yours" (404/403) apart from a network blip —
// e.g. a stale conversation link after signing in — read `.status` off the thrown error instead of
// parsing `.message`. `ApiResponse.status` was already threaded through from apiCall; handleResponse
// just wasn't carrying it onto what it throws. (CUR-849)
export class ApiError extends Error {
	constructor(
		public status: number,
		body: unknown
	) {
		super(JSON.stringify(body));
	}
}

// An error() response carries {message}, and ApiError.message is that body JSON-stringified. This
// unwraps the sentence, or returns the caller's fallback, so no surface ever shows raw JSON.
export function apiErrorMessage(err: unknown, fallback: string): string {
	if (err instanceof ApiError) {
		try {
			const body = JSON.parse(err.message) as { message?: unknown };
			if (typeof body?.message === "string" && body.message) return body.message;
		} catch {
			// fall through to fallback
		}
	}
	return fallback;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handleResponse(response: ApiResponse<any>): any {
	if (response.error) {
		throw new ApiError(response.status, response.error);
	}

	if (response.data === null) {
		return null;
	}

	return superjson.parse(
		typeof response.data === "string" ? response.data : JSON.stringify(response.data)
	);
}
