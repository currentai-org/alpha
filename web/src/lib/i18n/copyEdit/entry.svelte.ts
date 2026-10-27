// The way into copy edit mode from app code. Only builds with the mode (`__COPY_EDIT__`) load it.
import type { Component } from 'svelte';
import { replaceState } from '$app/navigation';

type StateModule = typeof import('./state.svelte');

let state: Promise<StateModule> | undefined;
const stateModule = () => (state ??= import('./state.svelte'));

/** Restores a session left on in this browser, or starts one when the URL carries `?edit-text`. */
export async function initCopyEdit(): Promise<StateModule['copyEdit'] | undefined> {
	if (!__COPY_EDIT__) return undefined;
	const mod = await stateModule();
	// Read once at start-up, never rendered.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const url = new URL(location.href);
	const wanted = url.searchParams.has('edit-text');
	const wasOn = mod.restore();
	if (wanted) {
		url.searchParams.delete('edit-text');
		// Drops `?edit-text` from the current page's own URL; nothing to resolve.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		replaceState(url, {});
		if (!wasOn) mod.setOn(true);
	}
	return mod.copyEdit;
}

export async function startCopyEdit(): Promise<void> {
	if (!__COPY_EDIT__) return;
	(await stateModule()).setOn(true);
}

export async function loadCopyEditLayer(): Promise<Component> {
	return (await import('./CopyEditLayer.svelte')).default;
}
