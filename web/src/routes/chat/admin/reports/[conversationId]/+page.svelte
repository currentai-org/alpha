<script lang="ts">
	import { base } from "$lib/chat/paths";
	import { Button, Field, Stack } from "@aipotluck/alpha-ds";
	import type { PageData } from "./$types";

	let { data }: { data: PageData } = $props();

	const ROLE_LABEL: Record<string, string> = {
		user: "User",
		assistant: "Assistant",
		system: "System",
	};
</script>

<svelte:head><title>Gap Chat · reported conversation</title></svelte:head>

{#if data.needsReason}
	<Stack gap="4" class="mx-auto max-w-3xl px-4 py-8">
		<a href="{base}/admin/reports" class="text-small text-fg-3 hover:underline">← Reports</a>
		<h1 class="text-heading">Why are you opening this conversation?</h1>
		<p class="text-body text-fg-2">
			Nobody has reported this conversation, so there is no report to cite. Say why you need to read
			it, and the read is logged with your reason.
		</p>
		<form method="GET" class="max-w-md" data-testid="staff-read-reason">
			<Stack gap="3">
				{#if data.messageId}
					<input type="hidden" name="messageId" value={data.messageId} />
				{/if}
				<Field.Root invalid={data.reasonTried}>
					<Field.Label>Reason</Field.Label>
					<Field.Control
						name="reason"
						required
						minlength={8}
						maxlength={500}
						placeholder="CUR-1234: user asked us to check a reply"
					/>
					<Field.Description>Name the ticket or request id. Never quote the conversation.</Field.Description>
					<Field.Error>Give a reason of at least eight characters.</Field.Error>
				</Field.Root>
				<div><Button type="submit">Open the conversation</Button></div>
			</Stack>
		</form>
	</Stack>
{:else}
<div class="mx-auto max-w-3xl space-y-4 px-4 py-8 text-sm">
	<header class="space-y-1">
		<a href="{base}/admin/reports" class="text-xs text-gray-500 hover:underline">← Reports</a>
		<h1 class="text-xl font-semibold">{data.title}</h1>
		<p class="font-mono text-xs text-gray-400">
			{data.conversationId}{#if data.createdAt}
				· {new Date(data.createdAt).toLocaleString()}{/if}
		</p>
		<p class="text-xs text-gray-500">
			Read-only transcript for triage. This read is logged with its reason: {data.reason}
		</p>
	</header>

	{#if data.messages.length === 0}
		<p class="rounded bg-gray-50 px-3 py-2 text-gray-500">This conversation has no messages.</p>
	{:else}
		<ol class="space-y-3">
			{#each data.messages as m (m.id)}
				{@const focused = data.focusMessageId === m.id}
				<li
					class="rounded border px-3 py-2 {focused
						? 'border-amber-400 bg-amber-50 ring-1 ring-amber-300'
						: 'border-gray-200'}"
				>
					<div class="mb-1 flex items-center gap-2">
						<span
							class="text-xs font-semibold {m.from === 'assistant'
								? 'text-muted-red'
								: m.from === 'user'
									? 'text-gray-700'
									: 'text-gray-400'}"
						>
							{ROLE_LABEL[m.from] ?? m.from}
						</span>
						{#if focused}
							<span
								class="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-medium text-amber-900"
								>reported</span
							>
						{/if}
					</div>
					<!-- Plain text, Svelte-escaped + whitespace-preserving. No markdown render: a reported
					     turn is untrusted content, so we never feed it through an HTML renderer here. -->
					<div class="break-words whitespace-pre-wrap text-gray-900">{m.content}</div>
				</li>
			{/each}
		</ol>
	{/if}
</div>
{/if}
