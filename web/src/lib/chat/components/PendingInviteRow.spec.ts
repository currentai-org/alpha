// Any account can put a workspace name it chose in front of any address, so the invite row
// must show that name as plain text of bounded length: never as markup, never as a link. (CUR-4167)
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import PendingInviteRow, { INVITE_NAME_MAX } from './PendingInviteRow.svelte';

function rowText(body: string): string {
	return body
		.replace(/<!--[^>]*-->/g, '')
		.replace(/<[^>]+>/g, '\n')
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean)[0];
}

describe('PendingInviteRow', () => {
	it('renders a name holding markup, a link and over 60 characters as plain text cut to 60', () => {
		const name = `<a href="https://evil.example">Win</a> <img src=x onerror=alert(1)> ${'x'.repeat(80)}`;
		const { body } = render(PendingInviteRow, {
			props: { workspaceName: name, inviterEmail: '<b>boss</b>@example.org' },
		});
		expect(body).not.toMatch(/<a\b|<img\b|<b>/);
		expect(body).toContain('&lt;a href=');
		const shown = rowText(body).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
		expect([...shown].length).toBe(INVITE_NAME_MAX);
		expect(shown.endsWith('…')).toBe(true);
	});

	it('shows a short name whole, on one line', () => {
		const { body } = render(PendingInviteRow, {
			props: { workspaceName: 'Field\nteam', inviterEmail: 'ada@example.org' },
		});
		expect(rowText(body)).toBe('Field team');
		expect(body).toContain('Invited by ada@example.org');
	});
});
