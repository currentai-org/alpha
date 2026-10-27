// Flag definitions baked into a Vercel build by scripts/bake-flag-definitions.mjs,
// served to posthog-node as a cache provider. A PR preview's (`frozen`) never fetches; develop's and
// production's (`seed`) are the client's first definitions, and every load after that fetches live.
// A local build has no file, the glob matches nothing, `bakedFlagDefinitions` is undefined and the
// client polls.
//
// A glob rather than an import because the file is absent from the repo and from most builds, and a
// static import of a missing file fails the build. (CUR-2897, CUR-4199)

import type { FlagDefinitionCacheData, FlagDefinitionCacheProvider } from "posthog-node";

type Baked = FlagDefinitionCacheData & { bakedAt?: string; mode?: "frozen" | "seed" };

const files = import.meta.glob<Baked>("./flag-definitions.baked.json", { eager: true, import: "default" });

export const bakedFlagDefinitions: Baked | undefined = Object.values(files)[0];

/**
 * Serves the baked definitions. `frozen`, or a file baked before modes existed, refuses every fetch, so
 * the deployment makes no definitions call. `seed` refuses only the first, which posthog-node makes as
 * the client is built, so the client starts loaded from the bake and every later load fetches live.
 */
export function bakedCacheProvider(data: Baked): FlagDefinitionCacheProvider {
	let seeded = false;
	return {
		getFlagDefinitions: () => data,
		shouldFetchFlagDefinitions: () => {
			if (data.mode !== "seed") return false;
			const fetch = seeded;
			seeded = true;
			return fetch;
		},
		onFlagDefinitionsReceived: () => {},
		shutdown: () => {},
	};
}
