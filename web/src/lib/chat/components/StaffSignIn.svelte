<script lang="ts">
	// What an /chat/admin panel shows a visitor its role does not let in (CUR-3992). The panels have no
	// login of their own: a person signs in with their own account, and its staff role decides.
	import { page } from '$app/state';
	import { base } from '$lib/chat/paths';

	let { signedIn }: { signedIn: boolean } = $props();

	const loginHref = $derived(`${base}/login?next=${encodeURIComponent(page.url.pathname)}`);
</script>

<div class="mx-auto max-w-sm space-y-3 border border-line-2 bg-surface-2 p-6 text-body" data-staff-sign-in>
	{#if signedIn}
		<p class="text-fg-2">
			Your account has no staff role on this deployment. An admin can give you one.
		</p>
	{:else}
		<p class="text-fg-2">Sign in with an account that has a staff role to reach the admin panels.</p>
		<a
			href={loginHref}
			class="block w-full border border-line-3 bg-surface-3 px-3 py-2 text-center font-medium"
		>
			Sign in
		</a>
	{/if}
</div>
