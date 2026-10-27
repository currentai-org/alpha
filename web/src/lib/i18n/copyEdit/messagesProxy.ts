// Stands in for `$lib/paraglide/messages.js` on dev and preview builds (vite.config.ts,
// copyEditMessages): the same `m`, with each message routed through copy edit mode. With the mode
// off, every call returns exactly what Paraglide returns.
import * as real from '../../paraglide/messages/_index.js';
import { editedMessage, registerKeys } from './state.svelte';

type Message = (inputs?: unknown, options?: { locale?: string }) => string;

const source = real as unknown as Record<string, Message>;
const names = Object.keys(source).filter((k) => typeof source[k] === 'function');
registerKeys(names);

export const m = Object.fromEntries(
	names.map((key) => [
		key,
		(inputs?: unknown, options?: { locale?: string }) =>
			editedMessage(key, source[key], inputs, options)
	])
) as unknown as typeof real;

export * from '../../paraglide/messages/_index.js';
