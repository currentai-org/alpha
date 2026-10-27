// Single-clip TTS playback coordinator: at most one read-aloud clip is ever audible at once.
//
// Each clip URL gets ONE off-DOM audio element (`clipAudio`), shared by the autoplay in the send
// path and by the answer's visible MediaAudioPlayer. When autoplay starts a clip, the player under
// the answer is subscribed to that very element, so it shows playing and its pause button pauses
// what you hear (CUR-2299). With two elements, an autoplayed answer would sit under a
// player that reads stopped and starts again from the top when pressed.
// Off-DOM because the duplicate-generation edge re-renders the message, and a DOM <audio> torn down
// mid-play is cut off; an element that lives here survives the player being remounted.
//
// Every start goes through playExclusive(), which pauses whatever was playing first. We pause rather
// than reset, so a clip can be resumed from where it left off.

import { on } from "svelte/events";
import { loadAudioClip } from "$lib/chat/utils/loadAudioClip";

let current: HTMLAudioElement | null = null;

// One element per clip URL for the life of the page, and its blob URL is kept for as long: a clip is
// a few seconds of speech, and dropping the URL would leave its player unable to replay it.
const clips = new Map<string, Promise<HTMLAudioElement>>();

// iOS Safari lets an audio element play without a tap only once that same element has been
// played inside one. A read-aloud clip arrives seconds after the send tap, past several awaits, so a
// fresh element for it is refused. The send tap primes an element by playing 50 ms of silence on it,
// and the next clip to load takes that element instead of a new one. (CUR-4666)
const SILENCE = "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";
let primed: HTMLAudioElement | null = null;

/**
 * Call from the send tap itself, before any await: plays silence on a fresh element so the answer's
 * clip, which takes it, may start without another tap. One primed element waits at a time.
 */
export function primeAudioForAutoplay(): void {
	if (primed || typeof Audio === "undefined") return;
	const el = new Audio(SILENCE);
	primed = el;
	try {
		// Pause only while it is still the silence: a clip may already have taken it and be playing.
		void el.play()?.then(
			() => {
				if (primed === el) el.pause();
			},
			() => {
				/* refused or interrupted: the clip falls back to a fresh element and a manual press */
			}
		);
	} catch {
		/* no audio support — nothing to unlock */
	}
}

function takePrimed(): HTMLAudioElement | null {
	const el = primed;
	primed = null;
	return el;
}

/** The shared audio element for `src`, fetched once (see loadAudioClip for why it's a blob URL). */
export function clipAudio(src: string): Promise<HTMLAudioElement> {
	let pending = clips.get(src);
	if (!pending) {
		pending = loadAudioClip(src).then((objectUrl) => {
			const el = takePrimed() ?? new Audio();
			el.preload = "metadata";
			el.src = objectUrl;
			const release = () => stopIfCurrent(el);
			on(el, "pause", release);
			on(el, "ended", release);
			on(el, "error", release);
			return el;
		});
		// A failed load is not cached, so the next player or autoplay for this clip tries again.
		pending.catch(() => clips.delete(src));
		clips.set(src, pending);
	}
	return pending;
}

/** Start `el`, pausing any other clip that was playing. Returns the underlying play() promise. */
export function playExclusive(el: HTMLAudioElement): Promise<void> {
	if (current && current !== el) {
		try {
			current.pause();
		} catch {
			/* element already torn down — nothing to pause */
		}
	}
	current = el;
	// el.play() can reject (autoplay policy, element removed mid-call); callers swallow it.
	return el.play();
}

/**
 * Play `src` because the visitor just tapped to hear it, such as the offer to read an answer in the
 * English voice. Call it from the tap handler itself, before any await: the element is primed inside
 * the tap, so the clip may still start on a phone once it has been synthesized and fetched, seconds
 * later. Mounting a player alone never started it, and that offer then needed a second tap.
 */
export function playOnTap(src: string): Promise<void> {
	primeAudioForAutoplay();
	return clipAudio(src).then((el) => playExclusive(el));
}

/** Release `el` as the active clip once it stops, so a stale ref can't be paused later. */
function stopIfCurrent(el: HTMLAudioElement): void {
	if (current === el) current = null;
}

/** Pause whatever clip is sounding. Sending a new message calls this, so the last answer stops. */
export function stopPlayback(): void {
	const playing = current;
	current = null;
	try {
		playing?.pause();
	} catch {
		/* element already torn down — nothing to pause */
	}
}
