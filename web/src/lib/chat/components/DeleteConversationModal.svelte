<script lang="ts">
	import Modal from "$lib/chat/components/Modal.svelte";
	import { onMount } from "svelte";

	interface Props {
		open?: boolean;
		title?: string;
		onclose?: () => void;
		ondelete?: () => void;
	}

	let { open = false, title = "", onclose, ondelete }: Props = $props();

	let deleteButtonEl: HTMLButtonElement | undefined = $state();

	function close() {
		open = false;
		onclose?.();
	}

	function confirmDelete() {
		ondelete?.();
		close();
	}

	onMount(() => {
		setTimeout(() => {
			deleteButtonEl?.focus();
		}, 100);
	});
</script>

{#if open}
	<Modal onclose={close} width="w-[90dvh] md:w-[480px]">
		<div class="flex w-full flex-col gap-5 p-6">
			<div class="flex items-start justify-between">
				<h2 class="text-xl font-semibold text-fg-1">Delete conversation</h2>
				<button type="button" class="group outline-hidden" onclick={close} aria-label="Close">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 32 32"
						class="size-5 text-fg-2 group-hover:text-fg-1"
						><path
							d="M24 9.41 22.59 8 16 14.59 9.41 8 8 9.41 14.59 16 8 22.59 9.41 24 16 17.41 22.59 24 24 22.59 17.41 16 24 9.41z"
							fill="currentColor"
						/></svg
					>
				</button>
			</div>

			<p class="text-sm text-fg-2">
				Are you sure you want to delete "<span class="font-semibold">{title}</span>"? This action
				cannot be undone.
			</p>

			<div class="flex items-center justify-end gap-2">
				<button
					type="button"
					class="inline-flex items-center rounded-xl border border-line-2 bg-surface-3 px-3 py-1.5 text-sm font-medium text-fg-1 shadow-sm outline-hidden hover:bg-tint-hover"
					onclick={close}
				>
					Cancel
				</button>
				<button
					bind:this={deleteButtonEl}
					type="button"
					class="inline-flex items-center rounded-xl border border-red-600 bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 focus:ring-2 focus:ring-red-400 focus:ring-offset-2 focus:outline-hidden dark:border-red-500 dark:bg-red-500 dark:hover:bg-red-600 dark:focus:ring-red-400 dark:focus:ring-offset-gray-800"
					onclick={confirmDelete}
				>
					Delete
				</button>
			</div>
		</div>
	</Modal>
{/if}
