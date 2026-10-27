import { getContext, setContext } from 'svelte';

/** What `Combobox.Input` needs from its Root: a way to open the list on click, as a Select does. */
type ComboboxContext = { openList: () => void };

const KEY = Symbol('ds-combobox');

export const setComboboxContext = (context: ComboboxContext) => setContext(KEY, context);
export const getComboboxContext = () => getContext<ComboboxContext | undefined>(KEY);
