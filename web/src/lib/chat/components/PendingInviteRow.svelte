<script lang="ts" module>
	/** Longest workspace name shown in an invite row. Another account chose it, so it's capped (CUR-4167). */
	export const INVITE_NAME_MAX = 60;

	/** The name as one line of at most INVITE_NAME_MAX characters, cut with an ellipsis. */
	export function inviteName(name: string): string {
		const chars = [...name.replace(/\s+/g, ' ').trim()];
		return chars.length > INVITE_NAME_MAX ? `${chars.slice(0, INVITE_NAME_MAX - 1).join('')}…` : chars.join('');
	}
</script>

<script lang="ts">
	// One pending invitation, as the account menu and Settings → Workspace show it. Both
	// strings come from other people's input, so they are text interpolation only, never markup. (CUR-4167)
	import { m } from '$lib/paraglide/messages.js';

	let { workspaceName, inviterEmail }: { workspaceName: string; inviterEmail: string } = $props();
</script>

<span class="flex min-w-0 flex-col" data-pending-invite>
	<span class="truncate type-body text-fg-1">{inviteName(workspaceName)}</span>
	<span class="truncate type-caption text-fg-3">{m.workspace_invitedBy({ email: inviterEmail })}</span>
</span>
