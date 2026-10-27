// Folkways adapter — safety rules, read-only.
//
// GET returns the host's current safety snapshot: the declared rule catalog (rules.json),
// whether the validated policy loaded, which detector is live, and whether rules.json is
// what that detector enforces. It is a view. It cannot change a gate. The same snapshot is
// pushed to Folkways as a host report whenever it changes (see ../chat/completions).
//
// The catalog is already public on the host's trust-and-safety page, so this endpoint
// exposes nothing new; it only makes the state legible to the control plane.

import { safetySnapshot } from '../../safetySnapshot';
import { adapterGate } from '../../flag';
import { json } from '../../json';

export const GET = async ({ request }: { request: Request }) => {
	const gate = await adapterGate(request);
	if (gate) return gate;
	try {
		return json(200, await safetySnapshot());
	} catch (err) {
		console.error(`[folkways-adapter] safety snapshot failed: ${(err as Error).message}`);
		return json(500, { error: { message: 'safety snapshot unavailable' } });
	}
};
