<!--
SPDX-FileCopyrightText: 2018- The Hugging Face team
SPDX-License-Identifier: Apache-2.0
Modified by Current AI from huggingface/chat-ui.
-->
<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { base } from '$lib/chat/paths';
	import { page } from '$app/state';
	import { Menu, Sidebar } from '@aipotluck/alpha-ds';

	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
	import RiMore from '~icons/ri/more-line';
	import RiPencilLine from '~icons/ri/pencil-line';
	import RiShareLine from '~icons/ri/share-line';
	import RiPushpinLine from '~icons/ri/pushpin-line';
	import RiUnpinLine from '~icons/ri/unpin-line';
	import RiArchiveLine from '~icons/ri/archive-line';
	import RiSpyLine from '~icons/ri/spy-line';
	import RiPriceTag3Line from '~icons/ri/price-tag-3-line';
	import type { ConvSidebar } from '$lib/chat/types/ConvSidebar';
	import type { ChatTag } from '$lib/chat/utils/chatTags';

	import DeleteConversationModal from '$lib/chat/components/DeleteConversationModal.svelte';
	import RenameConversationDialog from '$lib/chat/components/RenameConversationDialog.svelte';
	import ShareConversationDialog from '$lib/chat/components/ShareConversationDialog.svelte';
	import ConversationTagsDialog from '$lib/chat/components/ConversationTagsDialog.svelte';
	import { requireAuthUser } from '$lib/chat/utils/auth';
	import { isActiveConversationId } from '$lib/chat/utils/conversationId';
	import { isLocalModelId } from '$lib/chat/identity';
	import { shownTitle } from '$lib/chat/crypto/shownTitle.svelte';

	interface Props {
		conv: ConvSidebar;
		readOnly?: true;
		ondeleteConversation?: (id: string) => void;
		onrenameConversation?: (id: string, title: string) => void;
		onpinConversation?: (id: string, pinned: boolean) => void;
		onarchiveConversation?: (id: string) => void;
		/** Set the chat's whole tag list, by name. */
		ontagConversation?: (id: string, names: string[]) => void;
		/** The person's tags, offered in the Tags dialog. */
		knownTags?: ChatTag[];
	}

	let {
		conv,
		readOnly,
		ondeleteConversation,
		onrenameConversation,
		onpinConversation,
		onarchiveConversation,
		ontagConversation,
		knownTags = []
	}: Props = $props();

	// No extra query: layoutData already projects each conversation's own model onto the sidebar row
	// (ConvSidebar.model), and a local model's id carries its own prefix. `model` falls back to the
	// deployment default when a conversation has none, which is never a local id.
	const isLocal = $derived(isLocalModelId(typeof conv.model === 'string' ? conv.model : undefined));

	let deleteOpen = $state(false);
	let renameOpen = $state(false);
	let shareOpen = $state(false);
	let tagsOpen = $state(false);
	// Layout data's `chatTagsEnabled`: signed in, since a tag is kept on the account.
	const tagsOffered = $derived(page.data.chatTagsEnabled === true && !!ontagConversation);
	// Layout data's `shareLinksEnabled`: signed in, with the share-links flag on.
	const shareOffered = $derived(page.data.shareLinksEnabled === true);
	let isMenuOpen = $state(false);

	// See conversationId.ts: conv.id is an ObjectId INSTANCE (not a string) for conversations loaded
	// via the sidebar's infinite-scroll pagination, so a bare `conv.id === page.params.id` would silently
	// never highlight those rows, even while their own page is open.
	let isActive = $derived(isActiveConversationId(conv.id, page.params.id));

	// A sealed title opens in the browser with the unlocked history key; shownTitle is the one
	// place every surface reads the title from.
	const title = $derived(shownTitle(conv));
</script>

{#snippet rowMenu()}
	<Menu.Root
		bind:open={isMenuOpen}
		onOpenChange={(open) => {
			if (open && requireAuthUser()) {
				isMenuOpen = false;
				return;
			}
			isMenuOpen = open;
		}}
	>
		<Menu.Trigger size="icon-xs" aria-label={m.product_conversationActions()} title={m.product_moreOptions()}>
			<RiMore aria-hidden="true" />
		</Menu.Trigger>
		<Menu.Portal>
			<Menu.Positioner side="bottom" align="end" sideOffset={4}>
				<Menu.Popup onCloseAutoFocus={(e) => e.preventDefault()}>
					<Menu.Item onSelect={() => onpinConversation?.(conv.id.toString(), !conv.pinned)} data-conv-action="pin">
							{#if conv.pinned}
								<RiUnpinLine aria-hidden="true" /> {m.product_unpin()}
							{:else}
								<RiPushpinLine aria-hidden="true" /> {m.product_pin()}
							{/if}
						</Menu.Item>
						<Menu.Item onSelect={() => (renameOpen = true)}>
						<RiPencilLine aria-hidden="true" /> Rename
					</Menu.Item>
					{#if tagsOffered}
						<Menu.Item onSelect={() => (tagsOpen = true)} data-conv-action="tags">
							<RiPriceTag3Line aria-hidden="true" /> {m.product_tags()}
						</Menu.Item>
					{/if}
					{#if shareOffered}
						<Menu.Item onSelect={() => (shareOpen = true)}>
							<RiShareLine aria-hidden="true" /> Share chat
						</Menu.Item>
					{/if}
					<Menu.Item onSelect={() => onarchiveConversation?.(conv.id.toString())} data-conv-action="archive">
							<RiArchiveLine aria-hidden="true" /> {m.product_archive()}
						</Menu.Item>
						<Menu.Item tone="destructive" onSelect={() => (deleteOpen = true)}>
						<RiDeleteBinFill aria-hidden="true" /> {m.product_delete()}
					</Menu.Item>
				</Menu.Popup>
			</Menu.Positioner>
		</Menu.Portal>
	</Menu.Root>
{/snippet}

<!-- Borrows the look of the Ctrl-K chip beside "Search chats", but is a span rather than the DS's
     `Kbd`: that renders a <kbd>, which tells a screen reader this is a key you can press.

     The mark is the same incognito glyph the composer's Local pill uses, so the two readings of one
     fact look like one feature. Dropping the word costs the chip its self-evidence, so the name
     moves onto the element itself: `role="img"` plus `aria-label`, since an aria-hidden icon in a
     bare span would leave a screen reader nothing at all to announce. -->
{#snippet localTag()}
	<span
		class="inline-flex size-5 items-center justify-center rounded-sharp border border-line-surface bg-surface-raised text-fg-2 [&_svg]:size-3.5"
		title="Answered on your own computer"
		role="img"
		aria-label="Answered on your own computer"
	>
		<RiSpyLine aria-hidden="true" />
	</span>
{/snippet}

<Sidebar.Item
	current={isActive}
	label={title}
	href="{base}/conversation/{conv.id}"
	data-sveltekit-noscroll
	data-sveltekit-preload-data="tap"
	data-title-source={conv.titleSource ?? undefined}
	marker={isLocal ? localTag : undefined}
	trailing={readOnly ? undefined : rowMenu}
>
	{title}
</Sidebar.Item>

<RenameConversationDialog
	bind:open={renameOpen}
	{title}
	onrename={(title) => onrenameConversation?.(conv.id.toString(), title)}
/>

{#if tagsOffered && tagsOpen}
	<ConversationTagsDialog
		bind:open={tagsOpen}
		{title}
		current={conv.tags ?? []}
		known={knownTags}
		onsave={(names) => ontagConversation?.(conv.id.toString(), names)}
	/>
{/if}

{#if shareOffered && shareOpen}
	<ShareConversationDialog bind:open={shareOpen} conversationId={conv.id.toString()} {title} />
{/if}

<!-- Delete confirmation modal -->
{#if deleteOpen}
	<DeleteConversationModal
		open={deleteOpen}
		{title}
		onclose={() => (deleteOpen = false)}
		ondelete={() => {
			deleteOpen = false;
			ondeleteConversation?.(conv.id.toString());
		}}
	/>
{/if}
