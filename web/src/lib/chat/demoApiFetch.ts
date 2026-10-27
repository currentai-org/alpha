/**
 * Optional fetch interceptor for marketing embeds (e.g. `/alpha` demo). When set, `APIClient`
 * short-circuits matching requests instead of hitting the real chat API.
 */
export type DemoApiFetchInterceptor = (url: string, init: RequestInit) => Response | null;

let interceptor: DemoApiFetchInterceptor | null = null;

export function setDemoApiFetchInterceptor(fn: DemoApiFetchInterceptor | null): void {
	interceptor = fn;
}

export function tryDemoApiFetch(url: string, init: RequestInit): Response | null {
	return interceptor?.(url, init) ?? null;
}
