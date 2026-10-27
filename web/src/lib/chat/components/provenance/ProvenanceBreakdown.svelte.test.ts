import ProvenanceBreakdown from './ProvenanceBreakdown.svelte';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import { catalog, orgs } from '$lib/chat/routing/catalog';

// For a model its maker also runs (Mistral Large 3 on Mistral AI), the host row repeated the
// maker's blurb word for word under "Where it runs". (CUR-3317)
describe('the provenance breakdown', () => {
	it('does not repeat the maker’s blurb on the host row when the maker runs its own model', async () => {
		const model = catalog.find((m) => m.provider && m.provider === m.maker)!;
		expect(model, 'no self-hosted model in the catalog').toBeDefined();
		const { container } = await render(ProvenanceBreakdown, { model });
		const blurb = orgs[model.maker].blurb;
		expect(container.textContent?.split(blurb).length).toBe(2);
	});

	it('keeps the host’s own blurb when another organisation runs the model', async () => {
		const model = catalog.find((m) => m.provider && m.provider !== m.maker)!;
		const { container } = await render(ProvenanceBreakdown, { model });
		expect(container.textContent).toContain(orgs[model.provider!].blurb);
	});

	// An answer's "Where it ran" comes from its routing record. The catalogue's host is a
	// forecast, and a direct lane or a fallback can serve the turn somewhere else. (CUR-3562)
	it('says where an answer ran was not recorded, rather than naming the catalogue’s host', async () => {
		const model = catalog.find((m) => m.provider && m.provider !== m.maker)!;
		const { container } = await render(ProvenanceBreakdown, { model, mode: 'answer' });
		const row = container.querySelector('[data-ran-on]');
		expect(row?.getAttribute('data-ran-on')).toBe('not-recorded');
		expect(row?.textContent).toContain('Not recorded for this answer.');
		expect(row?.textContent).not.toContain(orgs[model.provider!].name);
	});

	it('names the host an answer’s routing record reports', async () => {
		const model = catalog.find((m) => m.provider && m.provider !== m.maker)!;
		const { container } = await render(ProvenanceBreakdown, {
			model,
			mode: 'answer',
			ran: { label: 'Together' }
		});
		expect(container.querySelector('[data-ran-on]')?.textContent).toContain('Ran on Together.');
	});
});
