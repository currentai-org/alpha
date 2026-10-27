import { fromStore } from "svelte/store";
import { useSettingsStore } from "./settings";

/**
 * Whether the person wants to see which model wrote an answer and where it ran
 * (`showServing` in answerPreferences.ts), read from the settings context. The context is absent in a
 * component test and in the /alpha demo, and absent reads as shown, so nothing hides by accident. Call
 * it during component init, like any context read. (CUR-549)
 */
export function useShowServing(): { readonly current: boolean } {
	const store = useSettingsStore();
	const state = store ? fromStore(store) : undefined;
	return {
		get current() {
			return state?.current.showServing !== false;
		},
	};
}
