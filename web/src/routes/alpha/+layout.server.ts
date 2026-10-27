import { assertNotProduction } from '$lib/server/devOnlyRoute';

// Preview and local dev only; production answers 404 (devOnlyRoute.ts).
export const load = () => {
	assertNotProduction();
};
