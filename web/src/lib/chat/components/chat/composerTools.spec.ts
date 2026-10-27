import { beforeEach, describe, expect, it, vi } from 'vitest';
import { composerTools, mimeOffered, offeredMimeTypes, photoTypesHint, refusedPasteMessage, type ToolBinding, type ToolFlags, type ToolId } from './composerTools';

// ChatInput renders its Tools menu and chips by iterating composerTools(), so these assert the
// behaviour directly. The live probe covers the rendering.

function bindings(initial: Partial<Record<ToolId, string>> = {}) {
	const state: Record<ToolId, string> = {
		webSearch: 'off',
		agent: 'off',
		readAloud: 'off',
		reasoning: 'medium',
		...initial
	};
	const bind = (id: ToolId): ToolBinding => ({
		get: () => state[id],
		set: (v: string) => {
			state[id] = v;
		}
	});
	const b: Record<ToolId, ToolBinding> = {
		webSearch: bind('webSearch'),
		agent: bind('agent'),
		readAloud: bind('readAloud'),
		reasoning: bind('reasoning')
	};
	return { state, b };
}

const flags = (over: Partial<ToolFlags> = {}): ToolFlags => ({
	readAloudEnabled: false,
	agentEnabled: false,
	reasoningEffortEnabled: false,
	...over
});

describe('read-aloud has ONE gate (CUR-225): the readAloudEnabled flag', () => {
	it('offers the read-aloud tool when the flag is on', () => {
		const ids = composerTools(flags({ readAloudEnabled: true }), bindings().b).map((t) => t.id);
		expect(ids).toContain('readAloud');
	});
	it('withholds it when the flag is off — and nothing else can turn it back on', () => {
		const ids = composerTools(flags({ readAloudEnabled: false, agentEnabled: true, reasoningEffortEnabled: true }), bindings().b).map((t) => t.id);
		expect(ids).not.toContain('readAloud');
	});
	it('selecting a read-aloud option writes through its binding (the speakMode store)', () => {
		const { state, b } = bindings();
		composerTools(flags({ readAloudEnabled: true }), b).find((t) => t.id === 'readAloud')!.set('always');
		expect(state.readAloud).toBe('always');
	});
});

describe('reasoning effort (CUR-680): offered only when the per-model override is on, and writes the bound value', () => {
	it('is absent without the override', () => {
		expect(composerTools(flags(), bindings().b).map((t) => t.id)).not.toContain('reasoning');
	});
	it('offers low / medium / high with the override on', () => {
		const tool = composerTools(flags({ reasoningEffortEnabled: true }), bindings().b).find((t) => t.id === 'reasoning')!;
		expect(tool.options.map((o) => o.value)).toEqual(['low', 'medium', 'high']);
	});
	it('choosing a level writes the bindable value the parent forwards as reasoning_effort', () => {
		const { state, b } = bindings();
		composerTools(flags({ reasoningEffortEnabled: true }), b).find((t) => t.id === 'reasoning')!.set('high');
		expect(state.reasoning).toBe('high');
	});
	it('rejects a value that is not one of its options (fail loud, never a silent write)', () => {
		const { b } = bindings();
		const tool = composerTools(flags({ reasoningEffortEnabled: true }), b).find((t) => t.id === 'reasoning')!;
		expect(() => tool.set('extreme')).toThrow();
	});
});

describe('chips show exactly the tools that are on', () => {
	it('a tool at its rest value is inactive; any other value is active', () => {
		const { b } = bindings({ webSearch: 'auto', reasoning: 'medium' });
		const tools = composerTools(flags({ reasoningEffortEnabled: true }), b);
		expect(tools.filter((t) => t.active).map((t) => t.id)).toEqual(['webSearch']);
	});
	it("tapping a chip returns the tool to its rest value (off, or reasoning's medium)", () => {
		const { state, b } = bindings({ agent: 'on', reasoning: 'low' });
		const tools = composerTools(flags({ agentEnabled: true, reasoningEffortEnabled: true }), b);
		for (const t of tools.filter((t) => t.active)) t.set(t.restValue);
		expect([state.agent, state.reasoning]).toEqual(['off', 'medium']);
	});
	it('web search and agent show no chip while on; read aloud and reasoning still do', () => {
		const { b } = bindings({ webSearch: 'always', agent: 'on', readAloud: 'auto', reasoning: 'high' });
		const tools = composerTools(flags({ agentEnabled: true, readAloudEnabled: true, reasoningEffortEnabled: true }), b);
		expect(tools.filter((t) => t.active).map((t) => t.id)).toEqual(['webSearch', 'agent', 'readAloud', 'reasoning']);
		expect(tools.filter((t) => t.showsChip).map((t) => t.id)).toEqual(['readAloud', 'reasoning']);
	});
	it('web search is always available (the P0 control), whatever the flags', () => {
		expect(composerTools(flags(), bindings().b).map((t) => t.id)).toEqual(['webSearch']);
	});
});

describe('offeredMimeTypes (CUR-2382)', () => {
	it('offers no file type at all when no CSAM scanner is configured, so the composer shows no attach control', () => {
		expect(offeredMimeTypes({ attachmentsEnabled: false, uploadsEnabled: true, modelIsMultimodal: true })).toEqual([]);
	});

	it('offers no file type at all where the multimodal flag is shut for this visitor, since the server then refuses text files too', () => {
		expect(offeredMimeTypes({ attachmentsEnabled: true, uploadsEnabled: false, modelIsMultimodal: true })).toEqual([]);
	});

	it('offers text and the default image types for a multimodal model once a scanner is configured', () => {
		const offered = offeredMimeTypes({ attachmentsEnabled: true, uploadsEnabled: true, modelIsMultimodal: true });
		expect(offered).toContain('text/*');
		expect(offered).toEqual(expect.arrayContaining(['image/jpeg', 'image/png']));
	});

	it('offers no image type to a model that takes none', () => {
		const offered = offeredMimeTypes({ attachmentsEnabled: true, uploadsEnabled: true, modelIsMultimodal: false });
		expect(offered.some((t) => t.startsWith('image/'))).toBe(false);
		expect(offered.length).toBeGreaterThan(0);
	});

	it("offers the model's own image types in place of the defaults", () => {
		const offered = offeredMimeTypes({
			attachmentsEnabled: true,
			uploadsEnabled: true,
			modelIsMultimodal: true,
			modelImageMimeTypes: ['image/webp']
		});
		expect(offered.filter((t) => t.startsWith('image/'))).toEqual(['image/webp']);
	});

	it("narrows a model's image/* to what a browser draws, so a TIFF is never offered (CUR-3051)", () => {
		const offered = offeredMimeTypes({
			attachmentsEnabled: true,
			uploadsEnabled: true,
			modelIsMultimodal: true,
			modelImageMimeTypes: ['image/*']
		});
		expect(offered).not.toContain('image/*');
		expect(mimeOffered(offered, 'image/png')).toBe(true);
		expect(mimeOffered(offered, 'image/tiff')).toBe(false);
	});

	it('offers PDF and DOCX only where the server reads them (CUR-987), and never without a scanner', () => {
		const pdf = 'application/pdf';
		expect(offeredMimeTypes({ attachmentsEnabled: true, uploadsEnabled: true, modelIsMultimodal: false })).not.toContain(pdf);
		expect(
			offeredMimeTypes({ attachmentsEnabled: true, uploadsEnabled: true, documentsEnabled: true, modelIsMultimodal: false })
		).toContain(pdf);
		expect(
			offeredMimeTypes({ attachmentsEnabled: false, uploadsEnabled: true, documentsEnabled: true, modelIsMultimodal: false })
		).toEqual([]);
	});
});

describe('refusedPasteMessage (CUR-2949: a refused paste never vanishes silently)', () => {
	const photo = { type: 'image/png', name: 'image.png' };
	const guest = { imageInputEnabled: false, imageInputOnSignIn: false, signedIn: false, loginEnabled: true };

	it('says nothing when nothing was refused', () => {
		expect(refusedPasteMessage([], guest)).toBeUndefined();
	});

	it('names both refusals when a photo comes after a refused file, so the photo is not silent', () => {
		const zip = { type: 'application/zip', name: 'notes.zip' };
		const message = refusedPasteMessage([zip, photo], guest);
		expect(message).toContain("Photos can't be attached here yet.");
		expect(message).toContain("This file type can't be attached here");
	});

	it("tells a guest photos can't be attached when signing in would not open them (team-only flag)", () => {
		expect(refusedPasteMessage([photo], guest)).toBe("Photos can't be attached here yet.");
	});

	it('tells a guest to sign in only when the flag gives a signed-in account images', () => {
		expect(refusedPasteMessage([photo], { ...guest, imageInputOnSignIn: true })).toBe('Sign in to attach photos.');
	});

	it('never tells a guest to sign in where sign-in is switched off', () => {
		expect(refusedPasteMessage([photo], { ...guest, imageInputOnSignIn: true, loginEnabled: false })).toBe(
			"Photos can't be attached here yet."
		);
	});

	it('never tells a signed-in visitor without images to sign in', () => {
		expect(refusedPasteMessage([photo], { ...guest, signedIn: true, imageInputOnSignIn: true })).toBe(
			"Photos can't be attached here yet."
		);
	});

	it('names the model as the reason when this visitor has images, the model takes none and another does', () => {
		expect(
			refusedPasteMessage([photo], { ...guest, signedIn: true, imageInputEnabled: true, photoModelPickable: true })
		).toMatch(/selected model can't read photos/);
	});

	it('names which model cannot read the photo when the composer knows it', () => {
		expect(
			refusedPasteMessage([photo], {
				...guest,
				signedIn: true,
				imageInputEnabled: true,
				photoModelPickable: true,
				modelName: 'Apertus 1.5 70B'
			})
		).toBe("Apertus 1.5 70B can't read photos. Pick one that can to attach this.");
	});

	it('never blames the model when no pick would take the photo (Auto, no model reads photos, or no attaching)', () => {
		expect(
			refusedPasteMessage([photo], {
				...guest,
				signedIn: true,
				imageInputEnabled: true,
				photoModelPickable: false,
				modelName: 'Apertus 1.5 70B'
			})
		).toBe("Photos can't be attached here yet.");
	});

	it('names a refused TIFF by its type where photos are offered, never "photos can\'t be attached" (CUR-3051)', () => {
		const tiff = { type: 'image/tiff', name: 'scan.tiff' };
		expect(refusedPasteMessage([tiff], { ...guest, signedIn: true, imageInputEnabled: true, imagesOffered: true })).toBe(
			"This file type can't be attached here: TIFF file. Photos attach as JPEG, PNG, WebP or GIF."
		);
	});

	it('names the photo types that attach when a HEIC arrives with no type at all (CUR-3073)', () => {
		const heic = { type: '', name: 'IMG_0001.HEIC' };
		expect(refusedPasteMessage([heic], { ...guest, signedIn: true, imageInputEnabled: true, imagesOffered: true })).toBe(
			"This file type can't be attached here: HEIC file. Photos attach as JPEG, PNG, WebP or GIF."
		);
	});

	it('never tells a visitor to convert a HEIC where no photo type attaches at all', () => {
		const heic = { type: '', name: 'IMG_0001.HEIC' };
		expect(refusedPasteMessage([heic], { ...guest, signedIn: true })).not.toContain('Photos attach');
	});

	it('photoTypesHint holds only for an off-list photo where photos are offered', () => {
		expect(photoTypesHint({ type: 'image/tiff', name: 'a.tiff' }, true)).toBe(true);
		expect(photoTypesHint({ type: 'image/tiff', name: 'a.tiff' }, false)).toBe(false);
		expect(photoTypesHint({ type: 'image/png', name: 'a.png' }, true)).toBe(false);
		expect(photoTypesHint({ type: 'image/png', name: 'a.png' }, false)).toBe(false);
		expect(photoTypesHint({ type: 'application/zip', name: 'a.zip' }, true)).toBe(false);
	});

	it('never adds the photo types to a refused file that is not a photo', () => {
		expect(refusedPasteMessage([{ type: 'application/zip', name: 'a.zip' }], guest)).not.toContain('Photos attach');
	});

	it('names a refused non-photo file in words, like the drop path does', () => {
		expect(refusedPasteMessage([{ type: 'application/zip', name: 'a.zip' }], guest)).toMatch(
			/^This file type can't be attached here: /
		);
	});
});

describe('photosOnSignIn (CUR-3015: PostHog is asked once per guest who tries, never per page load)', () => {
	// A fresh module per test, so each starts with nothing remembered.
	let photosOnSignIn: typeof import('./composerTools').photosOnSignIn;
	beforeEach(async () => {
		vi.resetModules();
		({ photosOnSignIn } = await import('./composerTools'));
	});

	it('asks the server once and remembers the answer for later refusals', async () => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({ photos: true }), { status: 200 }));
		expect(await photosOnSignIn('/chat/api/sign-in-hint', fetchFn as unknown as typeof fetch)).toBe(true);
		expect(await photosOnSignIn('/chat/api/sign-in-hint', fetchFn as unknown as typeof fetch)).toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it('answers no (the plain refusal) when the server errors or cannot be reached, never yes', async () => {
		const failing = vi.fn(async () => new Response('nope', { status: 500 }));
		expect(await photosOnSignIn('/x', failing as unknown as typeof fetch)).toBe(false);
		vi.resetModules();
		({ photosOnSignIn } = await import('./composerTools'));
		const throwing = vi.fn(async () => {
			throw new Error('offline');
		});
		expect(await photosOnSignIn('/x', throwing as unknown as typeof fetch)).toBe(false);
	});
});

describe('a tool chip says the mode it is in (CUR-3570)', () => {
	it('reads Auto and Always differently, so the composer tells them apart without the menu', () => {
		const { state, b } = bindings({ readAloud: 'auto' });
		const readAloud = composerTools(flags({ readAloudEnabled: true }), b).find((t) => t.id === 'readAloud')!;
		expect(readAloud.chipLabel).toBe('Read aloud · Auto');
		state.readAloud = 'always';
		expect(readAloud.chipLabel).toBe('Read aloud · Always');
	});

	it('names the mode for every tool that shows a chip', () => {
		const { b } = bindings({ webSearch: 'always', agent: 'on', readAloud: 'always', reasoning: 'high' });
		const labels = composerTools(flags({ agentEnabled: true, readAloudEnabled: true, reasoningEffortEnabled: true }), b)
			.filter((t) => t.showsChip)
			.map((t) => t.chipLabel);
		expect(labels).toEqual(['Read aloud · Always', 'Reasoning effort · High']);
	});
});

// The Tools menu says what auto does and why someone would turn web search off. ChatInput prints each
// option's description under its label (SOL-206). (CUR-2030)
describe('the web search options say what auto does and why to turn it off (CUR-2030)', () => {
	const option = (value: string) =>
		composerTools(flags(), bindings().b)
			.find((t) => t.id === 'webSearch')!
			.options.find((o) => o.value === value)!;

	it('Auto says it searches when you paste a link', () => {
		expect(option('auto').description).toMatch(/paste a link/i);
	});

	it('Off says it is faster', () => {
		expect(option('off').description).toMatch(/faster/i);
	});
});
