<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { base } from '$lib/chat/paths';
	import { Badge, Dialog, Input, Toggle, ToggleGroup } from '@aipotluck/alpha-ds';

	/**
	 * Dev servers only (account menu → Feature flags). Lists every registered flag with a fuzzy filter
	 * and forces any of them on or off for this browser through the `fuzz_override` cookie (CUR-1044).
	 * "Default" drops the override, so the flag answers as PostHog says. The server only honours the
	 * cookie with FUZZ_OVERRIDE_ENABLED set (`pnpm dev:local` sets it); the dialog says when it isn't.
	 */
	let { open = $bindable(false) }: { open?: boolean } = $props();

	type Flag = { key: string; class: string; gates: string; ticket?: string; on: boolean };
	type Override = 'default' | 'on' | 'off';

	const COOKIE = 'fuzz_override';

	let flags = $state<Flag[]>([]);
	let overridesActive = $state(true);
	let failed = $state(false);
	let query = $state('');
	let overrides = $state<Record<string, boolean>>({});

	function readCookie(): Record<string, boolean> {
		const raw = document.cookie
			.split('; ')
			.find((c) => c.startsWith(`${COOKIE}=`))
			?.slice(COOKIE.length + 1);
		const out: Record<string, boolean> = {};
		for (const pair of decodeURIComponent(raw ?? '').split(',')) {
			const [k, v] = pair.split(':');
			if (k?.trim()) out[k.trim()] = v?.trim() === 'true';
		}
		return out;
	}

	function writeCookie(next: Record<string, boolean>) {
		const value = Object.entries(next)
			.map(([k, v]) => `${k}:${v}`)
			.join(',');
		document.cookie = value
			? `${COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`
			: `${COOKIE}=; path=/; max-age=0`;
	}

	async function load() {
		try {
			const res = await fetch(`${base}/api/dev/flags`);
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { overridesActive: boolean; flags: Flag[] };
			flags = body.flags;
			overridesActive = body.overridesActive;
			failed = false;
		} catch {
			failed = true;
		}
	}

	$effect(() => {
		if (!open) return;
		overrides = readCookie();
		void load();
	});

	async function set(key: string, choice: Override) {
		const next = { ...overrides };
		if (choice === 'default') delete next[key];
		else next[key] = choice === 'on';
		overrides = next;
		writeCookie(next);
		await load();
		await invalidateAll();
	}

	// Subsequence match ("atrt" finds auto-routing), ranked by how tightly the letters sit together.
	function score(text: string, q: string): number {
		let at = -1;
		let gaps = 0;
		for (const ch of q) {
			const i = text.indexOf(ch, at + 1);
			if (i < 0) return -1;
			if (at >= 0) gaps += i - at - 1;
			at = i;
		}
		return gaps;
	}

	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase().replace(/\s+/g, '');
		if (!q) return flags;
		return flags
			.map((f) => {
				const k = score(f.key.toLowerCase(), q);
				const g = score(f.gates.toLowerCase(), q);
				return { f, s: k >= 0 ? k : g >= 0 ? 1000 + g : -1 };
			})
			.filter((r) => r.s >= 0)
			.sort((a, b) => a.s - b.s)
			.map((r) => r.f);
	});

	const overrideCount = $derived(Object.keys(overrides).length);
	const stateOf = (key: string): Override => (key in overrides ? (overrides[key] ? 'on' : 'off') : 'default');
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="lg" data-dev-flags>
			<Dialog.Title>Feature flags</Dialog.Title>
			<Dialog.Description>
				Force a flag on or off in this browser only. Default follows PostHog.
				{#if overrideCount}{overrideCount} overridden.{/if}
			</Dialog.Description>
			{#if !overridesActive}
				<p class="type-caption text-fg-2" data-dev-flags-inactive>
					This server ignores overrides. Start it with <code>pnpm dev:local</code>, or set
					<code>FUZZ_OVERRIDE_ENABLED=true</code>.
				</p>
			{/if}
			<Input bind:value={query} placeholder="Filter flags" aria-label="Filter flags" autofocus />
			<div class="-mx-2 flex max-h-96 min-h-0 flex-col overflow-y-auto scroll-fade-y">
				{#if failed}
					<p class="px-2 py-4 type-body text-fg-2">Couldn’t load flags.</p>
				{:else if !shown.length}
					<p class="px-2 py-4 type-body text-fg-2">No flag matches “{query}”.</p>
				{/if}
				{#each shown as f (f.key)}
					<div class="flex items-start gap-3 px-2 py-2.5 border-b border-line-1 last:border-0" data-dev-flag={f.key}>
						<div class="flex min-w-0 flex-1 flex-col gap-0.5">
							<span class="flex items-center gap-2">
								<code class="truncate type-body text-fg-1">{f.key}</code>
								<Badge>{f.on ? 'On' : 'Off'}</Badge>
							</span>
							<span class="line-clamp-2 type-caption text-fg-3" title={f.gates}>{f.gates}</span>
						</div>
						<ToggleGroup
							value={[stateOf(f.key)]}
							onValueChange={(v) => v[0] && set(f.key, v[0] as Override)}
							aria-label={`Override ${f.key}`}
							class="shrink-0"
						>
							<Toggle value="default">Default</Toggle>
							<Toggle value="on">On</Toggle>
							<Toggle value="off">Off</Toggle>
						</ToggleGroup>
					</div>
				{/each}
			</div>
			<Dialog.Close />
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
