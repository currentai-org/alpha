import { m } from '$lib/paraglide/messages.js';
/**
 * The composer's tools, as data: which tools exist under which flags, the options each offers, and
 * the setter each option writes through. ChatInput renders the Tools menu (one radio group per tool)
 * and the active-tool chips by iterating this list — so the gating and the write-through are
 * behaviour tested in composerTools.spec.ts, not markup read back from source.
 *
 * Contracts carried over from the tests this replaces:
 *  - read-aloud has ONE gate — `readAloudEnabled` — never a second hardcoded off switch (CUR-225);
 *  - reasoning effort writes the bindable value the parent forwards as `reasoning_effort` (CUR-680),
 *    and is offered only when the per-model override is on.
 */

import {
	TEXT_MIME_ALLOWLIST,
	IMAGE_MIME_ALLOWLIST_DEFAULT,
	IMAGE_MIME_RENDERABLE,
	DOCUMENT_MIME_ALLOWLIST
} from '$lib/chat/constants/mime';
import { fileTypeLabel } from '$lib/chat/utils/fileTypeLabel';
import { CONVERTIBLE_IMAGE_MIME, convertibleType } from '$lib/chat/utils/shrinkImage';

export type ToolId = 'webSearch' | 'agent' | 'readAloud' | 'reasoning';

export interface ToolFlags {
	/** page.data.readAloudEnabled — the single read-aloud gate. */
	readAloudEnabled: boolean;
	/** page.data.agentEnabled — the agent service is configured. */
	agentEnabled: boolean;
	/** The per-model reasoning override is on (ChatWindow's showReasoningEffort). */
	reasoningEffortEnabled: boolean;
}

export interface ToolBinding {
	get(): string;
	set(value: string): void;
}

export interface ToolOption {
	value: string;
	label: string;
	description?: string;
}

export interface ComposerTool {
	id: ToolId;
	label: string;
	options: ToolOption[];
	/** The value that means "not active" — no chip is shown at this value, and a chip resets to it. */
	restValue: string;
	/** Whether the tool shows a chip beside the composer while it is on. Web search and agent don't:
	 *  their mode reads on the + menu's row, and a chip for a tool that is on by default is noise. */
	chip: boolean;
	get(): string;
	set(value: string): void;
	/** True when the tool is on. */
	readonly active: boolean;
	/** True when the composer shows this tool's chip: it is on, and it is a tool that has one. */
	readonly showsChip: boolean;
	/** The chip's text: the tool and its current mode, e.g. "Read aloud · Always", so the composer says
	 *  how the tool will behave without reopening the menu (CUR-3570). */
	readonly chipLabel: string;
}

const DEFINITIONS: Record<ToolId, Omit<ComposerTool, 'get' | 'set' | 'active' | 'showsChip' | 'chipLabel'>> = {
	webSearch: {
		id: 'webSearch',
		label: 'Web search',
		restValue: 'off',
		chip: false,
		options: [
			{
				value: 'off',
				label: 'Off',
				// Say why you'd turn it off — a few seconds faster, and the question stays away from search engines. (CUR-2030)
				description: "Faster and more private — pasted links aren't opened"
			},
			{
				value: 'auto',
				label: 'Auto',
				description: "Search when community sources don't cover your question, or when you paste a link"
			},
			{ value: 'always', label: 'Always', description: 'Search the open web every turn' }
		]
	},
	agent: {
		id: 'agent',
		label: 'Agent',
		restValue: 'off',
		chip: false,
		options: [
			{ value: 'off', label: 'Off', description: 'The model answers directly' },
			{ value: 'auto', label: 'Auto', description: 'When a task needs multi-step work' },
			{ value: 'on', label: 'On', description: 'Every turn runs as an agent' }
		]
	},
	readAloud: {
		id: 'readAloud',
		label: 'Read aloud',
		restValue: 'off',
		chip: true,
		options: [
			{ value: 'off', label: 'Off' },
			{ value: 'auto', label: 'Auto', description: 'When you ask' },
			{ value: 'always', label: 'Always', description: 'Every reply' }
		]
	},
	reasoning: {
		id: 'reasoning',
		label: 'Reasoning effort',
		restValue: 'medium',
		chip: true,
		options: [
			{ value: 'low', label: 'Low' },
			{ value: 'medium', label: 'Medium' },
			{ value: 'high', label: 'High' }
		]
	}
};

/** Tools available under `flags`, in menu order, each wired to its binding. */
export function composerTools(flags: ToolFlags, bindings: Record<ToolId, ToolBinding>): ComposerTool[] {
	const labels = { webSearch: m.product_webSearch(), agent: m.product_agent(), readAloud: m.product_readAloud(), reasoning: m.product_reasoning() };
	const optionLabels: Record<string, string> = { off: m.product_off(), auto: m.product_auto(), on: m.product_on(), always: m.product_always(), low: m.product_low(), medium: m.product_medium(), high: m.product_high() };
	const descriptions: Partial<Record<ToolId, Record<string, string>>> = {
		webSearch: { off: m.product_searchOffHelp(), auto: m.product_searchAutoHelp(), always: m.product_searchAlwaysHelp() },
		agent: { off: m.product_agentOffHelp(), auto: m.product_agentAutoHelp(), on: m.product_agentOnHelp() },
		readAloud: { auto: m.product_whenAsked(), always: m.product_everyReply() }
	};
	const ids: ToolId[] = ['webSearch'];
	if (flags.agentEnabled) ids.push('agent');
	if (flags.readAloudEnabled) ids.push('readAloud');
	if (flags.reasoningEffortEnabled) ids.push('reasoning');

	return ids.map((id) => {
		const def = DEFINITIONS[id];
		const binding = bindings[id];
		return {
			...def,
			label: labels[id],
			options: def.options.map((option) => ({ ...option, label: optionLabels[option.value], description: descriptions[id]?.[option.value] })),
			get: () => binding.get(),
			set: (value: string) => {
				if (!def.options.some((o) => o.value === value)) {
					throw new Error(`composerTools: "${value}" is not an option of ${id}`);
				}
				binding.set(value);
			},
			get active() {
				return binding.get() !== def.restValue;
			},
			get showsChip() {
				return def.chip && binding.get() !== def.restValue;
			},
			get chipLabel() {
				const mode = def.options.find((o) => o.value === binding.get());
				return mode ? `${labels[id]} · ${optionLabels[mode.value]}` : labels[id];
			}
		};
	});
}

/**
 * The file types the composer offers: text always, PDF and DOCX where the server reads them (CUR-987),
 * images when the model takes them. Nothing is offered where the server refuses every upload, which
 * hides the attach button, the dropzone and file paste together: with no CSAM scanner configured
 * (`attachmentsEnabled` false, CUR-2382), or where the `multimodal` flag is shut for this visitor
 * (`uploadsEnabled` false), since parseRequest then answers any file, text included, with a 415.
 * A model's `image/*` is narrowed to the types a browser can draw (CUR-3051).
 */
export function offeredMimeTypes(opts: {
	attachmentsEnabled: boolean;
	uploadsEnabled: boolean;
	documentsEnabled?: boolean;
	modelIsMultimodal: boolean;
	modelImageMimeTypes?: readonly string[];
}): string[] {
	if (!opts.attachmentsEnabled || !opts.uploadsEnabled) return [];
	const images = opts.modelIsMultimodal ? (opts.modelImageMimeTypes ?? IMAGE_MIME_ALLOWLIST_DEFAULT) : [];
	return Array.from(
		new Set([
			...TEXT_MIME_ALLOWLIST,
			...(opts.documentsEnabled ? DOCUMENT_MIME_ALLOWLIST : []),
			...images.flatMap((m) => (m === 'image/*' ? IMAGE_MIME_RENDERABLE : [m]))
		])
	);
}

/** Whether `mime` is one of `offered`, where an offered type may be a `type/*` wildcard. */
export function mimeOffered(offered: readonly string[], mime: string): boolean {
	const [fileType, fileSubtype] = mime.split('/');
	return offered.some((m) => {
		const [type, subtype] = m.split('/');
		return (type === '*' || type === fileType) && (subtype === '*' || subtype === fileSubtype);
	});
}

/**
 * The file picker's `accept` list: what the composer offers, plus the photo types it redraws as JPEG
 * wherever a JPEG is offered (CUR-3073). The extensions are there because some systems give a HEIC
 * no type, and the dialog would then grey it out.
 */
export function pickerAccept(offered: readonly string[]): string[] {
	if (!mimeOffered(offered, 'image/jpeg')) return [...offered];
	return [...offered, ...CONVERTIBLE_IMAGE_MIME, '.heic', '.heif'];
}

let photosOnSignInAnswer: Promise<boolean> | undefined;

/**
 * Would signing in let this guest attach photos? Asked of the server only the first time a
 * guest's photo is refused on this page, then remembered, so PostHog is asked about the guests who try
 * rather than on every page load. Any failure answers no, which shows the plain "can't be attached". (CUR-3015)
 */
export function photosOnSignIn(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
	photosOnSignInAnswer ??= fetchFn(url)
		.then((res) => (res.ok ? res.json() : { photos: false }))
		.then((body: { photos?: unknown }) => body.photos === true)
		.catch(() => false);
	return photosOnSignInAnswer;
}

/** Said after a photo is refused for its type, so the visitor knows what to convert it to. */
export const PHOTO_TYPES_THAT_ATTACH = 'Photos attach as JPEG, PNG, WebP or GIF.';

const ATTACHABLE_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Whether a refused file earns PHOTO_TYPES_THAT_ATTACH: only where this composer takes photos, and only
 * for a photo in some other format. A PNG refused on a model without images gets no hint to convert to
 * a type that would be refused too.
 */
export function photoTypesHint(file: { type: string; name: string }, imagesOffered: boolean): boolean {
	if (!imagesOffered || ATTACHABLE_PHOTO_TYPES.includes(file.type)) return false;
	return file.type.startsWith('image/') || convertibleType(file) !== undefined;
}

/**
 * What to say when a paste brought files the composer refused, so a pasted photo never
 * vanishes without a word. Undefined when nothing was refused. A photo's line follows the `multimodal`
 * flag: "sign in" only for a guest whom signing in would actually give images (`imageInputOnSignIn`),
 * since preview offers them to team accounts only. (CUR-2949)
 */
export function refusedPasteMessage(
	refused: readonly { type: string; name: string }[],
	opts: {
		imageInputEnabled: boolean;
		imageInputOnSignIn: boolean;
		signedIn: boolean;
		loginEnabled: boolean;
		/** Some image type is offered, so a refused image is refused for its type (a TIFF, CUR-3051). */
		imagesOffered?: boolean;
		/** The model the message goes to, named in a photo refusal so it says which one can't read it. */
		modelName?: string;
		/**
		 * Picking another model here would take the photo: one reads photos and files attach. Without it
		 * the model is never blamed, since there is nothing to pick. Never under Auto, which takes a photo
		 * to a model that reads it on its own.
		 */
		photoModelPickable?: boolean;
	}
): string | undefined {
	// A photo and another file can be refused in one paste; both get named, so neither vanishes.
	const isPhotoRefusal = (file: { type: string }) => file.type.startsWith('image/') && !opts.imagesOffered;
	const photo = refused.find(isPhotoRefusal);
	const other = refused.find((file) => !isPhotoRefusal(file));
	const parts: string[] = [];
	if (photo) {
		if (opts.imageInputEnabled && opts.photoModelPickable)
			parts.push(`${opts.modelName || 'The selected model'} can't read photos. Pick one that can to attach this.`);
		else if (!opts.signedIn && opts.loginEnabled && opts.imageInputOnSignIn) parts.push('Sign in to attach photos.');
		else parts.push("Photos can't be attached here yet.");
	}
	if (other) parts.push(`This file type can't be attached here: ${fileTypeLabel(other.type, other.name)}.`);
	// A photo this browser couldn't redraw (a HEIC outside Safari, CUR-3073) gets the types that work.
	if (other && photoTypesHint(other, opts.imagesOffered ?? false)) parts.push(PHOTO_TYPES_THAT_ATTACH);
	return parts.length > 0 ? parts.join(' ') : undefined;
}
