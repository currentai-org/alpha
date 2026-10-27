<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	// Adapted from the "Local Inference Settings Tab" design (CUR-1194, CUR-1262). Styled from
	// design-system.md directly (--ap-* tokens), matching account/+page.svelte and application/+page.svelte
	// rather than the mockup's own hardcoded hex values. Same busy/actionError idiom as
	// account/+page.svelte (one key at a time — "add", or "remove:<id>" — plus one shared error banner)
	// rather than a separate flag per action.
	//
	// Wired to the real per-user local_inference_endpoints CRUD (api/v2/user/local-inference-
	// endpoints). A plain (non-unique) index on the user lets this list hold more than one server.
	import { onMount, onDestroy, type Component } from "svelte";
	import { page } from "$app/state";
	import RiAddLine from "~icons/ri/add-line";
	import RiDeleteBinLine from "~icons/ri/delete-bin-line";
	import RiArrowRightSLine from "~icons/ri/arrow-right-s-line";
	import RiRefreshLine from "~icons/ri/refresh-line";
	import RiErrorWarningFill from "~icons/ri/error-warning-fill";
	import RiUbuntuLine from "~icons/ri/ubuntu-line";
	import RiMacLine from "~icons/ri/mac-line";
	import RiWindowsLine from "~icons/ri/windows-line";
	import RiAppleLine from "~icons/ri/apple-line";
	import RiAndroidLine from "~icons/ri/android-line";
	import RiTerminalLine from "~icons/ri/terminal-line";
	import RiWindowLine from "~icons/ri/window-line";
	import RiDownloadLine from "~icons/ri/download-line";
	import { Tabs } from "@aipotluck/alpha-ds";
	import CopyLabelButton from "$lib/chat/components/CopyLabelButton.svelte";
	import { useAPIClient, handleResponse, apiErrorMessage } from "$lib/chat/APIClient";
	import { safeInvalidate } from "$lib/chat/utils/safeInvalidate";
	import { randomUUID } from "$lib/chat/utils/randomUuid";
	import { randomServerName } from "$lib/chat/utils/randomServerName";

	type LocalServerRow = {
		id: string;
		label: string;
		baseUrl: string;
		headers: { name: string; value: string }[];
		createdAt: string;
		// Absent on rows created before this column existed (superjson won't backfill a
		// default), so treat undefined the same as "direct" everywhere it's read below. (CUR-1266)
		kind?: "direct" | "managed";
	};
	// Shown exactly once, right after provisioning — the tunnel secret is never returned
	// again by any GET, matching the "reveal-once" credential hygiene this feature needs. (CUR-1266)
	type ManagedInstallArgs = { tunnelId: string; tunnelSecret: string; tunnelEndpoint: string };
	// CUR-1291 (design: "Local Inference Settings Tab", Advanced Options revision): one custom HTTP
	// header to send with every request to a server being added. Persisted alongside the server on
	// create (api/v2/user/local-inference-endpoints, schema.ts's `headers` jsonb column) and applied
	// to every request this endpoint makes — discovery, prewarm, and generation alike (see
	// localModels.ts's headersRecord()).
	type HeaderRow = { id: string; name: string; value: string };

	// aipotluck-local-client's own public one-line installers, as its README gives them: install.sh
	// for Linux/macOS, install.ps1 for Windows, both "no arguments, installs logged out".
	const LOCAL_CLIENT_RAW = "https://raw.githubusercontent.com/currentai-org/aipotluck-local-client/main";
	const LOCAL_CLIENT_INSTALL_SH = `${LOCAL_CLIENT_RAW}/install.sh`;
	const LOCAL_CLIENT_INSTALL_PS1 = `${LOCAL_CLIENT_RAW}/install.ps1`;

	// The desktop app's installers, always from aipotluck-local-client-gui's newest full
	// release. GitHub redirects releases/latest/download/<name> to that file in whichever release is
	// marked Latest, and every release carries each installer under a fixed, version-free name for
	// exactly this, so a new GUI release reaches this page with no change here.
	//
	// The fixed names are a contract owned by the GUI repo: .github/latest-download-names.txt there.
	// Every guiFile() suffix below must be on that list, or its link 404s. To add, drop or rename a
	// download, follow docs/guides/local-client-downloads.md: the GUI repo changes first. (CUR-4416)
	const GUI_LATEST = "https://github.com/currentai-org/aipotluck-local-client-gui/releases/latest/download";
	const guiFile = (suffix: string) => `${GUI_LATEST}/aipotluck-local-client-gui_${suffix}`;

	// The install step is per-platform now. Two pickers — which machine, then how it is
	// delivered — because the answer to the second differs by the first: a phone has no terminal, and
	// a desktop can take either. (CUR-3168)
	type Platform = "linux" | "macos" | "windows" | "ios" | "android";
	type Delivery = "cli" | "gui";

	const PLATFORMS: { id: Platform; label: string; icon: Component }[] = [
		// Remix ships no generic Linux mark (no Tux), so Ubuntu's stands in — the nearest thing to a
		// recognisable "Linux" glyph in the one icon set this project uses.
		{ id: "linux", label: "Linux", icon: RiUbuntuLine },
		// A Mac, not the Apple logo: that is reserved below for iOS, where it is the only mark people
		// read as "the App Store one".
		{ id: "macos", label: "macOS", icon: RiMacLine },
		{ id: "windows", label: "Windows", icon: RiWindowsLine },
		{ id: "ios", label: "iOS", icon: RiAppleLine },
		{ id: "android", label: "Android", icon: RiAndroidLine },
	];

	// A phone is a GUI-only machine: there is no terminal to paste a command into, so the CLI choice
	// is disabled rather than hidden — a disabled control still answers "can I do it that way?".
	const GUI_ONLY: Platform[] = ["ios", "android"];

	/** One installer file: which CPU and format it is for, and where it downloads from. */
	type DownloadFile = { label: string; href: string };

	/** What we can actually hand someone today, keyed `platform:delivery`. Everything absent renders
	 *  as unavailable, so shipping a new build is one line here rather than a UI change. An app build
	 *  lists every file the release has for that platform: one per CPU and installer format. */
	const DOWNLOADS: Partial<
		Record<`${Platform}:${Delivery}`, { command: string } | { files: DownloadFile[] }>
	> = {
		"linux:cli": { command: `curl -fsSL ${LOCAL_CLIENT_INSTALL_SH} | bash` },
		"macos:cli": { command: `curl -fsSL ${LOCAL_CLIENT_INSTALL_SH} | bash` },
		"windows:cli": { command: `irm ${LOCAL_CLIENT_INSTALL_PS1} | iex` },
		"linux:gui": {
			files: [
				{ label: "x64 · .deb", href: guiFile("linux-x64.deb") },
				{ label: "x64 · .AppImage", href: guiFile("linux-x64.AppImage") },
				{ label: "ARM64 · .deb", href: guiFile("linux-arm64.deb") },
				{ label: "ARM64 · .AppImage", href: guiFile("linux-arm64.AppImage") },
			],
		},
		"macos:gui": {
			files: [
				{ label: "Apple silicon · .dmg", href: guiFile("macos-arm64.dmg") },
				{ label: "Apple silicon · .app.zip", href: guiFile("macos-arm64.app.zip") },
				{ label: "Intel · .dmg", href: guiFile("macos-x64.dmg") },
				{ label: "Intel · .app.zip", href: guiFile("macos-x64.app.zip") },
			],
		},
		"windows:gui": {
			files: [{ label: "x64 · installer (.exe)", href: guiFile("windows-x64.setup.exe") }],
		},
	};

	const client = useAPIClient();

	let name = $state("");
	let url = $state("");
	let servers = $state<LocalServerRow[]>([]);
	let ready = $state(false);

	let advancedOpen = $state(false);
	let headerName = $state("");
	let headerValue = $state("");
	let headers = $state<HeaderRow[]>([]);

	// One key at a time — "add", or "remove:<id>" — same idiom as account/+page.svelte's `busy`.
	let busy = $state<string | null>(null);
	let actionError = $state("");
	// Separate from `busy` -- the refresh button doesn't touch server rows or block the add/remove
	// forms, it just forces an out-of-cycle status poll + model-list requery.
	let refreshing = $state(false);

	// Managed (tunnel) servers — a separate small form (label only, no URL: Pangolin
	// assigns the hostname), and the one-time install payload shown right after pairing. (CUR-1266)
	// suggested, not required — a name is only a label in a list, so any answer is right,
	// which is exactly why people stall on the field. Re-rolled after each pair rather than cleared,
	// so the next one is also a thing to accept rather than a thing to invent. (CUR-3168)
	let managedName = $state(randomServerName());
	let managedInstallArgs = $state<ManagedInstallArgs | null>(null);
	// The manual pair form (name, Pair, the one-time credentials) is folded away by default;
	// installing the client, which pairs itself, is the path the card leads with. (CUR-1324)
	let manualPairOpen = $state(false);
	// Which build the install step is describing. CUR-1324: the app is the default now that
	// it ships for every desktop platform, as the design always wanted; the command line stays one tab
	// away.
	//
	// Delivery is forced to GUI on a phone, but kept as its own state so switching back to a desktop
	// restores the pick rather than silently leaving them somewhere they did not choose. (CUR-3168)
	let platform = $state<Platform>("linux");
	let delivery = $state<Delivery>("gui");
	const guiOnly = $derived(GUI_ONLY.includes(platform));
	const effectiveDelivery = $derived<Delivery>(guiOnly ? "gui" : delivery);
	const download = $derived(DOWNLOADS[`${platform}:${effectiveDelivery}`]);
	// Built here rather than assembled from template expressions: Svelte renders each `{...}` as
	// its own text node, which splits the sentence for anything reading the DOM — a screen reader
	// hears it whole, but a test (and copy-to-clipboard) sees fragments.
	const unavailableNote = $derived.by(() => {
		const name = PLATFORMS.find((o) => o.id === platform)?.label ?? platform;
		return effectiveDelivery === "cli" ? m.local_noCliBuild({ platform: name }) : m.local_noAppBuild({ platform: name });
	});
	// id -> online, or `undefined` before the first poll resolves (CUR-1267). A separate map from
	// `servers` itself since status is polled independently of the row list. Every server gets a
	// status icon, direct and managed alike -- direct just has one check (is the server up);
	// managed has two (is the tunnel up, then is the server behind it up), see the status API route.
	let serverStatus = $state<Record<string, boolean | undefined>>({});
	// id -> a standing, structural error for this row (e.g. a managed row's Pangolin site no longer
	// exists, or its tunnel is open but the server behind it isn't answering), distinct from
	// serverStatus's online/offline dot. Rendered as an amber exclamation mark instead of a dot --
	// unlike offline, this can't resolve on its own poll-to-poll, so it isn't "red" in the same
	// transient sense.
	let serverError = $state<Record<string, string | undefined>>({});
	// id -> a stable, order-independent key for the model-id set the last poll discovered (see
	// modelIdsKey below) -- lets pollServerStatuses tell "the list changed" from "the list came back
	// in a different order" without keeping the full array around per row.
	let serverModelKeys = $state<Record<string, string | undefined>>({});
	// Whether Pangolin itself is reachable right now — distinct from page.data.managedInferenceEnabled
	// (whether the FEATURE exists on this deployment, which decides if this whole section even renders).
	// `undefined` while the one-shot check is in flight; the Pair control stays disabled through that
	// state too, same as a resolved `false` — there's nothing safe to let a user attempt before we know.
	let managedAvailable = $state<boolean | undefined>(undefined);

	async function checkManagedAvailability() {
		try {
			const result = handleResponse(
				await client.user["local-inference-endpoints"].managed.availability.get()
			) as { available: boolean };
			managedAvailable = result.available;
		} catch {
			// A failed check reads as "unavailable," not "unknown" — the Pair control has nothing safer
			// to fall back to than staying disabled.
			managedAvailable = false;
		}
	}

	async function loadServers() {
		try {
			servers = handleResponse(
				await client.user["local-inference-endpoints"].get()
			) as LocalServerRow[];
			actionError = "";
		} catch (err) {
			actionError = apiErrorMessage(err, m.local_loadFailed());
		} finally {
			ready = true;
		}
	}

	onMount(() => {
		loadServers().then(pollServerStatuses);
		statusTimer = setInterval(pollServerStatuses, STATUS_POLL_INTERVAL_MS);
		if (page.data.managedInferenceEnabled) checkManagedAvailability();
	});

	onDestroy(() => {
		if (statusTimer) clearInterval(statusTimer);
	});

	async function addServer() {
		const trimmedName = name.trim();
		const trimmedUrl = url.trim();
		if (!trimmedName || !trimmedUrl || busy) return;

		busy = "add";
		actionError = "";
		try {
			const row = handleResponse(
				await client.user["local-inference-endpoints"].post({
					label: trimmedName,
					baseUrl: trimmedUrl,
					headers: headers.map(({ name, value }) => ({ name, value })),
				})
			) as LocalServerRow;
			servers = [...servers, row];
			name = "";
			url = "";
			// The headers just entered belong to the server that was just created, not to whatever's
			// added next — clear the form the same way name/url do.
			headers = [];
			// The "Models" dropdown (and everywhere else data.models is read) depends on app:models —
			// without this, a newly-added server's models don't show up until something else happens to
			// invalidate it (a full reload, a different settings change).
			await safeInvalidate("app:models");
		} catch (err) {
			actionError = apiErrorMessage(err, m.local_addFailed());
		} finally {
			busy = null;
		}
	}

	function addHeader() {
		const trimmedName = headerName.trim();
		if (!trimmedName) return;
		headers = [...headers, { id: randomUUID(), name: trimmedName, value: headerValue.trim() }];
		headerName = "";
		headerValue = "";
	}

	function removeHeader(id: string) {
		headers = headers.filter((h) => h.id !== id);
	}

	async function removeServer(server: LocalServerRow) {
		if (busy) return;
		busy = `remove:${server.id}`;
		actionError = "";
		try {
			handleResponse(await client.user["local-inference-endpoints"]({ id: server.id }).delete());
			servers = servers.filter((s) => s.id !== server.id);
			delete serverStatus[server.id];
			delete serverError[server.id];
			delete serverModelKeys[server.id];
			await safeInvalidate("app:models");
		} catch (err) {
			actionError = apiErrorMessage(err, m.local_removeFailed());
		} finally {
			busy = null;
		}
	}

	async function pairManagedServer() {
		const trimmedName = managedName.trim();
		if (!trimmedName || busy) return;

		busy = "pair";
		actionError = "";
		try {
			// The advanced-options headers are shared by both add forms now, so a managed
			// pair carries them too. The server merges them UNDER Pangolin's own access-token headers,
			// which must win — see the managed route. (CUR-3168)
			const customHeaders = headers.map(({ name, value }) => ({ name, value }));
			const result = handleResponse(await client.user["local-inference-endpoints"].managed.post({
				label: trimmedName,
				headers: customHeaders,
			})) as { id: string; label: string; installArgs: ManagedInstallArgs };
			servers = [
				...servers,
				{
					id: result.id,
					label: result.label,
					baseUrl: "",
					headers: customHeaders,
					createdAt: new Date().toISOString(),
					kind: "managed",
				},
			];
			managedInstallArgs = result.installArgs;
			managedName = randomServerName();
			headers = [];
			await safeInvalidate("app:models");
		} catch (err) {
			actionError = apiErrorMessage(err, m.local_pairFailed());
		} finally {
			busy = null;
		}
	}

	// Poll every row's status while this tab is mounted, direct and managed alike.
	// A plain interval, not an SSE stream — nothing here needs sub-second latency, and this is a
	// settings page a user only has open occasionally, unlike BackgroundGenerationPoller.svelte's
	// always-mounted case. (CUR-1266/CUR-1267)
	const STATUS_POLL_INTERVAL_MS = 10_000;
	let statusTimer: ReturnType<typeof setInterval> | undefined;

	// Order-independent identity for a discovered model-id set — lets pollServerStatuses tell "the
	// list actually changed" from "the server just returned it in a different order this time".
	function modelIdsKey(modelIds: string[]): string {
		return [...modelIds].sort().join("\u0000");
	}

	async function pollServerStatuses() {
		let modelsChanged = false;
		await Promise.all(
			servers.map(async (server) => {
				try {
					const result = handleResponse(
						await client.user["local-inference-endpoints"]({ id: server.id }).status.get()
					) as { online: boolean; error?: string; modelIds?: string[] };
					serverStatus[server.id] = result.online;
					serverError[server.id] = result.error;
					if (result.modelIds) {
						const key = modelIdsKey(result.modelIds);
						const prevKey = serverModelKeys[server.id];
						// undefined -> first time we've seen this row's models; not a "change" to react to.
						if (prevKey !== undefined && prevKey !== key) modelsChanged = true;
						serverModelKeys[server.id] = key;
					}
				} catch {
					// A transient poll failure reads as "unknown," not "offline" — don't flash red on
					// one dropped request.
				}
			})
		);
		// Only the picker cares about this, and only when a row's model set actually moved — avoid
		// invalidating app:models on every ~10s tick when nothing changed.
		if (modelsChanged) await safeInvalidate("app:models");
	}

	// Manual stopgap for CUR-1266's polling-only status: force an out-of-cycle status poll (rather
	// than waiting up to STATUS_POLL_INTERVAL_MS for a device that just came online to flip green),
	// then requery the model list the same way add/remove/pair already do -- covers "a server just
	// connected and I want its models to show up now" without a real connect/disconnect callback from
	// aipotluck-local-client, which isn't in place yet. Unconditional, unlike pollServerStatuses'
	// own diff-gated invalidate — an explicit click is itself the signal something may have changed.
	async function refreshStatuses() {
		if (refreshing) return;
		refreshing = true;
		try {
			await pollServerStatuses();
			await safeInvalidate("app:models");
		} finally {
			refreshing = false;
		}
	}

	const cardClass = "border border-line-2 bg-surface-2 rounded-card";
	const rowButtonClass =
		"flex h-8 flex-none items-center gap-1.5 border border-line-2 bg-surface-3 px-2.5 text-left text-small text-fg-1 transition-colors hover:bg-tint-hover disabled:cursor-not-allowed disabled:opacity-40";
	const labelClass =
		"font-mono text-micro tracking-wide text-fg-3 uppercase";
	const inputClass =
		"border border-line-2 bg-surface-3 px-3 py-1.5 text-small text-fg-1 placeholder:text-fg-3 outline-hidden focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40";
	const addButtonClass =
		"flex h-[34px] flex-none items-center justify-center gap-1.5 border border-line-2 bg-surface-3 px-3 text-small font-medium tracking-wide text-fg-1 uppercase transition-colors hover:bg-tint-hover disabled:cursor-not-allowed disabled:opacity-40";
	const headerRemoveButtonClass =
		"flex size-7 flex-none items-center justify-center border border-line-2 bg-surface-3 transition-colors hover:bg-tint-hover";
</script>


<div class="flex w-full flex-col gap-4 text-body text-fg-1">
	<!-- Title comes from the settings layout's PageHeader. -->

	{#if actionError}
		<p
			class="border border-line-2 bg-surface-2 px-3 py-2 text-small rounded-card"
		>
			{actionError}
		</p>
	{/if}

	<!-- Add a managed server (CUR-1266). CUR-1324: the client pairs itself now (CUR-4110's one-click
	     login, from the CLI or the app), so installing it is the main path and comes first, always
	     shown. Naming a server here and copying its credentials across is the manual fallback, folded
	     away below. -->
	{#if page.data.managedInferenceEnabled}
		{@const pairUnavailable = managedAvailable !== true}
		{@const pairUnavailableTitle =
			managedAvailable === undefined
				? m.local_checkingManaged()
				: m.local_managedUnavailable()}
		<section class="flex flex-col gap-2">
			<div class="{cardClass} px-4 py-4">
				<div class="text-body font-medium">{m.local_addManagedTitle()}</div>
				<p class="text-small text-fg-3">
					{m.local_addManagedHelp()}
				</p>

				<div class="mt-4 flex flex-col gap-1">
					<div class={labelClass}>{m.local_installClient()}</div>

					<!-- Which machine, then how it arrives. Tabs rather than a select: there are few
					     enough options to show at once, and seeing the whole list is half the answer
					     to "is my platform supported yet?". -->
					<Tabs.Root bind:value={platform} class="mt-2 gap-3">
						<Tabs.List>
							{#each PLATFORMS as option (option.id)}
								<Tabs.Tab value={option.id}>
									<option.icon aria-hidden="true" />
									{option.label}
								</Tabs.Tab>
							{/each}
						</Tabs.List>
					</Tabs.Root>

					<Tabs.Root
						value={effectiveDelivery}
						onValueChange={(next) => (delivery = next as Delivery)}
						class="gap-3"
					>
						<Tabs.List>
							<Tabs.Tab value="gui">
								<RiWindowLine aria-hidden="true" />
								{m.local_app()}
							</Tabs.Tab>
							<Tabs.Tab
								value="cli"
								disabled={guiOnly}
								title={guiOnly ? m.local_noTerminal() : undefined}
							>
								<RiTerminalLine aria-hidden="true" />
								{m.local_commandLine()}
							</Tabs.Tab>
						</Tabs.List>
					</Tabs.Root>

					{#if download && "command" in download}
						<p class="text-small text-fg-3">{m.local_runInTerminal()}</p>
						<div class="flex items-start gap-2">
							<pre
								class="flex-1 overflow-x-auto border border-line-1 bg-surface-3 px-3 py-2 font-mono text-micro whitespace-pre-wrap">{download.command}</pre>
							<CopyLabelButton
								getText={() => download.command}
								errorMessage={m.local_copyCommandFailed()}
								onError={(message) => (actionError = message)}
								class="{rowButtonClass} flex-none"
							/>
						</div>
					{:else if download}
						{@const platformLabel = PLATFORMS.find((o) => o.id === platform)?.label ?? platform}
						<p class="text-small text-fg-3">{m.local_downloadRun()}</p>
						<div class="flex flex-wrap gap-2">
							{#each download.files as file (file.href)}
								<a
									href={file.href}
									class={rowButtonClass}
									aria-label={m.local_downloadFileFor({ platform: platformLabel, file: file.label })}
								>
									<RiDownloadLine class="size-3.5 flex-none" />
									<span>{file.label}</span>
								</a>
							{/each}
						</div>
					{:else}
						<!-- Named rather than hidden: someone checking whether their platform is coming
						     gets a straight answer instead of an empty panel. -->
						<p class="text-small text-fg-3">
							<span class="text-fg-2">{m.local_unavailable()}</span> — {unavailableNote}
						</p>
					{/if}

					<!-- How the installed client signs in. Only under a real download: next to "no build
					     yet" it would tell someone to run something that doesn't exist. -->
					{#if download}
						<p class="mt-1 text-small text-fg-2" data-testid="local-login-step">
							{#if effectiveDelivery === "cli"}
								{#each m.local_loginCli({ command: "{command}" }).split(/(\{command\})/).filter(Boolean) as part, i (i)}{#if part === "{command}"}<code class="font-mono">aipotluck-local-client login</code>{:else}{part}{/if}{/each}
							{:else}
								{m.local_loginGui()}
							{/if}
						</p>
					{/if}
				</div>

				<!-- The manual fallback: name a server here, then hand its credentials to the client
				     yourself. Same disclosure shape as Advanced Options below. -->
				<div class="mt-4">
					<button
						type="button"
						onclick={() => (manualPairOpen = !manualPairOpen)}
						aria-expanded={manualPairOpen}
						class="flex items-center gap-2 text-small font-medium tracking-wide text-fg-2 uppercase transition-colors hover:text-fg-1"
					>
						<RiArrowRightSLine
							class="size-3.5 flex-none transition-transform {manualPairOpen ? 'rotate-90' : ''}"
						/>
						<span>{m.local_pairManually()}</span>
					</button>

					{#if manualPairOpen}
						<form
							class="mt-4 flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
							onsubmit={(e) => {
								e.preventDefault();
								pairManagedServer();
							}}
						>
							<label class="flex flex-col gap-1.5">
								<span class={labelClass}>{m.local_name()}</span>
								<input
									type="text"
									bind:value={managedName}
									placeholder={m.local_managedPlaceholder()}
									disabled={!!busy || pairUnavailable}
									title={pairUnavailable ? pairUnavailableTitle : undefined}
									class={inputClass}
								/>
							</label>
							<button
								type="submit"
								disabled={!!busy || !managedName.trim() || pairUnavailable}
								title={pairUnavailable ? pairUnavailableTitle : undefined}
								class={addButtonClass}
							>
								<RiAddLine class="size-3.5 flex-none" />
								<span>{busy === "pair" ? m.local_pairing() : m.local_pair()}</span>
							</button>
						</form>

						{#if managedInstallArgs}
							<div class="mt-4 flex flex-col gap-1">
								<div class={labelClass}>{m.local_manualCredentials()}</div>
								<p class="text-small text-fg-3">
									{#each m.local_manualCredentialsHelp({ command: "{command}" }).split(/(\{command\})/).filter(Boolean) as part, i (i)}{#if part === "{command}"}<code class="font-mono">aipotluck-local-client login --credentials-file &lt;file&gt;</code>{:else}{part}{/if}{/each}
								</p>
								<div class="flex items-start gap-2">
									<pre
										class="flex-1 overflow-x-auto border border-line-1 bg-surface-3 px-3 py-2 font-mono text-micro whitespace-pre-wrap">{JSON.stringify(
											managedInstallArgs,
											null,
											2
										)}</pre>
									<!-- Compact, non-pretty-printed JSON on the clipboard: one line suits both a
									     credentials file and the app's paste field. The <pre> above still displays
									     it pretty-printed. -->
									<CopyLabelButton
										getText={() => JSON.stringify(managedInstallArgs)}
										errorMessage={m.local_copyJsonFailed()}
										onError={(message) => (actionError = message)}
										class="{rowButtonClass} flex-none"
									/>
								</div>
							</div>
						{/if}
					{/if}
				</div>
			</div>
		</section>
	{/if}

	<!-- Add a direct server connection (a URL this Potluck server reaches itself) -->
	<section class="flex flex-col gap-2">
		<div class="{cardClass} px-4 py-4">
			<div class="text-body font-medium">{m.local_addTitle()}</div>
			<p class="text-small text-fg-3">
				{m.local_addHelp()}
			</p>

			<form
				class="mt-4 flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] sm:items-end"
				onsubmit={(e) => {
					e.preventDefault();
					addServer();
				}}
			>
				<label class="flex flex-col gap-1.5">
					<span class={labelClass}>{m.local_name()}</span>
					<input
						type="text"
						bind:value={name}
						placeholder={m.local_namePlaceholder()}
						disabled={!!busy}
						class={inputClass}
					/>
				</label>
				<label class="flex flex-col gap-1.5">
					<span class={labelClass}>{m.local_serverUrl()}</span>
					<input
						type="text"
						bind:value={url}
						placeholder="http://localhost:11434"
						disabled={!!busy}
						class="{inputClass} font-mono"
					/>
				</label>
				<button
					type="submit"
					disabled={!!busy || !name.trim() || !url.trim()}
					class={addButtonClass}
				>
					<RiAddLine class="size-3.5 flex-none" />
					<span>{busy === "add" ? m.local_adding() : m.local_addServer()}</span>
				</button>
			</form>

		</div>
	</section>

	<!-- Advanced options, shared by both add forms (CUR-3168). Lives in its own card because it
	     is no longer the manual form's own disclosure: anything set here rides along with whichever
	     server is added next, managed or manual. -->
	<section class="flex flex-col gap-2">
		<div class="{cardClass} px-4 py-4">
			<div>
				<button
					type="button"
					onclick={() => (advancedOpen = !advancedOpen)}
					aria-expanded={advancedOpen}
					class="flex items-center gap-2 text-small font-medium tracking-wide text-fg-2 uppercase transition-colors hover:text-fg-1"
				>
					<RiArrowRightSLine
						class="size-3.5 flex-none transition-transform {advancedOpen ? 'rotate-90' : ''}"
					/>
					<span>{m.local_advanced()}</span>
				</button>

				{#if advancedOpen}
					<div class="mt-4 flex flex-col gap-3">
						<div>
							<div class={labelClass}>{m.local_customHeaders()}</div>
							<p class="text-small text-fg-3">
								{m.local_headersHelp()}
								<span class="font-mono text-fg-1">{"{{conversationId}}"}</span>,
								<span class="font-mono text-fg-1">{"{{userId}}"}</span>,
								<span class="font-mono text-fg-1">{"{{modelId}}"}</span>
							</p>
						</div>

						<form
							class="flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] sm:items-end"
							onsubmit={(e) => {
								e.preventDefault();
								addHeader();
							}}
						>
							<label class="flex flex-col gap-1.5">
								<span class={labelClass}>{m.local_headerName()}</span>
								<input
									type="text"
									bind:value={headerName}
									placeholder="Authorization"
									disabled={!!busy}
									class="{inputClass} font-mono"
								/>
							</label>
							<label class="flex flex-col gap-1.5">
								<span class={labelClass}>{m.local_value()}</span>
								<input
									type="text"
									bind:value={headerValue}
									placeholder="Bearer …"
									disabled={!!busy}
									class="{inputClass} font-mono"
								/>
							</label>
							<button type="submit" disabled={!!busy || !headerName.trim()} class={rowButtonClass}>
								<RiAddLine class="size-3.5 flex-none" />
								<span>{m.local_addHeader()}</span>
							</button>
						</form>

						{#if headers.length > 0}
							<div class="border border-line-1 rounded-card">
								{#each headers as header (header.id)}
									<div
										class="flex items-center justify-between gap-3 border-b border-line-1 px-3 py-2 last:border-b-0"
									>
										<div
											class="flex min-w-0 items-baseline gap-2 font-mono text-small"
										>
											<span class="text-fg-1">{header.name}</span>
											<span class="text-fg-3">:</span>
											<span class="truncate text-fg-3">{header.value}</span>
										</div>
										<button
											type="button"
											onclick={() => removeHeader(header.id)}
											aria-label={m.local_removeHeader({ name: header.name })}
											class={headerRemoveButtonClass}
										>
											<RiDeleteBinLine class="size-3.5 text-accent-2-text" />
										</button>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</section>


	<!-- Existing servers -->
	<section class="flex flex-col gap-2">
		<div class="flex items-center justify-between gap-3">
			<h3 class="text-small text-fg-2 uppercase">
				{m.local_yourServers()}
			</h3>
			<button type="button" onclick={refreshStatuses} disabled={refreshing} class={rowButtonClass}>
				<RiRefreshLine class="size-3.5 flex-none {refreshing ? 'animate-spin' : ''}" />
				<span>{refreshing ? m.local_refreshing() : m.local_refresh()}</span>
			</button>
		</div>
		<div class={cardClass}>
			{#if !ready}
				<div class="flex flex-col gap-3 px-3 py-3" aria-hidden="true">
					{#each Array.from({ length: 2 }) as _, i (i)}
						<div class="flex items-center gap-3">
							<div class="h-3 w-32 animate-pulse bg-line-2/40"></div>
							<div class="h-3 w-48 animate-pulse bg-line-2/40"></div>
						</div>
					{/each}
				</div>
			{:else if servers.length === 0}
				<p class="px-3 py-3 text-small text-fg-3">
					{m.local_none()}
				</p>
			{:else}
				{#each servers as server (server.id)}
					{@const rowError = serverError[server.id]}
					<div
						class="flex items-center justify-between gap-3 border-b border-line-1 px-3 py-3 last:border-b-0"
					>
						<div class="min-w-0">
							<div class="flex items-center gap-2">
								{#if rowError}
									<span class="flex-none" role="img" aria-label={rowError} title={rowError}>
										<RiErrorWarningFill class="size-3.5 text-caution-text" aria-hidden="true" />
									</span>
								{:else}
									{@const online = serverStatus[server.id]}
									<span
										class="size-2 flex-none rounded-pill {online === undefined
											? 'bg-fg-3'
											: online
												? 'bg-positive'
												: 'bg-accent-2'}"
										aria-label={online === undefined ? m.local_checking() : online ? m.local_online() : m.local_offline()}
										title={online === undefined ? m.local_checking() : online ? m.local_online() : m.local_offline()}
									></span>
								{/if}
								<div class="truncate text-body">{server.label}</div>
							</div>
							<div
								class="truncate font-mono text-micro text-fg-3"
							>
								{server.kind === "managed" ? m.local_managedKind() : server.baseUrl}
							</div>
						</div>
						<button
							type="button"
							class={rowButtonClass}
							disabled={!!busy}
							onclick={() => removeServer(server)}
							aria-label={m.local_removeServer({ name: server.label })}
						>
							<RiDeleteBinLine class="size-3.5" />
							<span>{busy === `remove:${server.id}` ? m.account_removing() : m.account_remove()}</span>
						</button>
					</div>
				{/each}
			{/if}
		</div>
	</section>
</div>
