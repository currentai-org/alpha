<script lang="ts">
	let { children } = $props();
</script>

<!-- Shared admin shell. Admin panels render INSIDE the chat layout's bounded window card
     (h-[calc(100dvh-...)] overflow-hidden), so this needs its OWN scroll container or long content
     clips below the card edge. It must fill that card slot (h-full), NOT the viewport (h-dvh) — the
     card is shorter than the viewport (titlebar + nav-bar offset above it), so h-dvh would push the
     bottom of the scroll range past the clipped card edge and make it unreachable. Owning the scroll
     here (once) keeps every panel on the same paper/ink theme and scroll behavior — individual pages
     just provide their `mx-auto max-w-* px-4 py-8` content wrapper. -->
<div class="h-full min-h-0 overflow-y-auto bg-[var(--ap-paper)] text-[var(--ap-ink)]">
	{@render children()}
</div>
