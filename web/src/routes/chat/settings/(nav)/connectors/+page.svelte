<script lang="ts">
	import { enhance } from "$app/forms";
	import { Badge, Button, Field, Inline, Stack, Toggle, ToggleGroup } from "@aipotluck/alpha-ds";
	import { base } from "$lib/chat/paths";
	import { mcpToolPolicyFor, type McpToolPolicy } from "$lib/chat/mcpToolPolicy";
	import type { ActionData, PageData } from "./$types";

	// Settings → Connectors (CUR-3984). Each service chat is connected to, its tools, and the person's
	// choice for each: always allow (no confirmation card), ask first (today's card for a tool that can
	// change something) or never (the tool is not offered and does not run). Saved with their settings.
	//
	// A signed-in person can add a server of their own and remove it again (CUR-4016).
	let { data, form }: { data: PageData; form: ActionData } = $props();
	let adding = $state(false);
	// What a refused add sent back: the reason, and the name and address to put back in the form. The
	// token is never among them.
	const refused = $derived(
		form && "error" in form
			? { error: form.error, name: "name" in form ? form.name : "", url: "url" in form ? form.url : "" }
			: undefined
	);

	// The page owns the map once loaded; each change is saved whole, the way the server stores it.
	// svelte-ignore state_referenced_locally
	let policies = $state<Record<string, McpToolPolicy>>({ ...data.policies });
	let status = $state<"idle" | "saving" | "saved" | "failed">("idle");

	const WRITE_OPTIONS: [McpToolPolicy, string][] = [
		["allow", "Always allow"],
		["ask", "Ask first"],
		["block", "Never"],
	];
	// A read-only tool already runs without asking, so "ask" and "allow" are the same choice for it.
	const READ_OPTIONS: [McpToolPolicy, string][] = [
		["allow", "Allow"],
		["block", "Never"],
	];

	function shown(fnName: string, readOnly: boolean): McpToolPolicy {
		const p = mcpToolPolicyFor(policies, fnName);
		return readOnly && p === "ask" ? "allow" : p;
	}

	async function choose(fnName: string, next: McpToolPolicy) {
		const before = policies;
		policies = { ...policies, [fnName]: next };
		status = "saving";
		try {
			const res = await fetch(`${base}/settings`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mcpToolPolicies: policies }),
			});
			await res.text();
			if (!res.ok) throw new Error(String(res.status));
			status = "saved";
		} catch {
			policies = before;
			status = "failed";
		}
	}
</script>

<div class="flex flex-col gap-6">
	<p class="type-body text-fg-2">
		The services this chat is connected to, and what each of their tools may do. A tool that can change
		something asks you before it runs, unless you set it to always allow.
	</p>

	{#if data.servers.length === 0}
		<p class="type-body text-fg-2" data-connectors-empty>No services are connected to this chat yet.</p>
	{/if}

	{#each data.servers as server (server.name)}
		<section class="flex flex-col gap-3" aria-labelledby="connector-{server.name}" data-connector={server.name}>
			<div class="flex flex-wrap items-baseline justify-between gap-2">
				<h2 id="connector-{server.name}" class="type-subhead text-fg-1">{server.name}</h2>
				<span class="type-caption text-fg-2">{server.host}</span>
			</div>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<span class="type-caption text-fg-2" data-connector-status={server.tools.length > 0 ? "connected" : "unreachable"}>
					{#if server.tools.length > 0}Connected · {server.tools.length} {server.tools.length === 1 ? "tool" : "tools"}{:else}Not answering{/if}
				</span>
				{#if server.ownId}
					<form method="POST" action="?/remove" use:enhance>
						<input type="hidden" name="id" value={server.ownId} />
						<Button type="submit" variant="secondary" size="sm" aria-label="Remove {server.name}">Remove</Button>
					</form>
				{/if}
			</div>
			{#if server.tools.length === 0}
				<p class="type-body text-fg-2">This service didn’t answer just now, so its tools aren’t listed. They’re left out of chat until it does.</p>
			{:else}
				<ul class="flex flex-col gap-3" aria-label="Tools on {server.name}">
					{#each server.tools as tool (tool.fnName)}
						<li class="flex flex-col gap-2 border border-line-2 p-3 rounded-card" data-connector-tool={tool.fnName}>
							<div class="flex flex-wrap items-center justify-between gap-2">
								<span class="type-label text-fg-1">{tool.name}</span>
								{#if tool.readOnly}
									<Badge tone="outline">Read-only</Badge>
								{:else}
									<Badge tone="caution">Changes something</Badge>
								{/if}
							</div>
							{#if tool.description}
								<p class="type-body text-fg-2">{tool.description}</p>
							{/if}
							<ToggleGroup
								value={[shown(tool.fnName, tool.readOnly)]}
								onValueChange={(v: string[]) => v[0] && choose(tool.fnName, v[0] as McpToolPolicy)}
								aria-label="{tool.name} on {server.name}"
							>
								{#each tool.readOnly ? READ_OPTIONS : WRITE_OPTIONS as [value, label] (value)}
									<Toggle {value}>{label}</Toggle>
								{/each}
							</ToggleGroup>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/each}

	<section class="flex flex-col gap-3" aria-labelledby="connector-add">
		<h2 id="connector-add" class="type-subhead text-fg-1">Add your own server</h2>
		{#if data.signedIn}
			<form
				method="POST"
				action="?/add"
				class="flex flex-col gap-3"
				data-testid="connector-add-form"
				use:enhance={() => {
					adding = true;
					return async ({ update }) => {
						await update();
						adding = false;
					};
				}}
			>
				<Stack gap="3">
					<Field.Root>
						<Field.Label>Name</Field.Label>
						<Field.Control name="name" value={refused?.name ?? ""} autocomplete="off" placeholder="notes" required />
						<Field.Description>Lower-case letters, digits and hyphens. Its tools are named after it.</Field.Description>
					</Field.Root>
					<Field.Root>
						<Field.Label>Server URL</Field.Label>
						<Field.Control name="url" type="url" value={refused?.url ?? ""} autocomplete="off" placeholder="https://example.com/mcp" required />
						<Field.Description>A remote MCP server that speaks Streamable HTTP, at a public https:// address.</Field.Description>
					</Field.Root>
					<Field.Root>
						<Field.Label>Bearer token (optional)</Field.Label>
						<Field.Control name="token" type="password" autocomplete="off" />
						<Field.Description>Sent only to this server. Stored encrypted and never shown again.</Field.Description>
					</Field.Root>
				</Stack>
				{#if refused?.error}
					<p class="m-0 type-body text-fg-1" role="alert" data-testid="connector-add-error">{refused.error}</p>
				{/if}
				<Inline justify="end">
					<Button type="submit" variant="primary" disabled={adding}>{adding ? "Adding…" : "Add server"}</Button>
				</Inline>
			</form>
		{:else}
			<p class="type-body text-fg-2" data-connector-add-signin>Sign in to add an MCP server of your own.</p>
		{/if}
	</section>

	<p class="type-caption text-fg-2" aria-live="polite" data-connectors-status={status}>
		{#if status === "saving"}Saving…{:else if status === "saved"}Saved{:else if status === "failed"}Couldn’t save that change. Try again.{/if}
	</p>
</div>
