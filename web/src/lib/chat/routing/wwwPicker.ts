import { catalog } from './catalog';
import { PICKER } from '../../../../config/picker';

/**
 * www's picker list, in its order, as catalog entries. The landing page's model card reads this, so
 * what it shows moves with `config/picker.ts` and never with the catalog alone.
 */
export const wwwPickerCatalog = asCatalog(PICKER.production);

function asCatalog(ids: readonly string[]) {
	return ids
		.map((id) => catalog.find((m) => m.status === 'live' && m.gatewayId === id))
		.filter((m) => m !== undefined);
}
