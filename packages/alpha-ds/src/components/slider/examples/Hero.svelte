<script lang="ts">
	import { Slider } from '@aipotluck/alpha-ds';
	let value = $state(40);
</script>

<div class="flex max-w-sm items-center gap-4">
	<Slider.Root bind:value aria-label="Temperature">
		<Slider.Control>
			<Slider.Track>
				<Slider.Indicator />
				<Slider.Thumb />
			</Slider.Track>
		</Slider.Control>
	</Slider.Root>
	<span class="w-8 type-code text-fg-2 tabular-nums">{value}</span>
</div>
