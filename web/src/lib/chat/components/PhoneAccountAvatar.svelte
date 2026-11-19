<script lang="ts">
	import { page } from '$app/state';
	import { Avatar, getAppShell } from '@aipotluck/alpha-ds';
	import { m } from '$lib/paraglide/messages.js';
	import { accountInitials } from '$lib/chat/accountInitials';

	/**
	 * Phone header: the signed-in visitor's initials, so who they are signed in as shows without
	 * opening the drawer, where the sidebar's account row lives. Tapping opens that drawer. Hidden
	 * from md up, where the sidebar row is on screen, and absent for a guest.
	 */
	const shell = getAppShell();
	const user = $derived(page.data.user as { name?: string } | undefined);
	const displayName = $derived(user?.name ?? m.product_guest());
</script>

{#if user}
	<button
		type="button"
		class="md:hidden"
		data-testid="phone-account-avatar"
		aria-label={m.product_accountSignedIn({ name: displayName })}
		onclick={() => shell.setMobileOpen(true)}
	>
		<Avatar.Root size="sm">
			<Avatar.Fallback>{accountInitials(displayName)}</Avatar.Fallback>
		</Avatar.Root>
	</button>
{/if}
