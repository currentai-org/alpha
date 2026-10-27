import { assertNotProduction } from '$lib/server/devOnlyRoute';
import { DS_VERSION } from '@aipotluck/alpha-ds/version/changelog.server';
import type { LayoutServerLoad } from './$types';

// Preview and local dev only; production answers 404 (devOnlyRoute.ts). Otherwise it hands the docs
// header the derived design-system version.
export const load: LayoutServerLoad = () => {
	assertNotProduction();
	return { dsVersion: DS_VERSION };
};
