<script lang="ts">
	import { Progress, Stack } from '@aipotluck/alpha-ds';
</script>

<Stack gap="6" class="max-w-sm">
	<Progress.Root value={64}>
		<Progress.Label>Uploading report.pdf</Progress.Label>
		<Progress.Value />
		<Progress.Track><Progress.Indicator /></Progress.Track>
	</Progress.Root>
	<Progress.Root value={null}>
		<Progress.Label>Indexing sources</Progress.Label>
		<Progress.Track><Progress.Indicator /></Progress.Track>
	</Progress.Root>
</Stack>
