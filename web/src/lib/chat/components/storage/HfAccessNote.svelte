<script lang="ts">
	// Forgetting a linked bucket on our side (Unlink, Forget everything, Delete account) leaves
	// the person's files where they are, and leaves Alpha's access listed on Hugging Face. Hugging Face
	// publishes no token revocation endpoint, so this sentence is how the person removes it.
	import { m } from '$lib/paraglide/messages.js';
	interface Props {
		grants: ('alpha' | 'token' | 'oauth')[];
	}
	let { grants }: Props = $props();
</script>

{#if grants.includes('oauth')}
	<span data-testid="hf-access-note-oauth">
		{#each m.storage_hfNoteOauth({ link: '{link}' }).split(/(\{link\})/).filter(Boolean) as part, i (i)}{#if part === '{link}'}<a
					class="underline"
					href="https://huggingface.co/settings/connected-applications"
					target="_blank"
					rel="noopener noreferrer">{m.storage_hfNoteConnectedApps()}</a
				>{:else}{part}{/if}{/each}
	</span>
{/if}
{#if grants.includes('token')}
	<span data-testid="hf-access-note-token">
		{#each m.storage_hfNoteToken({ link: '{link}' }).split(/(\{link\})/).filter(Boolean) as part, i (i)}{#if part === '{link}'}<a
					class="underline"
					href="https://huggingface.co/settings/tokens"
					target="_blank"
					rel="noopener noreferrer">{m.storage_hfNoteTokensLink()}</a
				>{:else}{part}{/if}{/each}
	</span>
{/if}
