/** Up to two initials of an account's display name, or "G" when there is none. Shared by the sidebar's account row and the phone header's avatar. */
export function accountInitials(displayName: string): string {
	return (
		displayName
			.split(/\s+/)
			.map((w) => w[0])
			.join('')
			.slice(0, 2) || 'G'
	);
}
