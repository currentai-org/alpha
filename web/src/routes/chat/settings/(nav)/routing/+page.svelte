<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { page } from "$app/state";
	import { Badge, Button, Input, Select, Switch, Textarea, Toggle, ToggleGroup } from "@aipotluck/alpha-ds";
	import OrgLogo from "$lib/chat/components/provenance/OrgLogo.svelte";
	import { catalog, orgs } from "$lib/chat/routing/catalog";
	import { SHIPPED_BENCHMARKS, benchmarkedLanguages, parseBenchmarkTable, type BenchmarkTable } from "$lib/chat/routing/benchmarks";
	import { VARIETY_TAGS } from "$lib/chat/routing/dialects";
	import { DIFFICULTY_LABEL, SKILL_LABEL, type Difficulty, type DraftAnalysis } from "$lib/chat/routing/classifier";
	import { localLanguageName } from "$lib/chat/routing/languages";
	import { getLocale } from "$lib/paraglide/runtime.js";
	import { localClassifier } from "$lib/chat/routing/localClassifier";
	import { useDraftAnalysis } from "$lib/chat/routing/draftAnalysis.svelte";
	import { mergeClef } from "$lib/chat/routing/clef";
	import { readWithClef } from "$lib/chat/routing/remoteRead";
	import { DEFAULT_ROUTING, route, type RoutingConfig } from "$lib/chat/routing/router";
	import { criteriaFor, fullShares, weightOf } from "$lib/chat/routing/criteria";
	import { activeBenchmarks, activeRoutingConfig, benchmarkOverride, routingConfigOverride } from "$lib/chat/routing/state";

	// Settings → Model routing: the routing lab. Type a message and see exactly what Auto sees —
	// the detected language and dialect, task size, skills — and how every model scores on the two
	// benchmark axes. Scores and scoring weights are editable; edits persist on this device and Auto
	// in the real composer uses them, so numbers can be tried before a benchmark run replaces
	// routing/data/benchmarks.json. Export gives that file's exact shape.

	const languageName = (tag: string) => localLanguageName(tag, getLocale());

	// `label` is the sample's stable id; `display` translates the ones that aren't a language's own name.
	const SAMPLES: { label: string; display?: () => string; text: string }[] = [
		{ label: "English · small", display: m.routing_sampleEnglishSmall, text: "hi, what's the capital of Peru?" },
		{ label: "English · large", display: m.routing_sampleEnglishLarge, text: "Can you compare the trade-offs between renting and buying a home in Zurich for a young family, step by step?" },
		{ label: "Català", text: "Què és el millor per aprendre amb els nens a casa?" },
		{ label: "Valencià", text: "Hui volem eixir amb els xiquets, què podem fer a València?" },
		{ label: "Schwiizerdütsch", text: "Grüezi mitenand, chasch mer säge wie ich am beschte zum Bahnhof chum?" },
		{ label: "Português (BR)", text: "Oi, você pode me ajudar a escolher um celular bom pra minha mãe?" },
		{ label: "Polski", text: "Czy możesz napisać krótki wiersz o Krakowie dla mojej babci?" },
		{ label: "ภาษาไทย", text: "ช่วยอธิบายวิธีทำต้มยำกุ้งแบบง่าย ๆ ให้หน่อยได้ไหม" },
		{ label: "Runasimi", text: "Allinllachu? Imaynatam kashanki, yanapawankiman kay llamkaypi?" },
		{ label: "Yorùbá", text: "Bawo ni? Se daadaa ni? Jowo ran mi lowo pelu ise yi." },
		{ label: "Kiswahili", text: "Habari yako rafiki? Naomba msaada kuhusu jinsi ya kupika chakula cha jioni kwa familia yangu." },
		{ label: "Recent news", display: m.routing_sampleNews, text: "What is the latest news on the Swiss election results today?" },
		{ label: "Code", display: m.routing_skillCode, text: "```ts\nconst xs = [1, 2, 3].map(x => x * 2);\n```\nWhy does this return undefined in my reducer?" },
	];
	const sampleLabel = (s: { label: string; display?: () => string }) => s.display?.() ?? s.label;

	let text = $state(SAMPLES[2].text);
	// With the clef-routing flag on, the lab asks Clef too, the same way the composer does.
	const clefOn = page.data.clefRoutingEnabled === true;
	const live = useDraftAnalysis(() => text, {
		delay: 250,
		remote: clefOn ? { read: readWithClef, merge: mergeClef } : undefined,
	});

	// Override the classifier, to test the router on its own.
	let langOverride = $state("detected");
	let sizeOverride = $state<string[]>(["detected"]);
	let previousModel = $state("none");
	let pretendAllServed = $state(false);

	const servedIds = $derived.by(() => {
		const registry = ((page.data.models ?? []) as { id: string }[]).map((x) => x.id);
		if (!pretendAllServed) return registry;
		return [...registry, ...catalog.filter((c) => c.status === "live" && c.gatewayId).map((c) => c.gatewayId!)];
	});

	const analysis = $derived.by((): DraftAnalysis | undefined => {
		const a = live.current;
		if (!a) return undefined;
		const size = sizeOverride[0];
		return {
			...a,
			language:
				langOverride === "detected" ? a.language : { value: langOverride, confidence: 1, alternatives: [], signal: "none" },
			difficulty: size && size !== "detected" ? { value: size as Difficulty, confidence: 1 } : a.difficulty,
			source: langOverride !== "detected" || (size && size !== "detected") ? "manual" : a.source,
		};
	});

	const choice = $derived(
		analysis
			? route(analysis, servedIds, {
					benchmarks: $activeBenchmarks,
					config: $activeRoutingConfig,
					stickTo: previousModel === "none" ? undefined : previousModel,
				})
			: undefined
	);

	const languageOptions = $derived([
		{ value: "detected", label: m.routing_asDetected() },
		...[...new Set([...benchmarkedLanguages($activeBenchmarks), ...VARIETY_TAGS, "quz", "yor", "yua", "tzh", "swh"])]
			.sort((a, b) => languageName(a).localeCompare(languageName(b), getLocale()))
			.map((tag) => ({ value: tag, label: `${languageName(tag)} · ${tag}` })),
	]);
	const previousOptions = $derived([
		{ value: "none", label: m.product_newChat() },
		...catalog.filter((c) => c.status === "live").map((c) => ({ value: c.id, label: c.name })),
	]);

	// ── Editing the table ─────────────────────────────────────────────────────────────────────
	function edit(mutate: (t: BenchmarkTable) => void) {
		const next = structuredClone($activeBenchmarks);
		mutate(next);
		benchmarkOverride.set(next);
	}
	function setIntelligence(modelId: string, raw: string) {
		const n = Number(raw);
		if (!Number.isFinite(n) || n < 0 || n > 100) return;
		edit((t) => {
			t.models[modelId] ??= { intelligence: 50, defaultSupport: 0.3, languages: {} };
			t.models[modelId].intelligence = n;
		});
	}
	function setSupport(modelId: string, tag: string, raw: string) {
		const n = Number(raw) / 100;
		if (!Number.isFinite(n) || n < 0 || n > 1) return;
		edit((t) => {
			t.models[modelId] ??= { intelligence: 50, defaultSupport: 0.3, languages: {} };
			t.models[modelId].languages[tag] = Math.round(n * 100) / 100;
		});
	}
	function setConfig(mutate: (c: RoutingConfig) => void) {
		const next = structuredClone($activeRoutingConfig);
		mutate(next);
		routingConfigOverride.set(next);
	}
	const num = (raw: string, fallback: number) => (Number.isFinite(Number(raw)) && raw !== "" ? Number(raw) : fallback);

	let importText = $state("");
	let importError = $state("");
	let copied = $state(false);
	function applyImport() {
		try {
			benchmarkOverride.set(parseBenchmarkTable(JSON.parse(importText)));
			importError = "";
			importText = "";
		} catch (e) {
			importError = e instanceof Error ? e.message : String(e);
		}
	}
	async function exportTable() {
		const json = JSON.stringify($activeBenchmarks, null, "\t");
		try {
			await navigator.clipboard.writeText(json);
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} catch {
			/* clipboard blocked — the download below still works */
		}
		const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
		const a = Object.assign(document.createElement("a"), { href: url, download: "benchmarks.json" });
		a.click();
		URL.revokeObjectURL(url);
	}

	// ── Every sample at once ──────────────────────────────────────────────────────────────────
	let batch = $state<{ label: string; analysis: DraftAnalysis }[]>([]);
	$effect(() => {
		let cancelled = false;
		Promise.all(SAMPLES.map(async (s) => ({ label: sampleLabel(s), analysis: await localClassifier(s.text) }))).then((r) => {
			if (!cancelled) batch = r;
		});
		return () => {
			cancelled = true;
		};
	});

	const STATUS = $derived({ live: m.routing_notServedHere(), "in-progress": m.routing_inProgress(), stub: m.settings_comingSoon() });
	const pct = (n: number) => Math.round(n * 100);
	const cellInput = "w-16 text-right tabular-nums";

	// What Auto weighs (criteria.ts): language and intelligence, plus a criterion per skill the table scores.
	const criteria = $derived(criteriaFor($activeBenchmarks));
	const weightShares = $derived(fullShares(criteria, $activeRoutingConfig.weights));
	const draftShares = $derived(
		choice
			? criteria
					.filter((c) => (choice.shares[c.id] ?? 0) > 0)
					.map((c) => `${c.label.toLowerCase()} ${pct(choice.shares[c.id] ?? 0)}%`)
					.join(", ")
			: ""
	);
	const tableStatus = $derived($benchmarkOverride ? m.routing_editedOnDevice() : SHIPPED_BENCHMARKS.status === "placeholder" ? m.routing_placeholder() : m.routing_measured());
</script>

<div class="flex flex-col gap-8" data-routing-lab>
	<p class="type-body text-fg-2">
		{m.routing_intro()}
		{clefOn ? m.routing_introClef() : m.routing_introLocal()}
		{SHIPPED_BENCHMARKS.status === "placeholder" ? m.routing_introEstimates() : m.routing_introMeasured()}
	</p>

	<!-- ── Try a message ── -->
	<section class="flex flex-col gap-3" aria-labelledby="try-heading">
		<h2 id="try-heading" class="type-label text-fg-1">{m.routing_tryTitle()}</h2>
		<div class="flex flex-wrap gap-1.5" role="group" aria-label={m.routing_samples()}>
			{#each SAMPLES as s (s.label)}
				<Button size="xs" casing="sentence" variant={text === s.text ? "primary" : "secondary"} onclick={() => (text = s.text)}>
					{sampleLabel(s)}
				</Button>
			{/each}
		</div>
		<Textarea bind:value={text} rows={3} aria-label={m.routing_messageToClassify()} data-routing-lab-input />

		{#if analysis}
			<div class="grid grid-cols-1 gap-3 border border-line-2 p-4 rounded-card sm:grid-cols-3" aria-live="polite" data-routing-lab-detected>
				<div class="flex flex-col gap-1">
					<span class="type-label text-fg-3">{m.product_language()}</span>
					<span class="type-body text-fg-1">{languageName(analysis.language.value)}</span>
					<span class="type-caption text-fg-3">
						{analysis.language.value} · {pct(analysis.language.confidence)}% · {analysis.language.signal}
					</span>
					{#if analysis.language.alternatives.length}
						<span class="type-caption text-fg-3">
							{m.routing_also()} {analysis.language.alternatives.map((a) => `${languageName(a.value)} ${pct(a.confidence)}%`).join(", ")}
						</span>
					{/if}
				</div>
				<div class="flex flex-col gap-1">
					<span class="type-label text-fg-3">{m.routing_taskSize()}</span>
					<span class="type-body text-fg-1">{analysis.difficulty.value} · {DIFFICULTY_LABEL[analysis.difficulty.value]}</span>
					<span class="type-caption text-fg-3">{m.routing_percentSure({ percent: pct(analysis.difficulty.confidence) })}</span>
				</div>
				<div class="flex flex-col gap-1">
					<span class="type-label text-fg-3">{m.routing_skills()}</span>
					{#if analysis.skills.length}
						<span class="flex flex-wrap gap-1">
							{#each analysis.skills as s (s.id)}<Badge title={s.reason}>{SKILL_LABEL[s.id]}</Badge>{/each}
						</span>
					{:else}
						<span class="type-caption text-fg-3">{m.routing_noneNeeded()}</span>
					{/if}
					<span class="type-caption text-fg-3">
						{analysis.classifier ?? analysis.source}{live.current?.elapsedMs !== undefined ? ` · ${live.current.elapsedMs} ms` : ""}{live.pending
							? ` · ${m.routing_updating()}`
							: ""}{live.refining ? ` · ${m.routing_clefReading()}` : ""}{clefOn ? ` · ${m.routing_sentToClef({ count: live.remoteSent })}` : ""}
					</span>
				</div>
			</div>
		{:else}
			<p class="type-caption text-fg-3">{m.routing_typeThree()}</p>
		{/if}

		<div class="flex flex-wrap items-end gap-4">
			<label class="flex flex-col gap-1">
				<span class="type-label text-fg-3">{m.product_language()}</span>
				<Select.Root bind:value={langOverride} items={languageOptions}>
					<Select.Trigger class="min-w-52"><Select.Value /><Select.Icon /></Select.Trigger>
					<Select.Portal>
						<Select.Positioner>
							<Select.Popup class="max-h-80">
								{#each languageOptions as o (o.value)}<Select.Item value={o.value} label={o.label}>{o.label}</Select.Item>{/each}
							</Select.Popup>
						</Select.Positioner>
					</Select.Portal>
				</Select.Root>
			</label>
			<div class="flex flex-col gap-1">
				<span class="type-label text-fg-3">{m.routing_taskSize()}</span>
				<ToggleGroup bind:value={sizeOverride} aria-label={m.routing_taskSize()}>
					<Toggle value="detected">{m.routing_detected()}</Toggle>
					<Toggle value="S">S</Toggle>
					<Toggle value="M">M</Toggle>
					<Toggle value="L">L</Toggle>
				</ToggleGroup>
			</div>
			<label class="flex flex-col gap-1">
				<span class="type-label text-fg-3">{m.routing_previousModel()}</span>
				<Select.Root bind:value={previousModel} items={previousOptions}>
					<Select.Trigger class="min-w-44"><Select.Value /><Select.Icon /></Select.Trigger>
					<Select.Portal>
						<Select.Positioner>
							<Select.Popup>
								{#each previousOptions as o (o.value)}<Select.Item value={o.value} label={o.label}>{o.label}</Select.Item>{/each}
							</Select.Popup>
						</Select.Positioner>
					</Select.Portal>
				</Select.Root>
			</label>
			<label class="flex items-center gap-2 pb-1.5 type-caption text-fg-2">
				<Switch.Root bind:checked={pretendAllServed} aria-label={m.routing_treatAllServed()}><Switch.Thumb /></Switch.Root>
				{m.routing_treatAllServed()}
			</label>
		</div>
	</section>

	<!-- ── Scores ── -->
	{#if choice && analysis}
		<section class="flex flex-col gap-3" aria-labelledby="scores-heading">
			<div class="flex flex-col gap-1">
				<h2 id="scores-heading" class="type-label text-fg-1">{m.routing_scoresTitle()}</h2>
				<p class="type-caption text-fg-2">
					Picked: <span class="text-fg-1">{choice.model.name}</span>. Needs reasoning ≈ {choice.target}. For this
					message: <span data-routing-lab-shares>{draftShares}</span>.
					{#if choice.gap}
						<span class="text-caution-text" data-routing-lab-gap>
							Language gap: best available support {pct(choice.gap.bestAvailable)}% — the dataset call-to-action shows.
						</span>
					{/if}
					{#if choice.keptForContinuity}<span class="text-fg-1">{m.routing_keptNote()}</span>{/if}
				</p>
				<p class="type-caption text-fg-3">{choice.explanation}</p>
			</div>
			<div class="overflow-x-auto border border-line-2 rounded-card scroll-fade-x">
				<table class="w-full min-w-160 type-caption" data-routing-lab-scores>
					<thead class="text-left text-fg-3">
						<tr class="border-b border-line-2">
							<th class="p-2 font-normal">{m.product_model()}</th>
							<th class="p-2 text-right font-normal">{languageName(analysis.language.value)} %</th>
							<th class="p-2 text-right font-normal">{m.routing_criterionIntelligence()}</th>
							<th class="p-2 text-right font-normal">{m.routing_fit()}</th>
							<th class="p-2 text-right font-normal">{m.routing_total()}</th>
						</tr>
					</thead>
					<tbody>
						{#each choice.scores as s (s.model.id)}
							<tr class="border-b border-line-1 last:border-0" class:bg-tint-subtle={s.model.id === choice.model.id} data-model-row={s.model.id}>
								<td class="p-2">
									<span class="flex items-center gap-2">
										<OrgLogo org={orgs[s.model.maker]} size="sm" />
										<span class="flex min-w-0 flex-col">
											<span class="text-fg-1">{s.model.name}{s.model.id === choice.model.id ? ` · ${m.routing_picked()}` : ""}</span>
											<span class="text-fg-3">{s.available ? (s.benchmarked ? m.routing_available() : m.routing_pickByHand()) : STATUS[s.model.status]}</span>
										</span>
									</span>
								</td>
								<td class="p-2 text-right">
									{#if analysis.language.value === "und"}
										<span class="text-fg-3">—</span>
									{:else if s.languageVia === "measured" || s.languageVia === "neutral" || s.measured}
										<!-- Measured scores (and the median that stands in for an unmeasured model) come from
										     language-scores.json, not this table, so they aren't editable here. -->
										<span class="tabular-nums" data-routing-measured>{pct(s.language)}</span>
									{:else}
										<Input
											size="sm"
											type="number"
											min="0"
											max="100"
											class={cellInput}
											value={pct(s.language)}
											aria-label={m.routing_supportFor({ model: s.model.name, language: languageName(analysis.language.value) })}
											onchange={(e) => setSupport(s.model.id, analysis.language.value, e.currentTarget.value)}
										/>
									{/if}
								</td>
								<td class="p-2 text-right">
									<Input
										size="sm"
										type="number"
										min="0"
										max="100"
										class={cellInput}
										value={s.intelligence}
										aria-label={m.routing_reasoningScore({ model: s.model.name })}
										onchange={(e) => setIntelligence(s.model.id, e.currentTarget.value)}
									/>
								</td>
								<td class="p-2 text-right tabular-nums text-fg-2">{pct(s.intelligenceFit)}%</td>
								<td class="p-2 text-right tabular-nums text-fg-1">
									{s.total.toFixed(2)}{#if s.continuity}<span class="block text-fg-3">{m.routing_continuityBonus({ value: s.continuity })}</span>{/if}{#if s.capacity}<span class="block text-fg-3">{m.routing_capacityCost({ value: s.capacity })}</span>{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- ── All samples ── -->
	<section class="flex flex-col gap-3" aria-labelledby="batch-heading">
		<div class="flex flex-col gap-1">
			<h2 id="batch-heading" class="type-label text-fg-1">{m.routing_batchTitle()}</h2>
			<p class="type-caption text-fg-2">{m.routing_batchHelp()}</p>
		</div>
		<div class="overflow-x-auto border border-line-2 rounded-card scroll-fade-x">
			<table class="w-full min-w-144 type-caption" data-routing-lab-batch>
				<thead class="text-left text-fg-3">
					<tr class="border-b border-line-2">
						<th class="p-2 font-normal">{m.routing_sample()}</th>
						<th class="p-2 font-normal">{m.routing_detected()}</th>
						<th class="p-2 font-normal">{m.routing_size()}</th>
						<th class="p-2 font-normal">{m.routing_picks()}</th>
						<th class="p-2 font-normal">{m.routing_gapColumn()}</th>
					</tr>
				</thead>
				<tbody>
					{#each batch as row (row.label)}
						{@const r = route(row.analysis, servedIds, { benchmarks: $activeBenchmarks, config: $activeRoutingConfig })}
						<tr class="border-b border-line-1 last:border-0">
							<td class="p-2 text-fg-1">{row.label}</td>
							<td class="p-2 text-fg-2">{languageName(row.analysis.language.value)} <span class="text-fg-3">{pct(row.analysis.language.confidence)}%</span></td>
							<td class="p-2 text-fg-2">{row.analysis.difficulty.value}</td>
							<td class="p-2 text-fg-1">{r?.model.name ?? "—"}</td>
							<td class="p-2">{#if r?.gap}<Badge tone="caution">{m.routing_datasetCta()}</Badge>{/if}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<!-- ── Data ── -->
	<section class="flex flex-col gap-4 border border-line-2 p-4 rounded-card" aria-labelledby="data-heading">
		<div class="flex flex-col gap-1">
			<div class="flex items-center gap-2">
				<h2 id="data-heading" class="type-label text-fg-1">{m.routing_dataTitle()}</h2>
				<Badge tone={$benchmarkOverride ? "caution" : "outline"}>{tableStatus}</Badge>
			</div>
			<p class="type-caption text-fg-2">{$activeBenchmarks.source ?? ""}{$activeBenchmarks.updated ? ` ${m.routing_updated({ date: $activeBenchmarks.updated })}` : ""}</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button size="sm" casing="sentence" onclick={exportTable}>{copied ? m.routing_copiedDownloaded() : m.routing_exportJson()}</Button>
			<Button size="sm" casing="sentence" disabled={!$benchmarkOverride} onclick={() => benchmarkOverride.set(null)}>
				{m.routing_resetScores()}
			</Button>
		</div>
		<div class="flex flex-col gap-2">
			<Textarea bind:value={importText} rows={3} placeholder={m.routing_pastePlaceholder()} aria-label={m.routing_importAria()} />
			{#if importError}<p class="type-caption text-accent-2-text" role="alert">{importError}</p>{/if}
			<div><Button size="sm" casing="sentence" disabled={!importText.trim()} onclick={applyImport}>{m.routing_usePasted()}</Button></div>
		</div>

		<div class="flex flex-col gap-2 border-t border-line-1 pt-4">
			<div class="flex items-center gap-2">
				<h3 class="type-label text-fg-1">{m.routing_scoring()}</h3>
				{#if $routingConfigOverride}<Badge tone="caution">{m.routing_edited()}</Badge>{/if}
			</div>
			<div class="flex flex-col gap-2" data-routing-lab-weights>
				<p class="type-caption text-fg-2">
					{m.routing_weightsHelp()}
					(<code>"skills": &#123; "code": 0.8 &#125;</code>)
				</p>
				<div class="flex flex-wrap gap-4">
					{#each criteria as c (c.id)}
						<label class="flex flex-col gap-1 type-caption text-fg-2" title={c.description}>
							{c.label}
							<span class="flex items-center gap-2">
								<Input
									size="sm"
									type="number"
									min="0"
									max="100"
									step="0.5"
									class={cellInput}
									value={weightOf($activeRoutingConfig.weights, c.id)}
									onchange={(e) =>
										setConfig((cfg) => (cfg.weights = { ...cfg.weights, [c.id]: Math.max(0, num(e.currentTarget.value, weightOf(DEFAULT_ROUTING.weights, c.id))) }))}
								/>
								<span class="tabular-nums text-fg-3" data-routing-weight-share={c.id}>{pct(weightShares[c.id] ?? 0)}%</span>
							</span>
						</label>
					{/each}
				</div>
			</div>
			<div class="flex flex-wrap gap-4">
				{#each ["S", "M", "L"] as const as size (size)}
					<label class="flex flex-col gap-1 type-caption text-fg-2">
						{m.routing_intelligenceFloor({ size })}
						<Input size="sm" type="number" min="0" max="100" class={cellInput} value={$activeRoutingConfig.target[size]}
							onchange={(e) => setConfig((c) => (c.target[size] = num(e.currentTarget.value, DEFAULT_ROUTING.target[size])))} />
					</label>
				{/each}
				<label class="flex flex-col gap-1 type-caption text-fg-2">
					{m.routing_weakSupport()}
					<Input size="sm" type="number" min="0" max="100" class={cellInput} value={pct($activeRoutingConfig.weakSupport)}
						onchange={(e) => setConfig((c) => (c.weakSupport = num(e.currentTarget.value, 50) / 100))} />
				</label>
				<label class="flex flex-col gap-1 type-caption text-fg-2">
					{m.routing_continuity()}
					<Input size="sm" type="number" min="0" max="1" step="0.01" class={cellInput} value={$activeRoutingConfig.continuity}
						onchange={(e) => setConfig((c) => (c.continuity = num(e.currentTarget.value, DEFAULT_ROUTING.continuity)))} />
				</label>
				<label class="flex flex-col gap-1 type-caption text-fg-2">
					{m.routing_capacity()}
					<Input size="sm" type="number" min="0" max="1" step="0.01" class={cellInput} value={$activeRoutingConfig.capacityCost}
						onchange={(e) => setConfig((c) => (c.capacityCost = num(e.currentTarget.value, DEFAULT_ROUTING.capacityCost)))} />
				</label>
			</div>
			<div>
				<Button size="sm" casing="sentence" disabled={!$routingConfigOverride} onclick={() => routingConfigOverride.set(null)}>
					{m.routing_resetScoring()}
				</Button>
			</div>
		</div>
	</section>
</div>
