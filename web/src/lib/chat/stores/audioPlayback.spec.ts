import { afterEach, describe, it, expect, vi } from "vitest";
import { clipAudio, playExclusive, playOnTap, primeAudioForAutoplay, stopPlayback } from "./audioPlayback";

const loadAudioClip = vi.hoisted(() => vi.fn());
vi.mock("$lib/chat/utils/loadAudioClip", () => ({ loadAudioClip }));

// Minimal fake of the slice of HTMLAudioElement the coordinator touches.
function fakeAudio() {
	const el = {
		paused: true,
		play: vi.fn(() => {
			el.paused = false;
			return Promise.resolve();
		}),
		pause: vi.fn(() => {
			el.paused = true;
		}),
	};
	return el as unknown as HTMLAudioElement & {
		play: ReturnType<typeof vi.fn>;
		pause: ReturnType<typeof vi.fn>;
	};
}

describe("audioPlayback coordinator", () => {
	it("starting a second clip pauses the first (no overlap)", async () => {
		const a = fakeAudio();
		const b = fakeAudio();

		await playExclusive(a);
		expect(a.play).toHaveBeenCalledTimes(1);
		expect(a.pause).not.toHaveBeenCalled();

		await playExclusive(b);
		// b starts, a is paused so the two never sound together
		expect(b.play).toHaveBeenCalledTimes(1);
		expect(a.pause).toHaveBeenCalledTimes(1);
	});

	it("re-playing the same element does not pause itself", async () => {
		const a = fakeAudio();
		await playExclusive(a);
		await playExclusive(a);
		expect(a.pause).not.toHaveBeenCalled();
		expect(a.play).toHaveBeenCalledTimes(2);
	});

	it("stopPlayback pauses the clip that is sounding, so a new turn doesn't talk over it", async () => {
		const a = fakeAudio();
		await playExclusive(a);
		stopPlayback();
		expect(a.pause).toHaveBeenCalledTimes(1);

		// Nothing is current any more, so the next clip starts without reaching back to a.
		const b = fakeAudio();
		await playExclusive(b);
		expect(a.pause).toHaveBeenCalledTimes(1);
	});
});

describe("clipAudio: one element per clip, shared by autoplay and the player (CUR-2299)", () => {
	class FakeAudio extends EventTarget {
		preload = "";
		paused = true;
		play = vi.fn(() => {
			this.paused = false;
			return Promise.resolve();
		});
		pause = vi.fn(() => {
			this.paused = true;
		});
		constructor(public src: string) {
			super();
		}
	}
	vi.stubGlobal("Audio", FakeAudio);

	it("hands every caller for the same clip the same element, and fetches it once", async () => {
		loadAudioClip.mockResolvedValueOnce("blob:one");
		const [first, second] = await Promise.all([clipAudio("https://clip/one"), clipAudio("https://clip/one")]);
		expect(second).toBe(first);
		expect((first as unknown as FakeAudio).src).toBe("blob:one");
		expect(loadAudioClip).toHaveBeenCalledTimes(1);
	});

	it("does not remember a failed load, so the next caller fetches again", async () => {
		loadAudioClip.mockRejectedValueOnce(new Error("audio fetch failed: 502"));
		await expect(clipAudio("https://clip/two")).rejects.toThrow("502");
		loadAudioClip.mockResolvedValueOnce("blob:two");
		await expect(clipAudio("https://clip/two")).resolves.toBeDefined();
	});

	it("a clip that has ended is released, so the next clip starts without reaching back to pause it", async () => {
		loadAudioClip.mockResolvedValueOnce("blob:three");
		const a = (await clipAudio("https://clip/three")) as unknown as FakeAudio;
		await playExclusive(a as unknown as HTMLAudioElement);
		a.dispatchEvent(new Event("ended"));

		const b = fakeAudio();
		await playExclusive(b);
		expect(a.pause).not.toHaveBeenCalled();
	});

	it("a clip that ends while another is playing leaves the playing one in charge", async () => {
		loadAudioClip.mockResolvedValueOnce("blob:four");
		const ended = (await clipAudio("https://clip/four")) as unknown as FakeAudio;
		const playing = fakeAudio();
		await playExclusive(playing);
		ended.dispatchEvent(new Event("ended")); // not current, so it releases nothing

		await playExclusive(fakeAudio());
		expect(playing.pause).toHaveBeenCalledTimes(1);
	});
});

// iOS Safari plays an element without a tap only if that element was played inside one. The
// send tap primes an element; the answer's clip, loaded seconds later, must play on that same element. (CUR-4666)
describe("priming read-aloud on the send tap", () => {
	type FakeEl = {
		src: string;
		preload: string;
		paused: boolean;
		play: ReturnType<typeof vi.fn>;
		pause: ReturnType<typeof vi.fn>;
		addEventListener: ReturnType<typeof vi.fn>;
		removeEventListener: ReturnType<typeof vi.fn>;
	};
	let made: FakeEl[] = [];
	let resolvePlay: Array<() => void> = [];

	function stubAudio() {
		made = [];
		resolvePlay = [];
		vi.stubGlobal(
			"Audio",
			vi.fn(function (this: unknown, src?: string) {
				const el: FakeEl = {
					src: src ?? "",
					preload: "",
					paused: true,
					play: vi.fn(
						() =>
							new Promise<void>((resolve) => {
								el.paused = false;
								resolvePlay.push(resolve);
							})
					),
					pause: vi.fn(() => {
						el.paused = true;
					}),
					addEventListener: vi.fn(),
					removeEventListener: vi.fn(),
				};
				made.push(el);
				return el;
			})
		);
	}
	afterEach(() => vi.unstubAllGlobals());

	it("plays silence on a fresh element during the tap, and the next clip loads onto that same element", async () => {
		stubAudio();
		primeAudioForAutoplay();
		expect(made).toHaveLength(1);
		// Synchronously, inside the tap: this play() is what unlocks the element on iOS.
		expect(made[0].play).toHaveBeenCalledTimes(1);
		expect(made[0].src).toMatch(/^data:audio\/wav;base64,/);

		loadAudioClip.mockResolvedValueOnce("blob:answer-1");
		const el = (await clipAudio("/clip/answer-1")) as unknown as FakeEl;
		expect(made).toHaveLength(1);
		expect(el).toBe(made[0]);
		expect(el.src).toBe("blob:answer-1");
	});

	it("does not pause the answer when the silence's play() settles after the clip took the element", async () => {
		stubAudio();
		primeAudioForAutoplay();
		loadAudioClip.mockResolvedValueOnce("blob:answer-2");
		const el = (await clipAudio("/clip/answer-2")) as unknown as HTMLAudioElement;
		void playExclusive(el);
		resolvePlay[0]();
		await Promise.resolve();
		await Promise.resolve();
		expect((el as unknown as FakeEl).pause).not.toHaveBeenCalled();
		stopPlayback();
	});

	it("pauses the silence once it has played when no clip has taken the element yet, and primes only one at a time", async () => {
		stubAudio();
		primeAudioForAutoplay();
		primeAudioForAutoplay();
		expect(made).toHaveLength(1);
		resolvePlay[0]();
		await Promise.resolve();
		await Promise.resolve();
		expect(made[0].pause).toHaveBeenCalledTimes(1);
		// Consume it, so later tests start unprimed.
		loadAudioClip.mockResolvedValueOnce("blob:answer-3");
		await clipAudio("/clip/answer-3");
	});

	it("a clip loaded with nothing primed gets a fresh element of its own", async () => {
		stubAudio();
		loadAudioClip.mockResolvedValueOnce("blob:answer-4");
		const el = (await clipAudio("/clip/answer-4")) as unknown as FakeEl;
		expect(made).toHaveLength(1);
		expect(el.play).not.toHaveBeenCalled();
		expect(el.src).toBe("blob:answer-4");
	});

	// The offer to read an answer in the English voice must prime an element inside the tap, or a phone
	// on Read aloud: Always needs a second tap.
	it("playOnTap primes an element inside the tap, then plays the requested clip on that element", async () => {
		stubAudio();
		loadAudioClip.mockResolvedValueOnce("blob:english-fallback");
		const playing = playOnTap("/clip/english-fallback");
		// Before any await: the tap's own play() is what lets the clip start later on iOS.
		expect(made).toHaveLength(1);
		expect(made[0].play).toHaveBeenCalledTimes(1);
		resolvePlay[0]();
		await vi.waitFor(() => expect(made[0].play).toHaveBeenCalledTimes(2));
		expect(made).toHaveLength(1);
		expect(made[0].src).toBe("blob:english-fallback");
		resolvePlay[1]();
		await playing;
		stopPlayback();
	});
});
