/**
 * A compile-time check that a value bound for a response carries no field named like a credential
 * (CUR-2643).
 *
 * @remarks
 * A model registry entry carries `endpoints[].apiKey`, a provider key, and the per-model route
 * `/chat/api/v2/models/<id>` could return it. The key crosses three files on the way
 * (`models.ts`, `resolveModel`, the route), so no single-file scanner could follow it, but the
 * entry's TypeScript type carries `apiKey` the whole way. Checking the type at the response helper
 * catches the same shape wherever it starts. It sees only what the type declares: a value typed
 * `any`, `unknown` or a loose record passes, and a credential under an innocent name passes.
 *
 * Bare `token` is left off the list: in this app it names a streamed LLM token far more often than
 * a credential (`MessageStreamUpdate.token`).
 */
type SecretFieldName =
	| "apiKey"
	| "accessToken"
	| "refreshToken"
	| "idToken"
	| "secret"
	| "clientSecret"
	| "password"
	| "privateKey"
	| "authorization"
	| `${string}ApiKey`
	| `${string}Secret`
	| `${string}Password`
	| `${string}AccessToken`;

declare const disclosed: unique symbol;

/** A secret the response is meant to carry, to the one person it belongs to. */
export type DisclosedSecret = string & { readonly [disclosed]: true };

/**
 * Marks a secret as deliberately sent to its owner, so `NoSecretFields` lets it through. Call it
 * only on an authenticated route answering the secret's owner, with a comment saying why.
 */
export function discloseToOwner(value: string): DisclosedSecret {
	return value as DisclosedSecret;
}

type Depth = [never, 0, 1, 2, 3, 4, 5, 6, 7];

/**
 * The first secret-named key reachable inside `T`, or `never` when there is none. An `any` passes:
 * its `keyof` is `string`, which every `${string}Secret` pattern matches, and the type says nothing
 * about what the value holds.
 */
type SecretFieldIn<T, D extends number = 8> = [D] extends [never]
	? never
	: 0 extends 1 & T
		? never
		: T extends (...args: never[]) => unknown
		? never
		: T extends readonly (infer U)[]
			? SecretFieldIn<U, Depth[D]>
			: T extends object
				? {
						[K in keyof T]-?: K extends SecretFieldName
							? NonNullable<T[K]> extends DisclosedSecret
								? never
								: K
							: SecretFieldIn<T[K], Depth[D]>;
					}[keyof T]
				: never;

/** `T` unchanged when it carries no secret-named field; otherwise a type no value satisfies. */
export type NoSecretFields<T> = [SecretFieldIn<T>] extends [never]
	? T
	: { "response carries a secret-named field": SecretFieldIn<T> };
