<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { base } from '$lib/chat/paths';
	import { Button } from '@aipotluck/alpha-ds';
	import SignInHero from '$lib/chat/components/SignInHero.svelte';
	import RiArrowRightLine from '~icons/ri/arrow-right-line';

	/**
	 * Shown when someone sends a message in the demo — the one action that would call a model. Same
	 * brand band as the real sign-in, their draft echoed back as a chat bubble, and one clear next
	 * step. A centred card on larger screens, a bottom sheet on phones.
	 */
	let {
		open = $bindable(false),
		draftPreview = ''
	}: {
		open?: boolean;
		/** The message they tried to send; empty when they chose Sign up from the account menu. */
		draftPreview?: string;
	} = $props();
	const sending = $derived(!!draftPreview.trim());

	const loginHref = `${base}/login?next=${encodeURIComponent(`${base}/`)}`;
</script>

{#if open}
	<div
		class="absolute inset-0 z-overlay flex items-center justify-center bg-overlay p-4 max-sm:items-end max-sm:p-0"
		role="presentation"
		transition:fade={{ duration: 150 }}
		onclick={(e) => {
			if (e.target === e.currentTarget) open = false;
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') open = false;
		}}
	>
		<div
			class="signup-card relative flex w-full max-w-md flex-col overflow-hidden rounded-field border border-line-2 bg-surface-raised text-fg-1 shadow-window max-sm:border-x-0 max-sm:border-b-0"
			role="dialog"
			aria-modal="true"
			aria-labelledby="alpha-demo-signup-title"
			tabindex="-1"
			transition:fly={{ y: 24, duration: 220 }}
			data-demo-signup
		>
			<SignInHero compact />
			<div class="flex flex-col gap-4 px-6 pt-2 pb-6">
				<header class="flex flex-col gap-1.5 text-center">
					<h2 id="alpha-demo-signup-title" class="type-heading text-fg-1">
						{sending ? 'Sign in to send it' : 'Sign up for Alpha'}
					</h2>
					<p class="type-caption text-fg-2">
						{sending
							? 'This demo runs on sample conversations. Sign in — it’s free during the open alpha — and Alpha will answer for real.'
							: 'Keep your conversations, settings and theme, and get real answers from open models. It’s free during the open alpha.'}
					</p>
				</header>
				{#if draftPreview.trim()}
					<div class="flex flex-col items-end gap-1">
						<span class="type-caption text-fg-3">Your message</span>
						<p class="max-w-4/5 rounded-sharp bg-surface-3 px-3 py-2 type-body text-fg-1">
							{draftPreview.trim()}
						</p>
					</div>
				{/if}
				<div class="flex flex-col gap-2">
					<!-- eslint-disable svelte/no-navigation-without-resolve -- chat login is under the chat base path -->
					<Button
						href={loginHref}
						variant="primary"
						size="lg"
						casing="sentence"
						block
						data-demo-signin
					>
						{sending ? 'Sign in to continue' : 'Sign up'}
						<RiArrowRightLine aria-hidden="true" />
					</Button>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
					<Button variant="ghost" size="md" casing="sentence" block onclick={() => (open = false)}>
						Keep exploring the demo
					</Button>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Phones: a bottom sheet — rounded on top only. */
	@media (max-width: 639px) {
		.signup-card {
			border-bottom-left-radius: 0;
			border-bottom-right-radius: 0;
		}
	}
</style>
