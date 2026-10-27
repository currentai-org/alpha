<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import type { EmbeddedIntent } from '$lib/chat/types/EmbeddedIntent';
	import { base } from '$lib/chat/paths';
	import { page } from '$app/state';
	import { Menu, Sidebar } from '@aipotluck/alpha-ds';

	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
	import RiMore from '~icons/ri/more-line';
	import RiPencilLine from '~icons/ri/pencil-line';
	import RiSpyLine from '~icons/ri/spy-line';
	import type { ConvSidebar } from '$lib/chat/types/ConvSidebar';

	import DeleteConversationModal from '$lib/chat/components/DeleteConversationModal.svelte';
	import RenameConversationDialog from '$lib/chat/components/RenameConversationDialog.svelte';
	import { requireAuthUser } from '$lib/chat/utils/auth';
	import { isActiveConversationId } from '$lib/chat/utils/conversationId';
	import { isLocalModelId } from '$lib/chat/identity';

	interface Props {
		conv: ConvSidebar;
		readOnly?: true;
		ondeleteConversation?: (id: string) => void;
		onrenameConversation?: (id: string, title: string) => void;
		embeddedDemo?: boolean;
		embeddedActiveConversationId?: string;
		onEmbeddedNavigate?: (intent?: EmbeddedIntent) => void;
	}

	let {
		conv,
		readOnly,
		ondeleteConversation,
		onrenameConversation,
		embeddedDemo = false,
		embeddedActiveConversationId,
		onEmbeddedNavigate
	}: Props = $props();

	// No extra query: layoutData already projects each conversation's own model onto the sidebar row
	// (ConvSidebar.model), and a local model's id carries its own prefix. `model` falls back to the
	// deployment default when a conversation has none, which is never a local id.
	const isLocal = $derived(isLocalModelId(typeof conv.model === 'string' ? conv.model : undefined));

	let deleteOpen = $state(false);
	let renameOpen = $state(false);
	let isMenuOpen = $state(false);

	// See conversationId.ts: conv.id is an ObjectId INSTANCE (not a string) for conversations loaded
	// via the sidebar's infinite-scroll pagination, so a bare `conv.id === page.params.id` would silently
	// never highlight those rows, even while their own page is open.
	let isActive = $derived(
		embeddedDemo && embeddedActiveConversationId
			? String(conv.id) === embeddedActiveConversationId
			: isActiveConversationId(conv.id, page.params.id)
	);
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
					<Menu.Item onSelect={() => (renameOpen = true)}>
						<RiPencilLine aria-hidden="true" /> Rename
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

{#if embeddedDemo}
	<Sidebar.Item
		current={isActive}
		label={conv.title}
		marker={isLocal ? localTag : undefined}
		onclick={() => onEmbeddedNavigate?.({ kind: 'conversation', id: String(conv.id) })}
	>
		{conv.title}
	</Sidebar.Item>
{:else}
	<Sidebar.Item
		current={isActive}
		label={conv.title}
		href="{base}/conversation/{conv.id}"
		data-sveltekit-noscroll
		data-sveltekit-preload-data="tap"
		data-title-source={conv.titleSource ?? undefined}
		marker={isLocal ? localTag : undefined}
		trailing={readOnly ? undefined : rowMenu}
	>
		{conv.title}
	</Sidebar.Item>
{/if}

<RenameConversationDialog
	bind:open={renameOpen}
	title={conv.title}
	onrename={(title) => onrenameConversation?.(conv.id.toString(), title)}
/>

<!-- Delete confirmation modal -->
{#if deleteOpen}
	<DeleteConversationModal
		open={deleteOpen}
		title={conv.title}
		onclose={() => (deleteOpen = false)}
		ondelete={() => {
			deleteOpen = false;
			ondeleteConversation?.(conv.id.toString());
		}}
	/>
{/if}
