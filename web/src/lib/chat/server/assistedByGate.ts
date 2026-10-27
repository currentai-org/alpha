import { flagEnabledOr } from "$lib/chat/server/flags";

// Whether a turn records the helper models that worked on it (routerMetadata.assistedBy) for
// X-ray to name. Off, the turn records only the model that wrote the answer, as before. (CUR-984)
export const PROVENANCE_ASSISTED_BY_FLAG = "provenance-assisted-by";
export const assistedByEnabled = (): boolean =>
	flagEnabledOr(PROVENANCE_ASSISTED_BY_FLAG, () => false);
