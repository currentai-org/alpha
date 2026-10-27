<script lang="ts">
	import Button from './button.svelte';
</script>

<!-- Two direct children under justify-between, the layout the wipe's wrapper must keep. -->
<Button href="/go" class="w-80 justify-between">
	<span data-end="left">Left</span>
	<span data-end="right">Right</span>
</Button>
