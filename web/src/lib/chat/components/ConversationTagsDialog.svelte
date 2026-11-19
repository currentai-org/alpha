<script lang="ts">
	import { Button, Dialog, Field, Inline, Toggle } from '@aipotluck/alpha-ds';
	import { m } from '$lib/paraglide/messages.js';
	import { cleanTagName, tagIdFor, TAG_NAME_MAX, TAGS_PER_CHAT_MAX, type ChatTag } from '$lib/chat/utils/chatTags';

	/**
	 * Tag a chat from the side rail's Conversation actions menu. The person's tags show as
	 * pills to switch on or off; a new one is typed in the box and added with Enter. Save sends the
	 * chat's whole list. Tags are the person's own words; nothing here suggests or writes one for them.
	 */
	interface Props {
		open?: boolean;
		title: string;
		/** The chat's tag ids now. */
		current: string[];
		/** Every tag the person has, to offer. */
		known: ChatTag[];
		onsave: (names: string[]) => void;
	}

	let { open = $bindable(false), title, current, known, onsave }: Props = $props();

	// The chat's tags while the dialog is open, in the order they were added.
	let chosen = $state<ChatTag[]>([]);
	let draft = $state('');
	$effect(() => {
		if (!open) return;
		const names = new Map(known.map((t) => [t.id, t.name]));
		chosen = current.map((id) => ({ id, name: names.get(id) ?? id }));
		draft = '';
	});

	// Known tags first, then any new one typed this time, each once.
	let offered = $derived([...known, ...chosen.filter((t) => !known.some((k) => k.id === t.id))]);
	let full = $derived(chosen.length >= TAGS_PER_CHAT_MAX);

	function toggle(tag: ChatTag, on: boolean) {
		if (on && !chosen.some((t) => t.id === tag.id) && !full) chosen = [...chosen, tag];
		if (!on) chosen = chosen.filter((t) => t.id !== tag.id);
	}

	function add(e: SubmitEvent) {
		e.preventDefault();
		const name = cleanTagName(draft);
		if (!name) return;
		// A name that matches a tag the person has is that tag, under its own spelling.
		const id = tagIdFor(name);
		toggle(offered.find((t) => t.id === id) ?? { id, name }, true);
		draft = '';
	}

	function save() {
		// A tag typed but not yet added with Enter is still meant.
		const name = cleanTagName(draft);
		if (name) toggle(offered.find((t) => t.id === tagIdFor(name)) ?? { id: tagIdFor(name), name }, true);
		onsave(chosen.map((t) => t.name));
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="sm" data-testid="conversation-tags-dialog">
			<Dialog.Title>{m.product_tagsTitle()}</Dialog.Title>
			<Dialog.Description>{m.product_tagsIntro({ title })}</Dialog.Description>
			<div class="flex flex-col gap-4">
				{#if offered.length}
					<Inline gap="1" role="group" aria-label={m.product_tags()}>
						{#each offered as tag (tag.id)}
							<Toggle
								pressed={chosen.some((t) => t.id === tag.id)}
								onPressedChange={(on) => toggle(tag, on)}
								disabled={full && !chosen.some((t) => t.id === tag.id)}
								data-tag-option={tag.id}
							>
								{tag.name}
							</Toggle>
						{/each}
					</Inline>
				{/if}
				<form onsubmit={add} class="flex flex-col gap-2">
					<Field.Root>
						<Field.Label>{m.product_newTag()}</Field.Label>
						<Field.Control bind:value={draft} maxlength={TAG_NAME_MAX} placeholder={m.product_newTagPlaceholder()} disabled={full} />
					</Field.Root>
				</form>
				<Inline justify="end" gap="2">
					<Dialog.Close>{m.product_tagsCancel()}</Dialog.Close>
					<Button variant="primary" onclick={save} data-tags-save>{m.product_tagsSave()}</Button>
				</Inline>
			</div>
			<Dialog.Close />
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
