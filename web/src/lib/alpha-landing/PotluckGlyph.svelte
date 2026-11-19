<script lang="ts">
	/**
	 * The AI Potluck mark, drawn from the site's own `/favicon.svg` as a mask so it takes the text
	 * colour (`text-…`) like an icon. Decorative.
	 */
	let { class: className = '' }: { class?: string } = $props();
</script>

<span aria-hidden="true" class="potluck-glyph inline-block shrink-0 bg-current {className}"></span>

<style>
	.potluck-glyph {
		-webkit-mask: url('/favicon.svg') center / contain no-repeat;
		mask: url('/favicon.svg') center / contain no-repeat;
	}
</style>
