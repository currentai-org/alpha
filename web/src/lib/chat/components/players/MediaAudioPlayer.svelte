<script lang="ts">
	import CarbonPause from "~icons/carbon/pause";
	import CarbonPlay from "~icons/carbon/play";
	import RiErrorWarning from "~icons/ri/error-warning-line";
	import { on } from "svelte/events";
	import { clipAudio, playExclusive } from "$lib/chat/stores/audioPlayback";

	// Editorial audio player for an open-component clip (TTS): matches the paper/ink design instead of the
	// browser's big white native <audio controls>. It renders no <audio> of its own: it drives the clip's
	// shared element from the playback coordinator, the same one read-aloud's autoplay starts, so the
	// controls show what is actually sounding (CUR-2299). See audioPlayback.ts for why that element is
	// off-DOM.
	//
	// Reads its state from media EVENTS on that element, never a two-way bind. Autoplay can start the
	// clip before its metadata loads, so an unknown length shows as a placeholder, never as 0:00 (CUR-2785).
	interface Props {
		src: string;
	}
	let { src }: Props = $props();

	let audioEl: HTMLAudioElement | undefined = $state();
	let time = $state(0);
	let duration = $state(0);
	let paused = $state(true);
	// The clip is fetched and played from a local blob: URL (see loadAudioClip.ts). `audioEl`
	// is undefined until that resolves; `loadFailed` covers a non-OK response, a network error, or the
	// fetch outliving its own timeout. (CUR-851)
	let loadFailed = $state(false);

	$effect(() => {
		const clipUrl = src;
		audioEl = undefined;
		loadFailed = false;
		time = 0;
		duration = 0;
		paused = true;
		let cancelled = false;
		let detach = () => {};

		clipAudio(clipUrl)
			.then((el) => {
				if (cancelled) return;
				const sync = () => {
					time = el.currentTime;
					duration = Number.isFinite(el.duration) ? el.duration : 0;
					paused = el.paused;
				};
				const events = ["timeupdate", "loadedmetadata", "durationchange", "play", "pause", "ended"];
				const offs = events.map((name) => on(el, name, sync));
				// Unsubscribing never pauses: a player remounted mid-clip picks the same element back up.
				detach = () => {
					for (const off of offs) off();
				};
				audioEl = el;
				sync();
			})
			.catch(() => {
				if (!cancelled) loadFailed = true;
			});

		return () => {
			cancelled = true;
			detach();
		};
	});

	function fmt(t: number): string {
		if (!isFinite(t) || t < 0) return "0:00";
		const m = Math.floor(t / 60);
		const s = Math.floor(t % 60);
		return `${m}:${s < 10 ? `0${s}` : s}`;
	}

	function toggle() {
		if (!audioEl) return;
		// playExclusive pauses any other clip first, so pressing play here can't stack on top of
		// another message's clip still sounding.
		if (audioEl.paused) void playExclusive(audioEl).catch(() => {});
		else audioEl.pause();
	}

	function seek(e: PointerEvent) {
		if (!audioEl || !isFinite(duration) || duration <= 0) return;
		const { left, width } = (e.currentTarget as HTMLElement).getBoundingClientRect();
		audioEl.currentTime = Math.min(1, Math.max(0, (e.clientX - left) / width)) * duration;
	}
</script>

{#if loadFailed}
	<div
		data-audio-player
		class="mt-2 flex h-9 w-64 max-w-full items-center gap-2 rounded-full border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-3 text-[length:var(--ap-text-1)] text-[var(--ap-ink-3)]"
	>
		<RiErrorWarning class="size-3.5 shrink-0 opacity-70" />
		<span>Couldn't load this audio</span>
	</div>
{:else}
	<div
		data-audio-player
		class="mt-2 flex h-9 w-64 max-w-full items-center gap-2.5 rounded-full border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 text-[var(--ap-ink-2)]"
	>
		<button
			type="button"
			class="grid size-7 shrink-0 place-items-center rounded-full border border-[var(--ap-rule)] transition-colors hover:bg-[var(--ap-ink)]/[0.05] disabled:opacity-50"
			aria-label={paused ? "Play" : "Pause"}
			disabled={!audioEl}
			onclick={toggle}
		>
			{#if paused}
				<CarbonPlay class="size-3 translate-x-px" />
			{:else}
				<CarbonPause class="size-3" />
			{/if}
		</button>

		<div
			class="relative h-1 flex-1 cursor-pointer rounded-full bg-[var(--ap-ink)]/10"
			role="slider"
			aria-label="Seek"
			aria-valuenow={Math.floor(time)}
			aria-valuemin={0}
			aria-valuemax={Math.floor(duration) || 0}
			tabindex="0"
			onpointerup={seek}
		>
			<div
				class="absolute inset-y-0 left-0 rounded-full bg-[var(--ap-live)]"
				style="width: {duration ? (time / duration) * 100 : 0}%"
			></div>
		</div>

		<span class="shrink-0 font-mono text-[length:var(--ap-text-1)] text-[var(--ap-ink-3)]"
			>{fmt(time)} / {duration > 0 ? fmt(duration) : "–:––"}</span
		>
	</div>
{/if}
