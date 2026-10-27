<script lang="ts">
	// Forgetting a linked bucket on our side (Unlink, Forget everything, Delete account) leaves
	// the person's files where they are, and leaves Alpha's access listed on Hugging Face. Hugging Face
	// publishes no token revocation endpoint, so this sentence is how the person removes it. (CUR-2932)
	interface Props {
		grants: ('alpha' | 'token' | 'oauth')[];
	}
	let { grants }: Props = $props();
</script>

{#if grants.includes('oauth')}
	<span data-testid="hf-access-note-oauth">
		To remove Alpha’s approval on Hugging Face too, open
		<a
			class="underline"
			href="https://huggingface.co/settings/connected-applications"
			target="_blank"
			rel="noopener noreferrer">Connected apps</a
		> in your Hugging Face settings.
	</span>
{/if}
{#if grants.includes('token')}
	<span data-testid="hf-access-note-token">
		You can also delete the token you made for Alpha in your
		<a class="underline" href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener noreferrer"
			>Hugging Face access tokens</a
		>.
	</span>
{/if}
