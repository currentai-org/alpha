// Where a safety judge's endpoint comes from. Server-only because it reads the deployment's env;
// config/safetyScreen.ts holds the judges' data and is also reached from client code.
import { committedConfigEnv } from "../../../../../config/inference";
import type { JudgeProvider } from "../../../../../config/safetyScreen";

/**
 * The endpoint a judge calls, or `undefined` when this deployment has none, which makes the judge
 * unconfigured. The env var `provider.api_base_env` wins wherever it is set. Without it, only a
 * deployment that declares itself production or preview gets Current AI's own endpoint, the address
 * every one of those deployments called before the env var existed. Anywhere else (local dev, CI, a
 * self-host) there is no endpoint: a self-host holds an HF_TOKEN for its own reasons, and must not
 * look configured for endpoints that token cannot call. Read at call time, so tests can stub env.
 */
export function judgeApiBase(
	provider: JudgeProvider,
	env: Record<string, string | undefined> = process.env
): string | undefined {
	const fromEnv = env[provider.api_base_env]?.trim().replace(/\/+$/, "");
	if (fromEnv) return fromEnv;
	return committedConfigEnv(env) ? provider.deployed_api_base : undefined;
}
