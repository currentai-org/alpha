/**
 * Which production instance this deployment is. www.aipotluck.org is `www`. An event
 * instance (mozfest.aipotluck.org, lugano.aipotluck.org) is its own Vercel project with its own
 * database and secrets config, and sets INSTANCE to its name.
 *
 * Config that names the deployment; it turns no feature on or off, so no flag gates it. Unset means `www`, so every deployment
 * that predates this reads exactly as it did. It decides the session cookie's name, the passkey RP
 * ID and the sign-in origins (betterAuth.ts, authOrigins.ts), and it is the `instance` person
 * property on every flag evaluation (flags.ts), so a flag can carry its own condition per instance.
 *
 * Pure and free of config imports, like authOrigins.ts, so those modules and their tests can read it. (CUR-3156)
 */
export const DEFAULT_INSTANCE = "www";

// The name becomes part of a cookie name (`aip-<instance>`), so it is held to a DNS label's shape.
const INSTANCE_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/**
 * The instance name, `www` when INSTANCE is unset or blank. A value that isn't a lowercase label
 * throws: falling back to `www` would hand an event instance production's apex cookie, the
 * collision this setting exists to prevent.
 */
export function deploymentInstance(env: { INSTANCE?: string }): string {
	const raw = env.INSTANCE?.trim();
	if (!raw) return DEFAULT_INSTANCE;
	if (!INSTANCE_NAME.test(raw)) {
		throw new Error(`INSTANCE="${raw}" is not a lowercase label like "mozfest"; refusing to guess an instance`);
	}
	return raw;
}

/** True on a production deployment of an instance other than www. */
export function isEventInstance(env: { VERCEL_ENV?: string; INSTANCE?: string }): boolean {
	return env.VERCEL_ENV === "production" && deploymentInstance(env) !== DEFAULT_INSTANCE;
}
