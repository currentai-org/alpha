import MediaAudioPlayer from './MediaAudioPlayer.svelte';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';

// Read-aloud autoplay starts the clip before its metadata has loaded, so for a moment the element
// plays with `duration` still NaN. The readout must not print that as 0:00 / 0:00, which
// reads as an empty clip (CUR-2785).
const clip = vi.hoisted(() => ({ el: undefined as unknown as HTMLAudioElement }));
vi.mock('$lib/chat/stores/audioPlayback', () => ({
	clipAudio: async () => clip.el,
	playExclusive: async () => {}
}));

/** An off-DOM clip element whose length is still unknown, already playing, as autoplay leaves it. */
function playingBeforeMetadata(): HTMLAudioElement {
	const el = new EventTarget() as HTMLAudioElement;
	Object.assign(el, { currentTime: 0, duration: NaN, paused: false, pause() {} });
	return el;
}

describe('MediaAudioPlayer readout', () => {
	it('shows no 0:00 length while a playing clip has not reported its length yet', async () => {
		clip.el = playingBeforeMetadata();
		const screen = await render(MediaAudioPlayer, { src: '/chat/api/clip/a' });
		await expect.element(screen.getByRole('button', { name: 'Pause' })).toBeVisible();
		const readout = screen.container.querySelector('[data-audio-player] span.font-mono');
		expect(readout?.textContent).not.toMatch(/\/ 0:00$/);
		expect(readout?.textContent).toBe('0:00 / –:––');
	});

	it('shows the length once the clip reports it', async () => {
		const el = playingBeforeMetadata();
		clip.el = el;
		const screen = await render(MediaAudioPlayer, { src: '/chat/api/clip/b' });
		await expect.element(screen.getByRole('button', { name: 'Pause' })).toBeVisible();
		Object.assign(el, { duration: 1.85 });
		el.dispatchEvent(new Event('loadedmetadata'));
		await expect
			.poll(() => screen.container.querySelector('[data-audio-player] span.font-mono')?.textContent)
			.toBe('0:00 / 0:01');
	});
});
