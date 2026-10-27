// Reusable elapsed-seconds timer (Svelte 5 rune helper). Call it during a component's init; the internal
// `$effect` binds to that component's lifecycle and is cleaned up automatically. `active()` gates the
// timer — it resets to 0 whenever inactive, so the count always reflects "seconds since this load
// started". Extracted from the duplicated inline timers (SecondOpinion + the read-aloud warming
// indicator) so every dynamic-load indicator shares one implementation.
export function elapsedSeconds(active: () => boolean): { readonly value: number } {
	let value = $state(0);
	$effect(() => {
		if (!active()) {
			value = 0;
			return;
		}
		const start = Date.now();
		const iv = setInterval(() => (value = Math.floor((Date.now() - start) / 1000)), 500);
		return () => clearInterval(iv);
	});
	return {
		get value() {
			return value;
		},
	};
}
