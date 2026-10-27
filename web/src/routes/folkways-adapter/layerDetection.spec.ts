import { describe, expect, it } from 'vitest';
import { detectLayers } from './layerDetection';

describe('folkways-adapter layerDetection', () => {
	it('flags nothing on a plain system message with no override', () => {
		const layers = detectLayers('You are Apertus, an open-weights model.', false);
		expect(layers).toEqual({
			persona_override: false,
			artifacts: false,
			search: false,
			rag: false
		});
	});

	it('persona_override follows the caller-supplied tuning fact, not the text', () => {
		// Same system text either way — persona_override is NOT text-detected (see the file's
		// header note): it must reflect exactly what the caller passed in.
		const text = 'You are Apertus, an open-weights model.';
		expect(detectLayers(text, true).persona_override).toBe(true);
		expect(detectLayers(text, false).persona_override).toBe(false);
	});

	it('detects the artifacts marker', () => {
		const text = 'Persona text.\n\n## Artifacts\n\nYou can create artifacts...';
		expect(detectLayers(text, false).artifacts).toBe(true);
	});

	it('detects the search-grounding fence', () => {
		const text =
			'Persona text.\n\n<retrieved_web_sources>\n[1] some source\n</retrieved_web_sources>\n\nAnswer using ONLY the sources.';
		expect(detectLayers(text, false).search).toBe(true);
	});

	it('detects RAG via either the catalog-sources fence or the federated-synthesis fence', () => {
		const catalog = 'Persona.\n\n<retrieved_sources>\n[1] a catalog source\n</retrieved_sources>';
		const vault = 'Persona.\n\n<federated_synthesis>\nsynthesized answer\n</federated_synthesis>';
		expect(detectLayers(catalog, false).rag).toBe(true);
		expect(detectLayers(vault, false).rag).toBe(true);
	});

	it('search and rag markers are independent — one does not flag the other', () => {
		const searchOnly = '<retrieved_web_sources>x</retrieved_web_sources>';
		const ragOnly = '<retrieved_sources>x</retrieved_sources>';
		expect(detectLayers(searchOnly, false)).toMatchObject({ search: true, rag: false });
		expect(detectLayers(ragOnly, false)).toMatchObject({ search: false, rag: true });
	});

	it('never sets conversation_preprompt — no marker exists to detect it (documented limitation)', () => {
		const layers = detectLayers(
			'anything at all, even a long conversation preprompt appended',
			false
		);
		expect(layers.conversation_preprompt).toBeUndefined();
	});

	it('handles an empty system message (no system role this turn)', () => {
		expect(detectLayers('', false)).toEqual({
			persona_override: false,
			artifacts: false,
			search: false,
			rag: false
		});
	});
});
