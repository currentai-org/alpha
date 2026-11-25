// The models a stack serves that the hosted catalog does not know: on a self-hosted Alpha, the operator's
// own (their llama, or every OPENAI_API_BASE_URLS endpoint's models). The composer's model switcher
// builds its rows from the catalog, which carries the maker, logo and benchmarks, so without this list
// an operator's models had no row at all. A person's own local endpoints have their own group
// and are left out here.
import { catalogByGatewayId } from "./catalog";
import { isLocalModelId, pickerDisplayName } from "$lib/chat/identity";

export type ServerModel = { id: string; name: string };

/** The served ids with no catalog entry and no local-endpoint prefix, in served order, each with the
 *  name the server gave it (its id when it gave none). */
export function serverModels(
	servedIds: readonly string[],
	models: readonly { id: string; displayName?: string }[] | undefined
): ServerModel[] {
	return servedIds
		.filter((id) => !isLocalModelId(id) && !catalogByGatewayId(id))
		.map((id) => {
			const displayName = models?.find((m) => m.id === id)?.displayName ?? id;
			return { id, name: pickerDisplayName({ id, displayName }) };
		});
}
