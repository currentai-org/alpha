// e2e-product: @chat
// e2e-area: @composer
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type BrowserContext, type Page } from './helpers/test';
import { chatEntry, LARGE4_MODEL } from './helpers/chatEntry';
import { warmupContext } from './helpers/warmup';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { holdForRecording } from './helpers/recording';
import { pinnedChatEntry } from './helpers/servedModel';
import { journeyStep } from './helpers/journeyStep';
import { closeComposerMenu, openComposerTool, plusButton, toolGroup } from './helpers/composerMenu';
import { startChattingPastWelcome } from './helpers/welcome';

// A6 ("I can send a document, a photo, or speak to it").
//
// This file walks speaking and listening. Photos are walked in `photo-question.spec.ts`: paste,
// drop and the attach button, for a team account on preview, where the `multimodal` flag selects
// them (CUR-454, CUR-2725). Documents are not walked yet (CUR-987).
//
// THE FAILURE THIS JOURNEY IS SHAPED AROUND is users confusing the two voice directions. Dictation puts the user's
// words into the composer. Read-aloud is the other direction: the model's words, spoken back. The labels in
// ChatInput.svelte carry that distinction explicitly ("This dictates YOUR message (not the AI
// reading to you)"), which makes it assertable — so these tests check the labels say which way they
// work, rather than checking a button exists.
//
// WHY THE SKIPS READ THE RENDERED PAGE RATHER THAN AN ENV VAR. Both controls are gated by PostHog
// flags resolved server-side into page data, so the only honest source for "is this walkable here"
// is the rendered page. A skip driven by an env var would be a second, independently-drifting
// answer to the same question — the class of defect this repo keeps hitting. When a control is
// absent the test skips, the gallery reports A6 as `not-run`, and the coverage gap is visible
// rather than silent.
//
// Dictation is tested twice. The first test sends a recorded clip to `/chat/api/transcribe` and
// requires the spoken words back (CUR-198). The second presses Dictate with the page's microphone
// replaced by that clip, and requires the words in the composer (CUR-2723). Read-aloud's audio is asserted by the
// last test below (CUR-225): a headless browser cannot hear, but it can fetch the clip and decode
// its duration. Both outcome tests read their flag from the rendered page and FAIL when the control
// is hidden, since both flags are at 100% on preview and a hidden control there is the defect.
//
// THE DICTATION FIXTURE is espeak-ng reading one pangram, resampled to 16 kHz mono PCM, so no real
// voice is recorded anywhere:
//   espeak-ng -s 140 -w raw.wav "The quick brown fox jumps over the lazy dog."
//   ffmpeg -i raw.wav -ar 16000 -ac 1 -c:a pcm_s16le dictation-phrase.wav
// Whisper renders the synthetic voice's words reliably but not its punctuation or case, so the
// comparison normalises both and asks for two distinctive runs of words rather than the sentence.
// Transcription runs on Hugging Face's hosted Whisper, which has answered with a 60s timeout (504)
// and its own circuit breaker (503) on afternoons it answered other calls in under a second;
// either fails the test with HF's words quoted, so the log says whose outage it was.

const DICTATE = 'Dictate your message (voice input, not read-aloud)';
const DICTATION_FIXTURE = fileURLToPath(
	new URL('./fixtures/dictation-phrase.wav', import.meta.url)
);
const DICTATION_EXPECTED = ['quick brown fox', 'lazy dog'];

const normaliseTranscript = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/** The composer, with the welcome dialog handled the way chat-message-send.spec.ts handles it. */
async function openComposer(page: Page, entry: string = chatEntry()): Promise<void> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(entry, { waitUntil: 'commit' });
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
}

// The two read-aloud paths run again pinned to Large 4, whose turn is native, since every
// model is meant to read aloud the same way (CUR-2734).
const LARGE_4 = LARGE4_MODEL;
type Fixtures = { page: Page; context: BrowserContext; baseURL: string | undefined };

/** Walks the real read-aloud control to `mode`, reading the label each step rather than counting taps. */
// Read-aloud's mode is a radio group in the composer's + menu, in a "Read aloud" flyout (composerTools.ts),
// one option per mode, the chosen one checked. The group is only offered while the `read-aloud` flag is on (CUR-225).
const MODE_LABEL = { off: 'Off', auto: 'Auto', always: 'Always' } as const;
type ReadAloudMode = keyof typeof MODE_LABEL;
const readAloudGroup = (page: Page) => toolGroup(page, 'Read aloud');
const readAloudOption = (page: Page, mode: ReadAloudMode) =>
	readAloudGroup(page).getByRole('menuitemradio', { name: new RegExp(`^${MODE_LABEL[mode]}\\b`) });

/** Opens the + menu's Read aloud flyout; resolves once its group is on screen, or after `timeout`. */
async function openToolsMenu(page: Page, timeout: number): Promise<void> {
	await openComposerTool(page, 'Read aloud', { timeout }).catch(() => {});
}

async function setReadAloud(page: Page, mode: 'auto' | 'always'): Promise<void> {
	await openToolsMenu(page, 10_000);
	await expect(
		readAloudGroup(page),
		'the read-aloud toggle is hidden on a deployment where the `read-aloud` flag is on — the control and the flag have separated again (CUR-225)'
	).toBeVisible({ timeout: 10_000 });

	await readAloudOption(page, mode).click();
	await expect(
		readAloudOption(page, mode),
		`choosing read-aloud "${mode}" did not take`
	).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
	await closeComposerMenu(page);
}

/** Waits for the last reply to finish and requires a real answer in it. */
async function expectAnsweredTurn(page: Page): Promise<void> {
	// The turn has to finish, and finish with an answer, before a clip means anything (CUR-2022).
	// Retry renders only once `isTurnStillRunning` goes false (ChatMessage.svelte:970), and speak-all
	// synthesizes inside the turn, so by the time Retry shows the clip has either arrived or been
	// recorded as skipped. An errored turn also ends with Retry, so the answer itself is checked:
	// CUR-2022's journey recording showed a playable clip over "No output was generated."
	const reply = page.locator('[data-message-role="assistant"]').last();
	await expect(
		reply.getByRole('button', { name: 'Retry' }),
		'the read-aloud turn never finished' + warmupContext()
	).toBeVisible({ timeout: 150_000 });
	const replyText = (await reply.locator('.prose').allInnerTexts()).join('\n').trim();
	expect(
		replyText,
		'the turn ended without an answer, so there is nothing for read-aloud to have spoken'
	).not.toMatch(/No output was generated|Sorry, something went wrong/);
	expect(replyText.length, `the reply is empty or near-empty: "${replyText}"`).toBeGreaterThan(10);
}

/** Requires the reply's persisted clip to be real audio that the player under it can decode. */
async function expectPlayableClip(
	page: Page,
	conversationId: string,
	sentAt: number,
	mode: string
): Promise<void> {
	// The server's record of what the TTS Space returned. Either `audio` (a clip URL) or `skipped`
	// (the Space did not answer in time) ends the wait; neither after 150s means no synthesis ran.
	type Mcp = { tool?: string; audio?: string; skipped?: boolean; skipMs?: number };
	let mcp: Mcp | undefined;
	await expect
		.poll(
			async () => {
				const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
				if (!res.ok()) return false;
				const body = (await res.json()) as {
					json?: { messages?: Array<{ from: string; mcp?: Mcp }> };
				};
				mcp = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1)?.mcp;
				return Boolean(mcp?.audio || mcp?.skipped);
			},
			{
				message:
					`150s after sending with read-aloud on "${mode}", the reply carries neither a clip nor a recorded TTS timeout — synthesis never ran for this turn` +
					warmupContext(),
				timeout: 150_000,
				intervals: [2_000]
			}
		)
		.toBe(true);
	const persistedAfterMs = Date.now() - sentAt;
	test.info().annotations.push({
		type: 'read-aloud latency',
		description: `clip or timeout persisted ${persistedAfterMs}ms after send${mcp?.skipped ? `; the Space was abandoned after ${mcp.skipMs}ms` : ''}`
	});
	expect(
		mcp?.audio,
		`the TTS Space did not answer in time (the server gave up after ${mcp?.skipMs}ms), so the reply has no audio`
	).toBeTruthy();
	const clipUrl = mcp!.audio!;

	const clip = await page.request.get(clipUrl, { timeout: 30_000 });
	const body = await clip.body();
	const bytes = body.length;
	const contentType = clip.headers()['content-type'] ?? '';
	const format = audioFormat(body);
	test.info().annotations.push({
		type: 'read-aloud clip',
		description: `${clip.status()} ${contentType} ${bytes} bytes, ${format ?? 'no audio header'}`
	});
	expect(clip.status(), `fetching the clip at ${clipUrl} returned ${clip.status()}`).toBeLessThan(
		300
	);
	expect(
		format,
		`the clip at ${clipUrl} (served as "${contentType}") does not start with any audio file header`
	).toBeTruthy();
	expect(
		bytes,
		`the clip at ${clipUrl} is ${bytes} bytes — too small to hold a spoken sentence`
	).toBeGreaterThan(4_000);

	// The half a person meets: the player under the reply loads the clip and the browser decodes a
	// real duration from it, which the player prints as "elapsed / length". The Play button stays
	// disabled until the clip has loaded. Until the length is known the player prints a placeholder for
	// it (CUR-2785), so this requires a printed length rather than the absence of 0:00.
	const answer = page.locator('[data-message-role="assistant"]').last();
	await expect(
		answer.getByRole('button', { name: 'Play' }),
		'the reply has a clip on the server but no enabled play button under it'
	).toBeEnabled({ timeout: 30_000 });
	await expect(
		answer.locator('[data-audio-player]'),
		'the player under the reply never decoded a duration from its clip'
	).toContainText(/\/ \d+:\d\d/, { timeout: 15_000 });
}

test(
	'the dictation control says it records the user own message, and a recorded phrase comes back as the words spoken',
	{ tag: ['@A6', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await openComposer(page);

		// Step 1 and step 2. The control sits with the composer, and its accessible name states the
		// direction it works in before the user commits to pressing it. `dictation` is at 100% on
		// preview, so a hidden control here is the defect rather than a reason to skip.
		const dictate = page.getByRole('button', { name: DICTATE });
		await expect(
			dictate,
			'the dictation control is hidden — `transcriptionEnabled` is false in this page, so the `dictation` flag is off or TRANSCRIPTION_MODEL is unset on this deployment'
		).toBeVisible();
		await expect(dictate).toBeEnabled();

		// The hover text is what a person reads before pressing, so it is read the way they would: hover,
		// then the tooltip on screen, held long enough for the recording to show it (CUR-2363).
		// bits-ui's tooltip content carries no role="tooltip", so it is found by its words. A screen
		// reader gets the same words through the trigger's aria-describedby (CUR-2378).
		await journeyStep(page, 'A6', 2, async () => {
			await dictate.hover();
			await expect(
				page.getByText(/records you.*not read-aloud/i),
				"the dictation control's hover text should say it records you and is not read-aloud, so a user can tell the two apart before pressing it"
			).toBeVisible({ timeout: 5_000 });
			await expect(
				dictate,
				'the dictation hover text is not linked to its control, so a screen reader never hears it'
			).toHaveAccessibleDescription(/records you.*not read-aloud/i);
			await holdForRecording(page);
		});

		// What pressing it produces. VoiceRecorder posts the recording to this endpoint and puts the
		// returned text in the composer; the page's own request context carries this visitor's
		// cookies, and no flag override is sent.
		const startedAt = Date.now();
		const res = await page.request.post('/chat/api/transcribe', {
			headers: { 'Content-Type': 'audio/wav' },
			data: readFileSync(DICTATION_FIXTURE),
			timeout: 90_000
		});
		const elapsedMs = Date.now() - startedAt;
		const raw = await res.text();
		test.info().annotations.push({
			type: 'dictation latency',
			description: `${res.status()} after ${elapsedMs}ms`
		});

		expect(
			res.status(),
			'the transcribe endpoint refused before reading the audio — the `dictation` flag is off server-side while the page offered the control'
		).not.toBe(403);
		expect(
			[502, 503, 504].includes(res.status()) ? res.status() : 0,
			`Hugging Face's hosted Whisper did not transcribe the clip (${res.status()} after ${elapsedMs}ms): ${raw.slice(0, 300)}`
		).toBe(0);
		expect(
			res.status(),
			`the transcribe endpoint answered ${res.status()}: ${raw.slice(0, 300)}`
		).toBe(200);

		const text = (JSON.parse(raw) as { text?: string }).text ?? '';
		test.info().annotations.push({ type: 'dictation transcript', description: text });
		const heard = normaliseTranscript(text);
		for (const phrase of DICTATION_EXPECTED) {
			expect(
				heard,
				`the clip says "The quick brown fox jumps over the lazy dog." and the transcript came back as "${text}"`
			).toContain(phrase);
		}
	}
);

/** Replaces this page's microphone with the dictation fixture, played on a loop. */
async function useFixtureMicrophone(page: Page): Promise<void> {
	await page.addInitScript((wavBase64: string) => {
		navigator.mediaDevices.getUserMedia = async () => {
			const ctx = new AudioContext();
			const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0));
			const source = ctx.createBufferSource();
			source.buffer = await ctx.decodeAudioData(bytes.buffer);
			source.loop = true;
			const out = ctx.createMediaStreamDestination();
			source.connect(out);
			source.start();
			return out.stream;
		};
	}, readFileSync(DICTATION_FIXTURE).toString('base64'));
}

// The test above sends the clip straight to the endpoint, so the part a visitor touches —
// pressing Dictate, MediaRecorder's chunks, the upload, the transcript landing in the composer — never
// ran (CUR-2723). Here the page's microphone is the fixture: getUserMedia is replaced, for this page only, with a
// Web Audio stream playing the WAV on a loop, the way the denied-microphone tests below replace it with
// a rejection. Everything from the stream onward is the app's own code, pressed through its controls.
// (Chromium's fake capture flags would do the same, but they are launch options, which Playwright only
// takes for a whole file.)
test(
	'pressing Dictate and confirming puts the spoken words in the composer, unsent',
	{ tag: ['@A6', '@preview-only', '@CUR-2723'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		await useFixtureMicrophone(page);
		await openComposer(page);
		const composer = page.getByLabel('Message AI Potluck');

		// A6 row 1's second half: the speaking control does what it names when pressed.
		await journeyStep(page, 'A6', 1, async () => {
			const dictate = page.getByRole('button', { name: DICTATE });
			await expect(
				dictate,
				'the dictation control is hidden — `transcriptionEnabled` is false in this page, so the `dictation` flag is off or TRANSCRIPTION_MODEL is unset on this deployment'
			).toBeVisible();
			await dictate.click();

			const recorder = page.getByRole('group', { name: 'Voice recording' });
			await expect(recorder, 'pressing Dictate did not start a recording').toBeVisible();
			// A documented fixed wait: the recorder records in real time and nothing on the page marks the
			// end of a pass. The fixture runs 3.5 s, so 4.5 s holds every word.
			await page.waitForTimeout(4_500);

			const transcribed = page.waitForResponse(
				(r) => r.url().includes('/chat/api/transcribe') && r.request().method() === 'POST',
				{ timeout: 90_000 }
			);
			await recorder.getByRole('button', { name: 'Confirm and transcribe (Enter)' }).click();
			const res = await transcribed;
			const raw = await res.text();
			expect(
				[502, 503, 504].includes(res.status()) ? res.status() : 0,
				`Hugging Face's hosted Whisper did not transcribe the recording (${res.status()}): ${raw.slice(0, 300)}`
			).toBe(0);
			expect(
				res.status(),
				`the transcribe endpoint answered ${res.status()}: ${raw.slice(0, 300)}`
			).toBe(200);

			await expect(recorder, 'the recorder stayed up after transcribing').toBeHidden({
				timeout: 30_000
			});
			const heard = async () => normaliseTranscript(await composer.inputValue());
			for (const phrase of DICTATION_EXPECTED) {
				await expect
					.poll(heard, {
						message: `the composer should hold the dictated words; the endpoint returned ${raw.slice(0, 200)}`,
						timeout: 10_000
					})
					.toContain(phrase);
			}
			// Desktop confirms into the draft and leaves sending to the person, so nothing was sent.
			await expect(page.locator('[data-message-role="user"]')).toHaveCount(0);
			await expect(composer, 'focus did not come back to the composer').toBeFocused();
			await holdForRecording(page);
		});
	}
);

// A transcription that times out used to show "Transcription failed (CUR-2801). Please try again.",
// which sends the visitor to retry the same long recording. The first upload is answered with the
// server's own 504; the retry goes through to the real endpoint.
test(
	'a dictation that times out says to try a shorter recording, keeps the draft, and a retry still works',
	{ tag: ['@A6', '@preview-only', '@CUR-2801'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		await useFixtureMicrophone(page);
		await openComposer(page);
		const composer = page.getByLabel('Message AI Potluck');
		const draft = 'Before I say it:';
		await composer.fill(draft);

		const timeout = 'Transcription took too long. Please try a shorter recording.';
		await page.route(
			'**/chat/api/transcribe',
			(route) => route.fulfill({ status: 504, json: { message: timeout } }),
			{ times: 1 }
		);
		const dictate = page.getByRole('button', { name: DICTATE });
		const recorder = page.getByRole('group', { name: 'Voice recording' });
		const confirm = recorder.getByRole('button', { name: 'Confirm and transcribe (Enter)' });

		// Row 7 (once the refusal rows land, CUR-2800): the speaking control is pressed and the words
		// never come back.
		await journeyStep(page, 'A6', 7, async () => {
			await dictate.click();
			await expect(recorder, 'pressing Dictate did not start a recording').toBeVisible();
			// The recorder records in real time; 1.5 s gives the upload something to carry.
			await page.waitForTimeout(1_500);
			await confirm.click();
			await expect(
				page.getByTestId('chat-error-toast').locator('[data-toast-title]'),
				'a timed-out transcription did not say to try a shorter recording'
			).toHaveText(timeout, { timeout: 15_000 });
			await expect(recorder, 'the recorder stayed up after the failure').toBeHidden();
			await expect(composer, 'the draft was lost to a failed dictation').toHaveValue(draft);
			await holdForRecording(page);
		});

		await dictate.click();
		await expect(recorder).toBeVisible();
		// The fixture runs 3.5 s, so 4.5 s holds every word, as in the test above.
		await page.waitForTimeout(4_500);
		await confirm.click();
		const heard = async () => normaliseTranscript(await composer.inputValue());
		for (const phrase of DICTATION_EXPECTED) {
			await expect
				.poll(heard, {
					message: 'the retry after a failed dictation brought back no words',
					timeout: 90_000
				})
				.toContain(phrase);
		}
		expect(
			await composer.inputValue(),
			'the retry replaced the draft instead of adding to it'
		).toMatch(/^Before I say it: /);
	}
);

/** Makes this page's MediaRecorder report only `types` as recordable, the way a browser without WebM
 *  recording does. The recorder itself stays real, so whatever type is picked is really recorded. */
async function recordableTypes(page: Page, types: string[]): Promise<void> {
	await page.addInitScript((allowed: string[]) => {
		MediaRecorder.isTypeSupported = (type: string) => allowed.includes(type);
	}, types);
}

// The recorder asked only for WebM, so a browser that can't record it (older Safari) threw
// and showed the browser's own exception text (CUR-2802). The transcribe endpoint already takes mp4.
test(
	'a browser that records only mp4 still dictates, and the clip goes up as mp4',
	{ tag: ['@A6', '@preview-only', '@CUR-2802'] },
	async ({ page }) => {
		test.setTimeout(150_000);
		await recordableTypes(page, ['audio/mp4']);
		await useFixtureMicrophone(page);
		await openComposer(page);
		const composer = page.getByLabel('Message AI Potluck');

		await journeyStep(page, 'A6', 1, async () => {
			await page.getByRole('button', { name: DICTATE }).click();
			const recorder = page.getByRole('group', { name: 'Voice recording' });
			await expect(recorder, 'pressing Dictate did not start a recording').toBeVisible();
			// The fixture runs 3.5 s, so 4.5 s holds every word, as in the tests above.
			await page.waitForTimeout(4_500);
			const uploaded = page.waitForRequest(
				(r) => r.url().includes('/chat/api/transcribe') && r.method() === 'POST',
				{ timeout: 30_000 }
			);
			await recorder.getByRole('button', { name: 'Confirm and transcribe (Enter)' }).click();
			expect(
				(await uploaded).headers()['content-type'],
				'the recording did not go up as the mp4 the browser can make'
			).toMatch(/^audio\/mp4/);
			const heard = async () => normaliseTranscript(await composer.inputValue());
			for (const phrase of DICTATION_EXPECTED) {
				await expect
					.poll(heard, { message: 'an mp4 recording brought back no words', timeout: 90_000 })
					.toContain(phrase);
			}
			await holdForRecording(page);
		});
	}
);

test(
	'a browser that can record no audio is told so in plain words, and never asked for the microphone',
	{ tag: ['@A6', '@preview-only', '@CUR-2802'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await recordableTypes(page, []);
		await page.addInitScript(() => {
			const w = window as unknown as { __micAsked: number };
			w.__micAsked = 0;
			navigator.mediaDevices.getUserMedia = async () => {
				w.__micAsked++;
				throw new DOMException('should not be asked', 'NotAllowedError');
			};
		});
		await openComposer(page);

		await journeyStep(page, 'A6', 7, async () => {
			await page.getByRole('button', { name: DICTATE }).click();
			const message = page.getByTestId('chat-error-toast').locator('[data-toast-title]');
			await expect(message, 'a browser that cannot record was not told so').toHaveText(
				"This browser can't record audio, so dictation isn't available here.",
				{ timeout: 10_000 }
			);
			await expect(message, 'the browser exception reached the screen').not.toContainText(
				'Microphone error:'
			);
			await holdForRecording(page);
		});
		expect(
			await page.evaluate(() => (window as unknown as { __micAsked: number }).__micAsked),
			'the microphone was asked for although nothing could be recorded'
		).toBe(0);
	}
);

// The toast said dictation couldn't work while the Dictate button beside it still looked
// live and its hover text still promised to record (CUR-3403). The button now dims and says why, and stays
// pressable, so a person who allows the microphone can press it again and record.
test(
	'CUR-3403: after the microphone is refused, the Dictate button dims and says why, and pressing it once allowed records',
	{ tag: ['@A6', '@preview-only', '@CUR-3403'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await useFixtureMicrophone(page);
		await page.addInitScript(() => {
			const allowed = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
			let asked = 0;
			navigator.mediaDevices.getUserMedia = async (constraints) => {
				if (asked++ === 0) throw new DOMException('Permission denied', 'NotAllowedError');
				const stream = await allowed(constraints);
				(window as unknown as { __micGranted: boolean }).__micGranted = true;
				return stream;
			};
		});
		await openComposer(page);
		const dictate = page.getByRole('button', { name: DICTATE });

		await dictate.click();
		await expect(
			page.getByTestId('chat-error-toast').locator('[data-toast-title]'),
			'a refused microphone was not reported'
		).toContainText('Microphone access denied', { timeout: 10_000 });
		await expect(
			dictate,
			'the Dictate button still looks live after the microphone was refused'
		).toHaveAttribute('aria-disabled', 'true');
		await dictate.hover();
		await expect(
			dictate,
			'the Dictate button still promises to record after the microphone was refused'
		).toHaveAccessibleDescription(/Microphone blocked: allow it in your browser settings/);
		await holdForRecording(page);

		// The dimmed button is aria-disabled yet pressable by design, and Playwright's click waits for an
		// enabled element, so it is forced. The poll below is what proves the press went through.
		await dictate.click({ force: true });
		await expect
			.poll(
				() => page.evaluate(() => (window as unknown as { __micGranted?: boolean }).__micGranted),
				{
					message: 'pressing Dictate once the microphone was allowed never reached the microphone',
					timeout: 10_000
				}
			)
			.toBe(true);
		const recorder = page.getByRole('group', { name: 'Voice recording' });
		await expect(
			recorder,
			'pressing Dictate once the microphone was allowed did not record'
		).toBeVisible();
		await recorder.getByRole('button', { name: /cancel recording/i }).click();
		await expect(
			dictate,
			'the Dictate button stayed dimmed after a recording went through'
		).not.toHaveAttribute('aria-disabled', 'true');
	}
);

test(
	'CUR-3403: on a browser that can record no audio, the Dictate button dims and says dictation is not available here',
	{ tag: ['@A6', '@preview-only', '@CUR-3403'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		await recordableTypes(page, []);
		await openComposer(page);
		const dictate = page.getByRole('button', { name: DICTATE });

		await dictate.click();
		await expect(
			page.getByTestId('chat-error-toast').locator('[data-toast-title]'),
			'a browser that cannot record was not told so'
		).toContainText("This browser can't record audio", { timeout: 10_000 });
		await expect(
			dictate,
			'the Dictate button still looks live on a browser that cannot record'
		).toHaveAttribute('aria-disabled', 'true');
		await dictate.hover();
		await expect(
			dictate,
			'the Dictate button still promises to record on a browser that cannot'
		).toHaveAccessibleDescription(/Dictation isn't available here/);
		await holdForRecording(page);
	}
);

test(
	'read-aloud names its current mode, and one tap advances it by exactly one step',
	{ tag: ['@A6', '@CUR-3570'] },
	async ({ page }) => {
		await openComposer(page);

		// The read-aloud group is offered only while the flag is on (CUR-225 — the control used to be a
		// second, independent off switch, so a server-side enable produced audio nobody could reach).
		// Visibility is therefore the real signal here.
		const present = await journeyStep(page, 'A6', 1, async () => {
			await openToolsMenu(page, 10_000);
			const present = await readAloudGroup(page)
				.isVisible()
				.catch(() => false);
			return present;
		});
		test.skip(
			!present,
			'read-aloud is not enabled on this deployment, so there is no mode to read or advance — this is a coverage gap, not a verdict on the product'
		);

		// Step 3. The mode is readable from the control before touching it: exactly one option is checked.
		const modeBefore = await journeyStep(page, 'A6', 3, async () => {
			const checked = readAloudGroup(page).locator('[role="menuitemradio"][aria-checked="true"]');
			await expect(checked).toHaveCount(1);
			const before = ((await checked.innerText()) ?? '').trim();
			const modeBefore = /^(Off|Auto|Always)\b/.exec(before)?.[1]?.toLowerCase() ?? '';
			expect(
				modeBefore,
				`read-aloud should show its current mode, so the only way to learn the state is not to try it. Checked option read: ${before}`
			).toMatch(/^(off|auto|always)$/);
			return modeBefore;
		});

		// Step 4. One choice moves it by exactly one step, and the control says so. The next mode is
		// derived rather than hardcoded — a test that asserted "auto" would only ever pass from a fresh
		// session's default.
		await journeyStep(page, 'A6', 4, async () => {
			const NEXT: Record<string, ReadAloudMode> = { off: 'auto', auto: 'always', always: 'off' };
			const next = NEXT[modeBefore];
			await readAloudOption(page, next).click();

			await expect(
				readAloudOption(page, next),
				`choosing "${next}" from "${modeBefore}" should check it; a silent change leaves the user guessing`
			).toHaveAttribute('aria-checked', 'true', {
				timeout: 10_000
			});

			// With the menu closed, the composer's chip says the mode, so Auto and Always read
			// differently at a glance (CUR-3570). Off shows no chip at all.
			await page.keyboard.press('Escape');
			const chip = page.locator('[data-composer-chip]', { hasText: 'Read aloud' });
			if (next === 'off') {
				await expect(
					chip,
					'read-aloud is off, so the composer should show no Read aloud chip'
				).toHaveCount(0);
			} else {
				await expect(
					chip,
					`read-aloud is "${next}", so its chip should say so rather than only "Read aloud"`
				).toHaveText(new RegExp(`Read aloud · ${MODE_LABEL[next]}`), { timeout: 5_000 });
			}
		});
	}
);

// The outcome the two tests above never reach — that read-aloud, set to "always" through the
// real toggle, produces audio a person can play (CUR-225). `read-aloud` is at 100% on preview and is read live,
// with no override cookie, so this exercises the flag as it is deployed.
//
// A HIDDEN TOGGLE FAILS HERE; IT DOES NOT SKIP. The test above skips on a hidden toggle so the gallery
// can report a coverage gap on a deployment where the feature is off. This one is tagged @preview-only,
// where the flag is on, so a hidden toggle there is the regression itself.
//
// WHAT COUNTS AS AUDIO. The persisted `message.mcp.audio` is the clip URL the server got back from the
// TTS Space, so the clip is fetched and required to be a 2xx whose bytes open with an audio file header,
// and more than a few KB. The header is read instead of the content-type because the Space's Gradio
// file route serves its .wav as `application/octet-stream` (measured on a preview). Then
// the player's own <audio> element has to report a finite duration above zero — it is handed a blob of
// the same bytes (loadAudioClip.ts), so this is the browser decoding what a person would hear. A turn
// where the Space timed out persists `mcp.skipped` with the wait in ms; that fails with the wait
// quoted, rather than a longer budget here hiding it.
/** The audio container a buffer's magic bytes name, or undefined when they name none. */
function audioFormat(b: Buffer): string | undefined {
	const ascii = (from: number, to: number) => b.subarray(from, to).toString('latin1');
	if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
	if (ascii(0, 4) === 'OggS') return 'ogg';
	if (ascii(0, 4) === 'fLaC') return 'flac';
	if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
	return undefined;
}

test.describe('in a short window', () => {
	// The tools live in flyouts off the + menu, which is three rows (Attach files, Web search, Read
	// aloud), about 126px tall, so it overflows only in a window this short. The new-chat composer sits
	// mid-window, so the room above it shrinks by half of any cut: bits-ui gave the menu 127px of
	// height at 190px in CI, which fits. At 150px it has about 107px, ~19px
	// short.
	test.use({ viewport: { width: 1280, height: 150 } });

	test(
		'a Tools menu taller than the room above the composer scrolls with a faded edge, and its last row can be reached whole',
		{ tag: '@A6' },
		async ({ page }) => {
			// With agent mode and read-aloud on, the Tools menu is taller than the room above the
			// composer, and its edge used to cut the last row mid-word ("Alway") with nothing saying more
			// was below (CUR-2351). The short window (set for the whole context, so the recording matches) forces the
			// overflow, so this checks the scroll every time.
			await openComposer(page);
			await plusButton(page).click({ timeout: 10_000 });
			// The + menu, not a tool's flyout, which can open beside it: the one holding the Web search row.
			const menu = page
				.getByRole('menu')
				.filter({ has: page.getByRole('menuitem', { name: /^Web search/ }) });
			await expect(menu, 'the Tools menu did not open').toBeVisible({ timeout: 10_000 });

			// Whichever element scrolls — the menu itself, or a region inside it — is the one that must
			// fade, so the check reads the scroller rather than the markup around it.
			const scroller = await menu.evaluateHandle(
				(el) =>
					[el, ...el.querySelectorAll<HTMLElement>('*')].find(
						(n) =>
							n.scrollHeight > n.clientHeight + 1 &&
							/auto|scroll/.test(getComputedStyle(n).overflowY)
					) ?? null
			);
			const found = await scroller.evaluate((el) => {
				if (!el) return null;
				const s = getComputedStyle(el);
				return s.maskImage || s.getPropertyValue('-webkit-mask-image') || 'none';
			});
			expect(
				found,
				'nothing in the + menu scrolls in a 150px-tall window, so this no longer exercises the scroll; shorten the window'
			).not.toBeNull();
			expect(
				found,
				'the scrolling Tools menu has no edge fade, so a row cut by the edge reads as clipped text (CUR-2351)'
			).toContain('gradient');
			await holdForRecording(page);

			// Scrolled to the end, the last row sits wholly inside the scroller rather than under its edge.
			await scroller.evaluate((el) => el?.scrollTo({ top: el.scrollHeight }));
			await expect(async () => {
				const cut = await scroller.evaluate((el) => {
					if (!el) return true;
					const rows = el.querySelectorAll('[role^="menuitem"]');
					const last = rows[rows.length - 1]?.getBoundingClientRect();
					return !last || last.bottom > el.getBoundingClientRect().bottom + 1;
				});
				expect(cut, 'the last Tools row is still cut by the menu edge').toBe(false);
			}).toPass({ timeout: 5_000 });
			await holdForRecording(page);
		}
	);
});

async function alwaysReadsAloud({ page }: Fixtures, native: boolean): Promise<void> {
	test.setTimeout(240_000);
	// The canned clip stands in for the TTS Space, so this gates on our speak-all pipeline
	// (mode → synthesis request → persisted clip → player) and not on a third party's uptime (CUR-2253). The
	// real Space is walked by the @third-party test at the end of this block.
	await installFaultInjectionHeader(page, 'tts_canned_clip');
	await openComposer(page, native ? pinnedChatEntry(LARGE_4) : chatEntry());

	await setReadAloud(page, 'always');

	// A plain question, and deliberately so (CUR-2022). The prompt used to read "CUR-225 read-aloud
	// check …: reply with one short sentence.", which matches isReadAloudIntent (mcp/router.ts), so
	// every run took the explicit "read this aloud: X" path instead of "always": it synthesized the
	// text after the colon (30 characters, logged as the TTS call's inputChars) before the model had
	// answered, and the test passed on that clip. The speak-all path this test is named for never ran.
	// Nothing in this prompt names reading, speaking or audio, so the only way it gets a clip is the
	// "always" mode, which speaks the finished answer.
	const composer = page.getByLabel('Message AI Potluck');
	await composer.fill('In one short sentence, what is bread made from?');
	const sentAt = Date.now();
	await composer.press('Enter');
	await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
	if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

	await expectAnsweredTurn(page);
	await expectPlayableClip(page, conversationId, sentAt, 'always');
}
test(
	'read-aloud set to always produces a playable audio clip for the reply',
	{ tag: ['@A6', '@preview-only'] },
	async ({ page, context, baseURL }) => alwaysReadsAloud({ page, context, baseURL }, false)
);
test(
	'read-aloud set to always produces a playable audio clip for the reply (native harness)',
	{ tag: ['@A6', '@preview-only', '@CUR-2734'] },
	async ({ page, context, baseURL }) => alwaysReadsAloud({ page, context, baseURL }, true)
);

/** A WAV of `seconds` of quiet tone: long enough to watch a clip play and to send over it. */
function longClip(seconds: number): Buffer {
	const rate = 8_000;
	const samples = rate * seconds;
	const wav = Buffer.alloc(44 + samples);
	wav.write('RIFF', 0);
	wav.writeUInt32LE(36 + samples, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20); // PCM
	wav.writeUInt16LE(1, 22); // mono
	wav.writeUInt32LE(rate, 24);
	wav.writeUInt32LE(rate, 28);
	wav.writeUInt16LE(1, 32);
	wav.writeUInt16LE(8, 34); // 8-bit unsigned
	wav.write('data', 36);
	wav.writeUInt32LE(samples, 40);
	for (let i = 0; i < samples; i++)
		wav[44 + i] = 128 + Math.round(8 * Math.sin((2 * Math.PI * 440 * i) / rate));
	return wav;
}

// Auto-play ran on an audio element of its own, so the answer was heard while the player
// under it read stopped, and pressing play started it again from the top (CUR-2299). Sending the next message
// didn't stop it either. The canned clip is 1.2s, too short to watch play, so this serves a 30s one
// in its place.
test(
	'an answer read aloud on its own shows as playing in its player, and sending the next message stops it',
	{ tag: ['@A6', '@preview-only', '@CUR-2299'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		await installFaultInjectionHeader(page, 'tts_canned_clip');
		await page.route('**/e2e/canned-read-aloud.wav', (route) =>
			route.fulfill({ status: 200, contentType: 'audio/wav', body: longClip(30) })
		);
		// Positive control: count clips the browser actually started, whichever element played them, so a
		// failure below means the player misreports a clip that is sounding, not that nothing played.
		await page.addInitScript(() => {
			const w = window as unknown as { __clipsStarted: number };
			w.__clipsStarted = 0;
			const play = HTMLMediaElement.prototype.play;
			HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
				const started = play.call(this);
				void started.then(() => w.__clipsStarted++).catch(() => {});
				return started;
			};
		});
		await openComposer(page);
		await setReadAloud(page, 'always');

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('In one short sentence, what is bread made from?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		await expectAnsweredTurn(page);

		await expect
			.poll(
				() => page.evaluate(() => (window as unknown as { __clipsStarted: number }).__clipsStarted),
				{
					message: 'the answer was never read aloud at all, so there is no playing clip to show',
					timeout: 30_000
				}
			)
			.toBeGreaterThan(0);
		// Pinned by position: `.last()` would move on to the next answer once the second message is sent.
		const answers = page.locator('[data-message-role="assistant"]');
		const answer = answers.nth((await answers.count()) - 1);
		await expect(
			answer.getByRole('button', { name: 'Pause' }),
			'the answer is being read aloud but its player shows it stopped'
		).toBeVisible({ timeout: 5_000 });
		await expect(
			answer.locator('[data-audio-player]'),
			'the player shows playing but its clock never moves'
		).not.toContainText(/^\s*0:00 \//, { timeout: 10_000 });

		// On auto, a plain question gets no clip of its own, so only the send itself can stop this one.
		await setReadAloud(page, 'auto');
		await composer.fill('And what makes it rise?');
		await composer.press('Enter');
		await expect(
			answer.getByRole('button', { name: 'Play' }),
			'the last answer kept reading aloud over the new message'
		).toBeVisible({ timeout: 5_000 });
		await holdForRecording(page);
	}
);

// When the voice doesn't answer, the note under the reply said "An open component was cold
// this turn and didn't respond", backend words a visitor can't act on (CUR-2268). `tts_space_down` makes the TTS
// call skip the way a timed-out Space does, so this reads the note a visitor actually gets.
test(
	'when read-aloud fails, the note says the audio is missing in plain words and the answer still shows',
	{ tag: ['@A6', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await installFaultInjectionHeader(page, 'tts_space_down');
		await openComposer(page);
		await setReadAloud(page, 'always');

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('In one short sentence, what is bread made from?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		await expectAnsweredTurn(page);

		const reply = page.locator('[data-message-role="assistant"]').last();
		const note = reply.locator('[data-mcp-skipped]');
		// Row 8: read-aloud is on and the voice never comes back.
		await journeyStep(page, 'A6', 8, async () => {
			await expect(
				note,
				'a failed read-aloud left no note, so the missing audio is silent'
			).toBeVisible({
				timeout: 30_000
			});
			await expect(note).toContainText("Read-aloud didn't respond in time");
			await expect(note, 'the note still uses backend words').not.toContainText(
				/open component|cold/i
			);
			await expect(
				reply.locator('[data-audio-player]'),
				'a clip rendered on a turn whose voice failed'
			).toHaveCount(0);
		});
	}
);

// Kokoro has no German voice (CUR-3989). The answer must not play in an English accent unasked: the note
// says there is no German voice, and the English voice reads it only after the visitor asks.
test(
	'a German answer has no German voice, so the English voice plays only when the visitor asks for it, on that one tap',
	{ tag: ['@A6', '@preview-only', '@CUR-4085'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		// The English clip is synthesized when the player fetches it, so the canned clip stands in
		// on that fetch alone (CUR-4085). The turn itself runs as normal, which is what puts the "no German voice" note up.
		await installFaultInjectionHeader(page, 'tts_canned_clip', /\/api\/speech\/[^/]+$/, 'GET');
		// Count clips the browser actually started. Only a fetched clip (a blob: URL) counts, not the
		// silence a tap primes the element with.
		await page.addInitScript(() => {
			const w = window as unknown as { __clipsStarted: number };
			w.__clipsStarted = 0;
			const play = HTMLMediaElement.prototype.play;
			HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
				const started = play.call(this);
				const src = this.src;
				void started
					.then(() => (src.startsWith('blob:') ? w.__clipsStarted++ : undefined))
					.catch(() => {});
				return started;
			};
		});
		await openComposer(page);
		await setReadAloud(page, 'always');

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('Antworte auf Deutsch in zwei kurzen Sätzen: Woraus wird Brot gemacht?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		await expectAnsweredTurn(page);

		const reply = page.locator('[data-message-role="assistant"]').last();
		const note = reply.locator('[data-mcp-skipped]');
		await expect(note, 'a German answer left no note about the missing voice').toBeVisible({
			timeout: 30_000
		});
		await expect(note).toContainText('no German voice yet');
		await expect(
			reply.locator('[data-audio-player]'),
			'a German answer got a player before the visitor asked for the English voice'
		).toHaveCount(0);

		await expect
			.poll(() =>
				page.evaluate(() => (window as unknown as { __clipsStarted: number }).__clipsStarted)
			)
			.toBe(0);
		// Asking for the English voice is the tap that plays it: a phone on Read aloud: Always was left
		// with a player that needed a second tap (27 Oct), so nothing here presses Play.
		await note.getByRole('button', { name: 'Read it in the English voice' }).click();
		await expect
			.poll(
				() => page.evaluate(() => (window as unknown as { __clipsStarted: number }).__clipsStarted),
				{
					message: 'the English-voice clip was asked for but did not start without a second tap',
					timeout: 30_000
				}
			)
			.toBeGreaterThan(0);
		await holdForRecording(page);
	}
);

// Every Kokoro Portuguese voice is Brazilian and the detector can't tell Portugal from
// Brazil, so the player names the accent rather than leaving a Lisbon visitor to wonder (CUR-3989).
test(
	'a Portuguese answer plays in a voice the player names as Brazilian Portuguese',
	{ tag: ['@A6'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await openComposer(page);
		await setReadAloud(page, 'always');

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('Responde em português, em duas frases curtas: de que é feito o pão?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		await expectAnsweredTurn(page);

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(
			reply.locator('[data-audio-player]'),
			'a Portuguese answer got no player'
		).toBeVisible({
			timeout: 30_000
		});
		await expect(reply.locator('[data-read-aloud-voice]')).toContainText('Brazilian Portuguese');
		await holdForRecording(page);
	}
);

/** Sends "read this aloud" on auto and requires a playable clip once the turn has answered. */
async function readThisAloudOnAuto(page: Page, entry?: string): Promise<void> {
	await openComposer(page, entry);
	await setReadAloud(page, 'auto');

	const composer = page.getByLabel('Message AI Potluck');
	await composer.fill('Read this aloud: the bread is in the oven.');
	const sentAt = Date.now();
	await composer.press('Enter');
	await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
	if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

	await expectAnsweredTurn(page);
	await expectPlayableClip(page, conversationId, sentAt, 'auto');
}

async function readThisAloudPlaysX({ page }: Fixtures, native: boolean): Promise<void> {
	test.setTimeout(240_000);
	// The explicit read-aloud request, which starts TTS in parallel with the answer and holds the clip
	// until the model has replied. CUR-2045 made that clip depend on the turn producing an answer, so
	// this is the success half: a request that is answered must still play. The failure half (no clip
	// over "No output was generated") is covered in readAloudHeldClip.spec.ts, where the model call can
	// be made to fail on demand. The canned clip (CUR-2253) keeps the Space's uptime out of this verdict.
	await installFaultInjectionHeader(page, 'tts_canned_clip');
	await readThisAloudOnAuto(page, native ? pinnedChatEntry(LARGE_4) : undefined);
}
test(
	'"read this aloud: X" on auto plays a clip of X once the turn has answered',
	{ tag: ['@A6', '@preview-only'] },
	async ({ page, context, baseURL }) => readThisAloudPlaysX({ page, context, baseURL }, false)
);
test(
	'"read this aloud: X" on auto plays a clip of X once the turn has answered (native harness)',
	{ tag: ['@A6', '@preview-only', '@CUR-2734'] },
	async ({ page, context, baseURL }) => readThisAloudPlaysX({ page, context, baseURL }, true)
);

// The one walk that calls the real TTS Space (CUR-2253). Tagged @third-party so neither a PR's gating
// suite nor the journey gallery runs it (playwright.config.ts leaves it out unless
// SCENARIO_THIRD_PARTY=1), and @live so scenario-suite-live.yml's develop leg does, every 4h. A red here
// is a finding about the Space or our route to it; the two tests above say whether our pipeline works.
test(
	'"read this aloud: X" plays a clip synthesized by the real TTS Space',
	{ tag: ['@live', '@preview-only', '@third-party'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		await readThisAloudOnAuto(page);
	}
);

// A read-aloud turn holds every token back until the end, so the live line used to sit on
// "<model> is computing…" through the whole generation and then the speech wait (21s in a graded run) (CUR-2210).
// This reads only the live line, not the clip, so a TTS outage cannot decide it: the server marks the
// writing phase as soon as the first held token exists, whether or not speech synthesis later works.
test(
	'"read this aloud: X" on auto says the reply is being written instead of freezing on computing',
	{ tag: ['@A6', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		await openComposer(page);
		await setReadAloud(page, 'auto');

		await page.evaluate(() => {
			const w = window as unknown as { __liveLines: string[] };
			w.__liveLines = [];
			const line = /[^\n]*\b(is computing|is writing the reply|making the audio|is generating)…/gi;
			new MutationObserver(() => {
				for (const m of document.body.innerText.matchAll(line)) {
					const text = m[0].trim();
					if (w.__liveLines.at(-1) !== text) w.__liveLines.push(text);
				}
			}).observe(document.body, { childList: true, subtree: true, characterData: true });
		});

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('Read this aloud: the bread is in the oven.');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		await expectAnsweredTurn(page);

		const lines = await page.evaluate(
			() => (window as unknown as { __liveLines: string[] }).__liveLines
		);
		test.info().annotations.push({ type: 'live lines', description: JSON.stringify(lines) });
		expect(
			lines.some((l) => /is writing the reply…/i.test(l)),
			`the live line never said the reply was being written: ${JSON.stringify(lines)}`
		).toBe(true);
	}
);

// A read-aloud turn holds its text back until the end, and the clip could land first, so the
// player showed a play button and a length under an empty reply whose status still said the model was
// computing (CUR-2048). The player now waits for the turn to finish. This records the reply at the moment its
// player first appears, whichever element draws it.
test(
	'the read-aloud player appears only once the answer it reads is on screen',
	{ tag: ['@A6', '@preview-only', '@CUR-2048'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		await installFaultInjectionHeader(page, 'tts_canned_clip');
		await openComposer(page);
		await setReadAloud(page, 'always');

		await page.evaluate(() => {
			const w = window as unknown as { __playerFirstSeen: { text: string; status: string } | null };
			w.__playerFirstSeen = null;
			new MutationObserver(() => {
				if (w.__playerFirstSeen) return;
				const reply = [...document.querySelectorAll('[data-message-role="assistant"]')].at(-1);
				if (!reply?.querySelector('button[aria-label="Play"], button[aria-label="Pause"]')) return;
				const prose = [...reply.querySelectorAll('.prose')].map(
					(el) => (el as HTMLElement).innerText
				);
				const status =
					/[^\n]*\b(is computing|is writing the reply|making the audio|is generating)…/i.exec(
						(reply as HTMLElement).innerText
					);
				w.__playerFirstSeen = { text: prose.join('\n').trim(), status: status?.[0] ?? '' };
			}).observe(document.body, { childList: true, subtree: true });
		});

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('In one short sentence, what is bread made from?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		await expectAnsweredTurn(page);

		const seen = await page.evaluate(
			() =>
				(window as unknown as { __playerFirstSeen: { text: string; status: string } | null })
					.__playerFirstSeen
		);
		test.info().annotations.push({
			type: 'reply when the player appeared',
			description: JSON.stringify(seen)
		});
		expect(
			seen,
			'the answer finished with a clip but no player ever appeared under it'
		).not.toBeNull();
		expect(
			seen?.status,
			`the player appeared while the reply still said "${seen?.status}", so it offered audio for an answer not yet written`
		).toBe('');
		expect(
			seen?.text.length ?? 0,
			`the player appeared over a reply reading "${seen?.text}", so a play button sat under an empty answer`
		).toBeGreaterThan(10);
	}
);

// CUR-2210, the other half: once the answer is written, a speak-all turn waits on speech synthesis. The
// live line used to keep naming the model through that wait, crediting it with time the TTS Space was
// taking. The canned clip (CUR-2253) keeps the Space's uptime out of it; the server still sends the
// speaking status before it answers with the clip, so the line has its moment to change.
// The placeholder under the reply said "Preparing the open voice…", in English only, while the
// live line above it said "Making the audio…" in the visitor's language (CUR-3434). Both read the same label now.
test(
	'read-aloud set to always says the audio is being made while it is, once, and never names the open voice (CUR-3434, CUR-3557)',
	{ tag: ['@A6', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		// The slow clip, not the instant one: "while it is" needs a wait to name. With the clip answering
		// at once, and held for the output screen's verdict since CUR-3847, the speaking status and the
		// clip landed in one frame often enough that the line never painted.
		await installFaultInjectionHeader(page, 'tts_slow_canned_clip');
		await openComposer(page);
		await setReadAloud(page, 'always');

		await page.evaluate(() => {
			const w = window as unknown as { __liveLines: string[]; __audioLinesAtOnce: number };
			w.__liveLines = [];
			w.__audioLinesAtOnce = 0;
			const line =
				/[^\n]*\b(is computing|is writing the reply|making the audio|is generating|open voice)…/gi;
			new MutationObserver(() => {
				const text = document.body.innerText;
				for (const m of text.matchAll(line)) {
					const found = m[0].trim();
					if (w.__liveLines.at(-1) !== found) w.__liveLines.push(found);
				}
				// The list above folds repeats together, so count the copies on screen at once (CUR-3557).
				const atOnce = text.match(/making the audio…/gi)?.length ?? 0;
				w.__audioLinesAtOnce = Math.max(w.__audioLinesAtOnce, atOnce);
			}).observe(document.body, { childList: true, subtree: true, characterData: true });
		});

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('In one short sentence, what is bread made from?');
		const sentAt = Date.now();
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);
		await expectAnsweredTurn(page);
		// The clip is what the wait was for; without it the audio line could be naming a wait that
		// produced nothing.
		await expectPlayableClip(page, conversationId, sentAt, 'always');

		const lines = await page.evaluate(
			() => (window as unknown as { __liveLines: string[] }).__liveLines
		);
		test.info().annotations.push({ type: 'live lines', description: JSON.stringify(lines) });
		const audio = lines.findIndex((l) => /^Making the audio…$/.test(l));
		expect(
			audio,
			`the live line never said the audio was being made: ${JSON.stringify(lines)}`
		).toBeGreaterThanOrEqual(0);
		expect(
			lines.slice(audio).filter((l) => /is (computing|generating|writing the reply)…/.test(l)),
			`after "Making the audio…" the live line went back to naming the model: ${JSON.stringify(lines)}`
		).toEqual([]);
		expect(
			lines.filter((l) => /open voice/i.test(l)),
			`a status line named the "open voice" instead of saying the audio is being made: ${JSON.stringify(lines)}`
		).toEqual([]);
		const atOnce = await page.evaluate(
			() => (window as unknown as { __audioLinesAtOnce: number }).__audioLinesAtOnce
		);
		expect(
			atOnce,
			'"Making the audio…" showed more than once at the same time, so the wait reads as two audio jobs'
		).toBe(1);
	}
);

// With read-aloud on Always, the reply's text waited for its audio (CUR-3810). The server held the
// final answer until the clip came back, and the output screen releases a short answer's last sentence
// only on that final, so a visitor read "Making the audio…" over an empty bubble for the whole TTS
// round-trip. `tts_slow_canned_clip` sends the canned clip twenty seconds late, counted from the moment
// the final goes out. The text still waits for the output screen, which has taken 8-12 s on develop, so
// the lead is twenty seconds less the screen: wide enough to tell the two orders apart.
test(
	"CUR-3810: read-aloud set to always shows the reply's text before its audio is ready",
	{ tag: ['@A6', '@CUR-3810', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		await installFaultInjectionHeader(page, 'tts_slow_canned_clip');
		await openComposer(page);
		await setReadAloud(page, 'always');

		await page.evaluate(() => {
			const w = window as unknown as { __textAt?: number; __playerAt?: number };
			new MutationObserver(() => {
				const reply = [...document.querySelectorAll('[data-message-role="assistant"]')].at(-1);
				if (!reply) return;
				const text = [...reply.querySelectorAll('.prose')]
					.map((el) => (el as HTMLElement).innerText)
					.join('\n')
					.trim();
				if (w.__textAt === undefined && text.length > 10) w.__textAt = Date.now();
				if (w.__playerAt === undefined && reply.querySelector('[data-audio-player]'))
					w.__playerAt = Date.now();
			}).observe(document.body, { childList: true, subtree: true, characterData: true });
		});

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('In one short sentence, what is bread made from?');
		const sentAt = Date.now();
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);
		await expectAnsweredTurn(page);
		await expectPlayableClip(page, conversationId, sentAt, 'always');
		await holdForRecording(page);

		const { textAt, playerAt } = await page.evaluate(() => {
			const w = window as unknown as { __textAt?: number; __playerAt?: number };
			return { textAt: w.__textAt, playerAt: w.__playerAt };
		});
		test.info().annotations.push({
			type: 'text before player (ms)',
			description: String(
				textAt !== undefined && playerAt !== undefined ? playerAt - textAt : 'n/a'
			)
		});
		expect(textAt, "the reply's text never showed").toBeDefined();
		expect(playerAt, 'the audio player never showed under the reply').toBeDefined();
		// The clip is twenty seconds late and the screen has taken up to twelve, so a reply shown first
		// leads by eight seconds or more. Three seconds keeps clear of that and of the old order, where
		// text and player land within the same few hundred milliseconds.
		expect(
			playerAt! - textAt!,
			"the reply's text appeared together with its audio, so it was held back until the clip existed"
		).toBeGreaterThan(3_000);
	}
);

// The read-aloud clip is synthesized from the model's whole answer, so a clip of an answer
// the output screen declined would read the declined text aloud (CUR-3847). `tts_canned_clip_output_blocked` sends
// the canned clip and blocks every chunk, so with Always on the server makes a clip of an answer the
// visitor must not hear. The decline has to show, and neither the page nor the stored message may
// carry a clip.
test(
	'CUR-3847: read-aloud set to always plays nothing for an answer the output screen declined',
	{ tag: ['@A6', '@CUR-3847', '@preview-only', '@output-screen'] },
	async ({ page }) => {
		test.setTimeout(240_000);
		await installFaultInjectionHeader(page, 'tts_canned_clip_output_blocked');
		await openComposer(page);
		await setReadAloud(page, 'always');

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('In one short sentence, what is bread made from?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1];
		if (!conversationId) throw new Error(`could not read a conversation id out of ${page.url()}`);

		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(
			reply.getByText(
				/my response was flagged by an open content-safety policy before it was shown/
			),
			'no output-screen decline arrived: the fault header did not reach the server, output screening is off on this deployment, or OUTPUT_CONTENT_DECLINE (moderation.ts) changed'
		).toBeVisible({ timeout: 90_000 });
		// Retry shows once the turn has ended, and speak-all synthesizes inside the turn, so by then a
		// clip that got through would already be on the page and in the stored message.
		await expect(
			reply.getByRole('button', { name: 'Retry' }),
			'the declined turn never finished'
		).toBeVisible({
			timeout: 150_000
		});
		await holdForRecording(page);
		await expect(
			reply.locator('[data-audio-player]'),
			"a player for the declined answer's clip showed under the decline"
		).toHaveCount(0);

		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		expect(res.ok(), `reading the conversation back answered ${res.status()}`).toBe(true);
		const body = (await res.json()) as {
			json?: { messages?: Array<{ from: string; mcp?: { audio?: string } }> };
		};
		const stored = (body.json?.messages ?? []).filter((m) => m.from === 'assistant').at(-1);
		expect(stored, 'the declined reply was not stored').toBeDefined();
		expect(
			stored?.mcp?.audio,
			'the stored reply carries a clip of the declined answer'
		).toBeUndefined();

		await page.reload();
		await expect(
			page.locator('[data-message-role="assistant"]').last().locator('[data-audio-player]'),
			'after a reload the declined reply shows a player'
		).toHaveCount(0);
	}
);

// A visitor who blocks the microphone has to be told, in words they can read, and the
// telling must not sit over a control they might reach for next (CUR-1065). The browser's refusal is stood in
// for by making getUserMedia reject with NotAllowedError, which is what Chrome raises after "Block".
// On phones the toast used to cover the X-ray button and clamp the message to "Please allow in…".
async function expectMicDeniedToastReadableAndClear(page: Page): Promise<void> {
	await page.addInitScript(() => {
		navigator.mediaDevices.getUserMedia = async () => {
			throw new DOMException('Permission denied', 'NotAllowedError');
		};
	});
	await openComposer(page);
	const toast = page.getByTestId('chat-error-toast');
	const message = toast.locator('[data-toast-title]');
	// Row 7: the speaking control is pressed and the browser refuses the microphone.
	await journeyStep(page, 'A6', 7, async () => {
		// Dictate sits in the composer's toolbar at every width, phones included.
		await page.getByRole('button', { name: DICTATE }).click();
		await expect(message, 'a denied microphone should say so on screen').toHaveText(
			'Microphone access denied. Please allow in browser settings.'
		);
	});
	// The toast fades in over 300ms; measure once it has settled.
	await expect(toast).toHaveCSS('opacity', '1');
	expect(
		await message.evaluate((e) => e.scrollHeight > e.clientHeight + 1),
		'the message is cut off by its line clamp, so the visitor cannot read what to do'
	).toBe(false);
	// Dark text on the chat window's dark pill read as 1.2:1, and the journey critic saw garbled
	// fragments of it on every phone recording (CUR-2296). Each colour is painted onto a 1x1 canvas
	// over the page background and read back as sRGB, since computed styles come back in oklch.
	const contrast = await message.evaluate((h2) => {
		const ctx = document.createElement('canvas').getContext('2d')!;
		const paint = (...colours: string[]) => {
			ctx.clearRect(0, 0, 1, 1);
			for (const c of colours) {
				ctx.fillStyle = c;
				ctx.fillRect(0, 0, 1, 1);
			}
			const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
			const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
			return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
		};
		const page = [document.documentElement, document.body].map(
			(e) => getComputedStyle(e).backgroundColor
		);
		// The pill is the nearest box that paints a background; the title's own wrapper can be clear.
		let pillBox: Element | null = h2.parentElement;
		const clear = (c: string) => c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
		while (pillBox && clear(getComputedStyle(pillBox).backgroundColor))
			pillBox = pillBox.parentElement;
		const pillColour = pillBox ? getComputedStyle(pillBox).backgroundColor : 'transparent';
		const pill = paint(...page, pillColour);
		const text = paint(...page, pillColour, getComputedStyle(h2).color);
		return (Math.max(pill, text) + 0.05) / (Math.min(pill, text) + 0.05);
	});
	expect(
		contrast,
		'the message is too faint against its pill to read (WCAG AA asks for 4.5:1)'
	).toBeGreaterThanOrEqual(4.5);

	// "Hidden" means more than a quarter of the control under the pill. On a desktop the X-ray control
	// is a tab running most of the chat window's height, and the pill crossing about 5% of it leaves
	// the rest to click; on a phone the pill covered the whole X-ray button.
	// The landing's Potluck mark is left out: it is decorative, a button only so a tap can spin it
	// (#2011), and the pill passing over the logo for 5 s was ruled ordinary toast behaviour (CUR-3274,
	// CUR-3947).
	const pill = (await toast.locator('> div').boundingBox())!;
	// Every control's box is read in one pass: a control that leaves the page mid-check (a hover
	// tooltip's trigger, a re-rendered toolbar) would otherwise hold the next read until the timeout.
	const boxes = await page
		.locator('button:visible:not([data-potluck-mark-egg]), a:visible:not([data-potluck-mark-egg])')
		.evaluateAll((els) =>
			els.map((el) => {
				const r = el.getBoundingClientRect();
				return {
					name: el.getAttribute('aria-label') || (el as HTMLElement).innerText,
					x: r.x,
					y: r.y,
					width: r.width,
					height: r.height
				};
			})
		);
	const hidden: string[] = [];
	for (const box of boxes) {
		// The pill holds no controls of its own, so every overlap is with something underneath it.
		if (box.width * box.height === 0) continue;
		const x = Math.min(pill.x + pill.width, box.x + box.width) - Math.max(pill.x, box.x);
		const y = Math.min(pill.y + pill.height, box.y + box.height) - Math.max(pill.y, box.y);
		const share = x > 0 && y > 0 ? (x * y) / (box.width * box.height) : 0;
		if (share > 0.25) hidden.push(`${box.name} (${Math.round(share * 100)}%)`);
	}
	expect(hidden, `the toast ${JSON.stringify(pill)} hides these controls`).toEqual([]);
}

test.describe('on a phone', () => {
	test.use({ viewport: { width: 390, height: 844 } });
	test(
		'a denied microphone is reported in full on a phone, hiding no control',
		{ tag: ['@A6', '@preview-only'] },
		async ({ page }) => expectMicDeniedToastReadableAndClear(page)
	);

	// The gallery filmed the Dictate hover text lying over the Web search chip at phone
	// width, cutting its label to "Web s" (CUR-2720). Web search no longer shows a chip, but the toolbar can still
	// wrap at 390 px, so a tooltip placed just above the mic must land on no control. Any overlap
	// counts: the tooltip is opaque.
	test(
		'on a phone the Dictate hover text covers none of the composer controls',
		{ tag: ['@A6', '@preview-only', '@CUR-2720'] },
		async ({ page }) => {
			await openComposer(page);
			const dictate = page.getByRole('button', { name: DICTATE });
			await expect(dictate).toBeVisible();
			await dictate.hover();
			const tip = page.getByText(/records you.*not read-aloud/i);
			await expect(tip).toBeVisible({ timeout: 5_000 });
			const box = (await tip.boundingBox())!;
			// One pass over every control, as the toast check above does: a control that leaves the page
			// between reads held the next `boundingBox` until the test timed out.
			const controls = await page.locator('button:visible, a:visible').evaluateAll((els) =>
				els.map((el) => {
					const r = el.getBoundingClientRect();
					return {
						name: el.getAttribute('aria-label') || (el as HTMLElement).innerText,
						x: r.x,
						y: r.y,
						width: r.width,
						height: r.height
					};
				})
			);
			const covered: string[] = [];
			for (const { name, ...c } of controls) {
				if (c.width * c.height === 0) continue;
				if (name === DICTATE) continue;
				const x = Math.min(box.x + box.width, c.x + c.width) - Math.max(box.x, c.x);
				const y = Math.min(box.y + box.height, c.y + c.height) - Math.max(box.y, c.y);
				if (x > 0 && y > 0) covered.push(name.trim());
			}
			expect(
				covered,
				`the Dictate hover text ${JSON.stringify(box)} covers these controls`
			).toEqual([]);
		}
	);
});

test.describe('on a desktop', () => {
	test.use({ viewport: { width: 1280, height: 720 } });
	test(
		'a denied microphone is reported in full on a desktop, hiding no control',
		{ tag: ['@A6', '@preview-only'] },
		async ({ page }) => expectMicDeniedToastReadableAndClear(page)
	);
});
