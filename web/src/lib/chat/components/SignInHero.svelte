<script lang="ts">
	import PotluckMark from './PotluckMark.svelte';
	import RiShieldCheckLine from '~icons/ri/shield-check-line';
	import RiRobot2Line from '~icons/ri/robot-2-line';
	import RiOpenSourceLine from '~icons/ri/open-source-line';

	/**
	 * The brand band at the top of the sign-in surfaces: a warm accent glow, a faint lattice, the
	 * Potluck mark, and three floating promise chips. Decorative — the heading below carries meaning.
	 */
	let { compact = false }: { compact?: boolean } = $props();
</script>

<div
	class="signin-hero mask-fade-bottom relative isolate flex items-center justify-center overflow-hidden {compact ? 'h-32' : 'h-40'}"
	aria-hidden="true"
	data-signin-hero
>
	<div class="relative grid size-16 place-items-center border border-line-2 bg-surface-raised shadow-popover rounded-card">
		<PotluckMark class="size-8" />
	</div>
	<span class="signin-chip chip-a"><RiShieldCheckLine /> Private by default</span>
	<span class="signin-chip chip-b"><RiOpenSourceLine /> Open models</span>
	<span class="signin-chip chip-c max-sm:hidden"><RiRobot2Line /> Honest AI</span>
</div>

<style>
	.signin-hero {
		background:
			radial-gradient(ellipse 70% 90% at 50% 110%, color-mix(in oklch, var(--ds-accent-1) 38%, transparent), transparent 70%),
			linear-gradient(var(--ds-line-1) 1px, transparent 1px) 0 0 / 20px 20px,
			linear-gradient(90deg, var(--ds-line-1) 1px, transparent 1px) 0 0 / 20px 20px,
			var(--ds-bg-2);
	}

	.signin-chip {
		position: absolute;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.25rem 0.6rem;
		border: 1px solid var(--ds-line-2);
		border-radius: 9999px;
		background: var(--ds-bg-3);
		color: var(--ds-fg-2);
		font-size: var(--ds-text-small);
		box-shadow: var(--ds-shadow-popover);
		animation: signin-float 6s ease-in-out infinite;
	}
	.signin-chip :global(svg) {
		width: 0.85rem;
		height: 0.85rem;
		color: var(--ds-accent-1);
	}
	.chip-a {
		left: 5%;
		top: 18%;
	}
	.chip-b {
		right: 5%;
		top: 40%;
		animation-delay: -2s;
	}
	.chip-c {
		left: 4%;
		bottom: 16%;
		animation-delay: -4s;
	}
	@keyframes signin-float {
		0%,
		100% {
			translate: 0 0;
		}
		50% {
			translate: 0 -4px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.signin-chip {
			animation: none;
		}
	}
</style>
