<script lang="ts">
	// Placeholder for the main chat pane while layout data streams in.
</script>

<div class="flex h-full min-h-0 flex-col px-4 py-6 md:px-8" aria-busy="true" aria-label="Loading chat">
	<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6">
		<div class="space-y-3">
			<div class="h-6 w-48 animate-pulse rounded-sharp bg-[var(--ap-rule)]/50"></div>
			<div class="h-4 w-full max-w-md animate-pulse rounded-sharp bg-[var(--ap-rule)]/40"></div>
			<div class="h-4 w-5/6 max-w-sm animate-pulse rounded-sharp bg-[var(--ap-rule)]/30"></div>
		</div>
		<div class="mt-auto space-y-3">
			<div class="h-24 w-full animate-pulse rounded-sharp border border-[var(--ap-rule)] bg-[var(--ap-paper-3)]/40"></div>
			<div class="h-11 w-full animate-pulse rounded-full bg-[var(--ap-rule)]/50"></div>
		</div>
	</div>
</div>
