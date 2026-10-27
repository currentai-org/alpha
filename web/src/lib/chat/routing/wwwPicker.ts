import { catalog } from './catalog';
import { PICKER, PICKER_BEFORE_WITHDRAWALS } from '../../../../config/picker';

/**
 * www's picker list, in its order, as catalog entries. The landing page's model card and the /alpha
 * demo both read this, so what they show moves with `config/picker.ts` and never with the catalog
 * alone (CUR-4099).
 */
export const wwwPickerCatalog = asCatalog(PICKER.production);

/**
 * www's picker as it stands before config/picker.ts's WITHDRAWN, for the /alpha demo alone. The demo's
 * answers are recordings, so a model withdrawn because its upstream is unavailable still answers there, and its
 * sample threads keep the model they were recorded with (CUR-4162).
 */
export const demoPickerCatalog = asCatalog(PICKER_BEFORE_WITHDRAWALS.production);

function asCatalog(ids: readonly string[]) {
	return ids
		.map((id) => catalog.find((m) => m.status === 'live' && m.gatewayId === id))
		.filter((m) => m !== undefined);
}
