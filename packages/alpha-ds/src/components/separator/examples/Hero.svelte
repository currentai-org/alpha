<script lang="ts">
	import { Separator, Stack } from '@aipotluck/alpha-ds';
</script>

<Stack gap="4" class="max-w-md type-caption text-fg-3">
	<span>subtle</span><Separator weight="subtle" />
	<span>default</span><Separator />
	<span>strong</span><Separator weight="strong" />
	<div class="flex h-6 items-center gap-3">Left <Separator orientation="vertical" /> Right</div>
</Stack>
