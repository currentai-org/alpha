<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { replaceState } from "$app/navigation";
	import { base } from "$lib/chat/paths";
	import {
		baselineRun,
		changesSince,
		journeyGroup,
		journeyGroups,
		PM_FILED,
		runVerdict,
		sortFailuresFirst,
		badgeLabel,
		findingCounts,
		NEXT_STEP,
		recordingStatusLabel,
		SEVERITY_LABEL,
		splitRecordingsByOutcome,
		unseenSteps,
		splitUnjudgedByDoc,
		STATE_LABEL,
		UNJUDGED,
		viewportNote,
		type JourneyCard,
		type JourneyState,
	} from "$lib/chat/server/journeyGallery";
	import type { PageData } from "./$types";
	import StaffSignIn from "$lib/chat/components/StaffSignIn.svelte";

	let { data }: { data: PageData } = $props();

	const manifest = $derived(data.manifest);

	// Colour alone would not carry this. The palette (src/lib/chat/design-system.md) has no
	// green, and the distinction that matters here is not good-versus-bad — it is "this journey was
	// judged" against "nobody watched this journey", which a reader has to catch at a glance and
	// which no hue in the set says on its own.
	//
	// So the states differ in STRUCTURE first: a judged journey's badge is solid-bordered and full
	// white; an unjudged one is dashed and dimmed to Text 3, visibly hollow. That difference survives
	// greyscale, a bad monitor and a quick skim, which is what this page is read on.
	const TONE: Record<JourneyState, string> = {
		clean: "border-solid border-line-3 bg-surface-3 text-fg-1",
		findings: "border-solid border-accent-2-text text-accent-2-text",
		partial: "border-solid border-caution-text text-caution-text",
		// solid, not dashed — this journey WAS judged, real evidence exists. It shares
		// `partial`'s hue rather than getting a fourth accent: both mean "the evidence is real but
		// weaker than a clean pass," just for different reasons (incomplete coverage vs. a retry). (CUR-1613)
		flaky: "border-solid border-caution-text text-caution-text",
		// graded, so solid; gray, because nothing has shown its checks can go red yet. (CUR-1614)
		unproven: "border-solid border-line-1 text-fg-3",
		"not-run": "border-dashed border-line-1 text-fg-3",
		"not-graded": "border-dashed border-line-1 text-fg-3",
		"not-covered": "border-dashed border-line-1 text-fg-3",
	};

	// The same distinction as TONE, moved to the card's left edge so it can be read
	// peripherally. A reader scanning six cards should not have to stop at each badge to learn which
	// ones want them; the stripe is the only thing on the card visible without focusing on it.
	//
	// Structure before hue, for the reason TONE gives above: judged states get a solid edge, unjudged
	// a dashed one, so the split survives greyscale and a skim. Hue then separates within each group. (CUR-1568)
	const EDGE: Record<JourneyState, string> = {
		clean: "border-l-4 border-l-[var(--ds-line-3)]",
		findings: "border-l-4 border-l-[var(--ds-accent-2-text)]",
		partial: "border-l-4 border-l-[var(--ds-caution-text)]",
		flaky: "border-l-4 border-l-[var(--ds-caution-text)]",
		unproven: "border-l-4 border-l-[var(--ds-line-1)]",
		"not-run": "border-l-4 border-l-[var(--ds-line-1)] border-dashed",
		"not-graded": "border-l-4 border-l-[var(--ds-line-1)] border-dashed",
		"not-covered": "border-l-4 border-l-[var(--ds-line-1)] border-dashed",
	};

	const CONCLUSION_TONE: Record<string, string> = {
		product: "border-accent-2-text text-accent-2-text",
		doc: "border-caution-text text-caution-text",
		// A step a passing test claims and no frame shows is drawn as loudly as a product
		// finding. The dashed edge keeps it distinguishable from one without relying on hue. (CUR-2245)
		unseen: "border-dashed border-accent-2-text text-accent-2-text",
		// The claimed test did not run, so nothing was watched. Quiet, like inconclusive, and dashed. (SOL-110)
		"not-run": "border-dashed border-line-2 text-fg-3",
		inconclusive: "border-line-2 text-fg-3",
	};

	// The word on the badge. `unseen` is the manifest's field value and means nothing to a reader.
	const CONCLUSION_LABEL: Record<string, string> = { unseen: "claimed, not seen", "not-run": "test did not run" };

	// The product critique's own scale (CUR-1526). Same reasoning as TONE above: severity is carried
	// by structure before hue, because the palette has three usable accents and this scale has three
	// levels that a reader must not have to memorise a colour key for. The word is always present.
	const SEVERITY_TONE: Record<string, string> = {
		blocking: "border-accent-2-text text-accent-2-text",
		annoying: "border-caution-text text-caution-text",
		minor: "border-dashed border-line-2 text-fg-3",
	};

	/** "18 September 19:42 UTC" — a run's date written the way it gets quoted into a ticket. */
	function stamp(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return (
			`${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} ` +
			`${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`
		);
	}

	const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : "unknown");
	const secs = (ms: number | null) => (ms == null ? "" : `${(ms / 1000).toFixed(1)}s`);
	const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

	// The same journey is now walked on more than one viewport, so two recordings of one
	// test sit side by side and differ in nothing else a reader can see. Playwright's project names
	// are the source of truth; these are the two that exist today, and anything else falls through
	// to its own name rather than being guessed at or hidden. (CUR-1550)
	const VIEWPORT_LABEL: Record<string, string> = {
		chromium: "desktop",
		"mobile-chromium": "mobile",
	};
	const viewportLabel = (project: string) => VIEWPORT_LABEL[project] ?? project;

	const runViewportNote = $derived(viewportNote(manifest?.run?.viewports));

	const videoHref = (file: string) =>
		`${base}/admin/journeys/video/${file.split("/").slice(1).map(encodeURIComponent).join("/")}`;

	const counts = $derived.by(() => {
		const out: Partial<Record<JourneyState, number>> = {};
		for (const j of manifest?.journeys ?? []) out[j.state] = (out[j.state] ?? 0) + 1;
		return out;
	});

	// The one sentence a reader actually wants first, which the count pills cannot give them: not how
	// many are in each state, but WHICH ones to open. Names them, because "2 need attention" still
	// leaves the reader to find the two.
	const needAttention = $derived(
		(manifest?.journeys ?? []).filter(
			(j: JourneyCard) => j.state === "findings" || j.state === "partial" || j.state === "flaky"
		)
	);

	// The journeys a visitor would hit something on come first and by themselves, so "asking
	// for a look" does not put a broken step and an out-of-date doc in one breath.
	const brokenForVisitor = $derived(needAttention.filter((j: JourneyCard) => findingCounts(j).broken > 0));
	const lookNotBroken = $derived(needAttention.filter((j: JourneyCard) => !brokenForVisitor.includes(j)));

	const unjudged = $derived((manifest?.journeys ?? []).filter((j: JourneyCard) => UNJUDGED.includes(j.state)));

	// The sentence below `unjudged` must not name all of these in one voice — "a
	// gap in the run" — when most of them have no journey doc at all and can never be closed by
	// more coverage. The split lives in journeyGallery.ts so it can be specced; see its own comment
	// for why it keys on `doc`, not on `state === "not-covered"`.
	const unjudgedByDoc = $derived(splitUnjudgedByDoc(manifest?.journeys ?? []));

	// A journey can grade `clean` on its doc while one of its own recordings failed at the Playwright
	// level: the grader watches frames and reasons about the step table, it does not read meta.json's
	// status field, so `needAttention` above (which filters on journey STATE) cannot see this
	// (CUR-1759). So recordings are counted straight off the recordings, independent of what state
	// their journey landed in.
	//
	// The split lives in journeyGallery.ts so it can be specced: reading `!== "passed"` as "failed"
	// announces SKIPPED recordings as failures (CUR-1816). See that function's own comment for why the
	// two must stay apart.
	const recordingsByOutcome = $derived(splitRecordingsByOutcome(manifest?.journeys ?? []));
	const failedRecordings = $derived(recordingsByOutcome.failed);
	const unseen = $derived(unseenSteps(manifest?.journeys ?? []));
	const skippedRecordings = $derived(recordingsByOutcome.skipped);
	const expectedRecordings = $derived(recordingsByOutcome.expected);

	// The manifest's own sha against the commit this page was built from. The preview is built from
	// the branch tip, so a mismatch means the published run predates what the reader is looking at — worth
	// saying out loud rather than leaving them to assume the two match.
	const stale = $derived(
		manifest && data.buildSha && manifest.run.sha !== data.buildSha && manifest.run.sha !== "unknown"
	);

	// One journey on screen at a time, picked from the rail. The filters are the same three
	// groups the summary above already names, so a reader can go from "A1, C2 are asking for a look"
	// to walking exactly those. (CUR-2326)
	type FilterKey = "all" | "changed" | "attention" | "unmeasured" | "clean";

	// What changed since an earlier graded run. The manifest keeps a month of verdict
	// summaries (`history`, newest first, this run included); the reader picks the previous graded run
	// or the run a week ago, and the "Changed" filter narrows the rail to journeys whose verdict moved. (CUR-2548)
	let sinceDays = $state<number | null>(null);
	const baseline = $derived(baselineRun(manifest?.history, sinceDays));
	const changes = $derived<Record<string, string[]>>(
		baseline && manifest?.history?.[0] ? changesSince(manifest.history[0], baseline) : {}
	);
	// Two runs on different profiles or models are two different results (CUR-2285), so the comparison
	// says so rather than reading a model swap as a product change.
	const baselineCaveat = $derived(
		baseline && manifest?.history?.[0] &&
			(baseline.profile !== manifest.history[0].profile || baseline.model !== manifest.history[0].model)
			? ` That run was on profile ${baseline.profile}${baseline.model ? ` (${baseline.model})` : ""}, this one on ${manifest.history[0].profile}${manifest.history[0].model ? ` (${manifest.history[0].model})` : ""}, so some changes may be the model's.`
			: ""
	);
	const FILTERS: { key: FilterKey; label: string; test: (j: JourneyCard) => boolean }[] = [
		{ key: "all", label: "All", test: () => true },
		{ key: "changed", label: "Changed", test: (j) => Boolean(changes[j.journey]) },
		{
			key: "attention",
			label: "Asking for a look",
			test: (j) => j.state === "findings" || j.state === "partial" || j.state === "flaky",
		},
		{ key: "unmeasured", label: "Unmeasured", test: (j) => UNJUDGED.includes(j.state) },
		{ key: "clean", label: "Clean", test: (j) => j.state === "clean" },
	];

	let filter = $state<FilterKey>("all");
	let selectedId = $state<string | null>(null);
	// null until the reader picks a tab, so a journey opens on the recording that failed rather than
	// on whichever one happens to be first: F3 carries ten, and the failing one is seventh.
	let recChoice = $state<number | null>(null);
	let showKeys = $state(false);

	// Failures first, so the rail opens on what a reader came to look at, and narrowed by the
	// project letter (A, C, F...) as well as by state. (CUR-3076)
	let group = $state<string | null>(null);
	const ordered = $derived(sortFailuresFirst(manifest?.journeys ?? []));
	const groups = $derived(journeyGroups(manifest?.journeys ?? []));
	const verdict = $derived(runVerdict(manifest?.journeys ?? []));
	const VERDICT_TONE = {
		attention: "border-accent-2-text text-accent-2-text",
		unmeasured: "border-dashed border-caution-text text-caution-text",
		clean: "border-line-3 text-fg-1",
	} as const;
	const inGroup = (j: JourneyCard) => group == null || journeyGroup(j.journey) === group;
	const visible = $derived(
		ordered.filter(FILTERS.find((f) => f.key === filter)?.test ?? (() => true)).filter(inGroup)
	);
	// The header's changed-since line always compares with the previous graded run, whatever the
	// Changed filter's own picker is set to.
	const lastRun = $derived(baselineRun(manifest?.history, null));
	const changedSinceLast = $derived(
		lastRun && manifest?.history?.[0] ? Object.keys(changesSince(manifest.history[0], lastRun)) : []
	);
	// Falls back to the first journey asking for a look, since that is the one a reader opened the
	// page to see, and then to the first journey at all.
	const selected = $derived(
		visible.find((j: JourneyCard) => j.journey === selectedId) ??
			visible.find((j: JourneyCard) => needAttention.includes(j)) ??
			visible[0] ??
			null
	);
	const recIndex = $derived.by(() => {
		if (recChoice != null) return recChoice;
		const failed = (selected?.recordings ?? []).findIndex(
			(r) => r.status !== "passed" && r.status !== "skipped" && !r.expectedFailure
		);
		return Math.max(0, failed);
	});
	// The capped tab strip can hide the chosen tab below its fold, which reads as nothing selected.
	$effect(() => {
		void recIndex;
		void selected;
		queueMicrotask(() =>
			document
				.querySelector('[role="tablist"] [role="tab"][aria-selected="true"]')
				?.scrollIntoView({ block: "nearest", inline: "nearest" })
		);
	});

	function select(id: string) {
		selectedId = id;
		recChoice = null;
		// A link to one journey is what a ticket or a chat message wants to carry, so the address
		// follows the selection. replaceState, not a navigation: walking twenty journeys should not
		// leave twenty entries in the back button.
		// The page takes no other query parameter, so the address is rebuilt rather than edited.
		replaceState(`${page.url.pathname}?journey=${encodeURIComponent(id)}`, page.state);
		document
			.querySelector(`[data-testid="journey-rail"] [data-journey="${CSS.escape(id)}"]`)
			?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	function setGroup(g: string | null) {
		group = g;
		const first = visible[0];
		if (first && !visible.some((j: JourneyCard) => j.journey === selectedId)) select(first.journey);
	}

	function setFilter(key: FilterKey) {
		filter = key;
		const first = visible[0];
		if (first && !visible.some((j: JourneyCard) => j.journey === selectedId)) select(first.journey);
	}

	function step(delta: number) {
		if (visible.length === 0) return;
		const at = selected ? visible.indexOf(selected) : -1;
		const next = visible[Math.min(visible.length - 1, Math.max(0, at + delta))];
		if (next) select(next.journey);
	}

	// `?journey=A1` from a shared link, or `#A1` from a ticket filed before this layout (CUR-2023).
	onMount(() => {
		const wanted = page.url.searchParams.get("journey") ?? decodeURIComponent(page.url.hash.slice(1));
		if (wanted && manifest?.journeys.some((j: JourneyCard) => j.journey === wanted)) selectedId = wanted;
	});

	let videoEl = $state<HTMLVideoElement | null>(null);

	function onKey(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		if (!manifest) return;
		const recs = selected?.recordings.length ?? 0;
		switch (e.key) {
			case "j":
				step(1);
				break;
			case "k":
				step(-1);
				break;
			case "]":
				if (recs > 1) recChoice = (recIndex + 1) % recs;
				break;
			case "[":
				if (recs > 1) recChoice = (recIndex - 1 + recs) % recs;
				break;
			case "?":
				showKeys = !showKeys;
				break;
			case "Escape":
				showKeys = false;
				return;
			case " ":
				// A focused video or button already handles space itself.
				if (!videoEl || (t && /^(VIDEO|BUTTON|A|SUMMARY)$/.test(t.tagName))) return;
				if (videoEl.paused) void videoEl.play();
				else videoEl.pause();
				break;
			default:
				return;
		}
		e.preventDefault();
	}

	const recordingTone = (r: { status: string; expectedFailure?: boolean }) =>
		r.status === "passed" || r.status === "skipped" || r.expectedFailure
			? "text-fg-2"
			: "text-accent-2-text";
</script>

<svelte:window onkeydown={onKey} />

<!-- Both finding lists — the doc grader's and the product critique's — end the same way: what was
     seen, then why it matters, then (for the critique) the smallest fix. The badges above them
     differ and the prose does not, so the prose lives here once. -->
{#snippet findingProse(observation: string, rationale: string | undefined, suggestion: string | undefined)}
	<p class="mt-1">{observation}</p>
	{#if rationale}
		<p class="mt-1 text-fg-2">{rationale}</p>
	{/if}
	{#if suggestion}
		<p class="mt-1 text-fg-2">Suggested: {suggestion}</p>
	{/if}
{/snippet}


<svelte:head><title>Journeys · admin</title></svelte:head>

<div class="mx-auto w-full max-w-[110rem] px-4 py-8 text-fg-1">
	<header class="mb-6 flex items-center justify-between gap-3">
		<h1 class="text-xl font-semibold">Journeys</h1>
	</header>

	{#if data.needsLogin}
		<StaffSignIn signedIn={data.signedIn} />
	{:else if !manifest}
		<div
			class="border border-dashed border-line-2 bg-surface-2 p-6 text-body text-fg-2"
		>
			<p class="font-medium text-fg-1">
				No run has been published to this deployment yet.
			</p>
			<p class="mt-2">
				This is an empty gallery rather than a clean one — nothing here has been measured. A run
				lands here when <code class="font-mono">journey-gallery.yml</code> finishes on a push to
				<code class="font-mono">develop</code>. To fill it by hand, point
				<code class="font-mono">node scripts/publish-journey-gallery.mjs</code> at this database.
			</p>
			<p class="mt-2">
				A finished run and an empty page together mean two different databases.
				<code class="font-mono">/chat/admin/journeys/published</code> reports the commit this
				deployment can see, which is the fastest way to tell them apart.
			</p>
		</div>
	{:else}
		<!-- The configuration, before any result. A verdict with no configuration attached answers no
		     question about readiness — which is how every by-hand run of this gets written up. -->
		<section class="mb-6 border border-line-2 bg-surface-2 p-4 text-body" data-testid="journey-run-header">
			<!-- CUR-3076: the verdict leads, the way a build review page (Chromatic, Vercel's deployment
			     list) opens on pass or fail before anything else. Words carry it; the border only repeats it. -->
			<p class="mb-3 flex flex-wrap items-center gap-2">
				<span class="border px-2 py-1 text-subhead font-medium {VERDICT_TONE[verdict.tone]}" data-testid="journey-verdict">
					{verdict.text}
				</span>
				{#each Object.entries(counts) as [state, n] (state)}
					<span class="border px-2 py-1 text-small {TONE[state as JourneyState]}">
						{n} {STATE_LABEL[state as JourneyState].toLowerCase()}
					</span>
				{/each}
			</p>
			{#if lastRun}
				<p class="mb-2 text-fg-2" data-testid="journey-changed-since-last">
					{#if changedSinceLast.length === 0}
						No verdict moved since the last graded run, <code class="font-mono">{short(lastRun.sha)}</code>.
					{:else}
						{changedSinceLast.length} journey{changedSinceLast.length === 1 ? "" : "s"} changed since the last
						graded run, <code class="font-mono">{short(lastRun.sha)}</code>: {changedSinceLast.join(", ")}.
						<button type="button" class="underline hover:text-fg-1" onclick={() => { sinceDays = null; setFilter("changed"); }}>
							Show only these
						</button>
					{/if}
				</p>
			{/if}
			<p class="font-medium">
				{manifest.run.ref} @ <code class="font-mono">{short(manifest.run.sha)}</code>,
				{stamp(manifest.run.ranAt)}, signed out, agent {manifest.run.agentMode ? "on" : "off"},
				web search {typeof manifest.run.webSearch === "string" ? manifest.run.webSearch : manifest.run.webSearch ? "on" : "off"}{#if runViewportNote}, {runViewportNote}{/if}{#if manifest.run.profile === "prod"}, prod profile: every chat on <code class="font-mono">{manifest.run.model}</code>{/if}
			</p>
			<p class="mt-1 text-fg-2">
				against
				<a class="underline" href={manifest.run.baseUrl} rel="noreferrer">{manifest.run.baseUrl}</a>
				{#if manifest.run.runUrl}
					· <a class="underline" href={manifest.run.runUrl} rel="noreferrer">
						the run that produced it
					</a>
				{/if}
			</p>
			{#if stale}
				<p class="mt-2 border border-caution-text px-2 py-1 text-caution-text">
					This page was built from <code class="font-mono">{short(data.buildSha)}</code>, so the
					gallery below is from an earlier commit than the app you are looking at.
				</p>
			{/if}
		</section>

		<section class="mb-6 space-y-2 text-body">
			<p class="font-medium">
				{#if needAttention.length === 0 && failedRecordings.length === 0 && skippedRecordings.length === 0}
					Nothing on this run is asking for a look.
				{:else}
					{#if brokenForVisitor.length > 0}
						<span data-testid="journey-broken-summary">
							Broken for a visitor: {brokenForVisitor.map((j: JourneyCard) => j.journey).join(", ")}.
						</span>
					{/if}
					{#if lookNotBroken.length > 0}
						{lookNotBroken.map((j: JourneyCard) => j.journey).join(", ")}
						{lookNotBroken.length === 1 ? "is" : "are"} asking for a look, with nothing yet seen broken.
					{/if}
					{#if failedRecordings.length > 0}
						<!-- CUR-2327: its own span so the self-check reads this sentence alone, not the
						     whole paragraph, which also holds the expected-failures list. -->
						<span data-testid="journey-failed-recordings">
							{failedRecordings.length}
							recording{failedRecordings.length === 1 ? "" : "s"} failed:
							{failedRecordings.map((r) => `${r.journey} — ${r.title}`).join(", ")}.
						</span>
					{/if}
					<!-- CUR-1816: a separate sentence in a quieter voice, because a skip is a gap in the
					     run and the page's whole job is to keep that apart from a result. Same register
					     as the unmeasured block below, deliberately. -->
					{#if skippedRecordings.length > 0}
						<span class="font-normal text-fg-2">
							{skippedRecordings.length}
							recording{skippedRecordings.length === 1 ? "" : "s"} never ran, so nothing was
							watched for {skippedRecordings.length === 1 ? "it" : "them"}:
							{skippedRecordings.map((r) => `${r.journey} — ${r.title}`).join(", ")}.
						</span>
					{/if}
				{/if}
				<!-- CUR-2234: a test.fail() spec failing as declared is the suite working, so it sits
				     outside the "asking for a look" sentence, in the same quiet voice as a skip. -->
				{#if expectedRecordings.length > 0}
					<span class="font-normal text-fg-2" data-testid="journey-expected-failures">
						{expectedRecordings.length}
						recording{expectedRecordings.length === 1 ? " is an expected failure" : "s are expected failures"},
						a spec marked to fail while a known bug is open:
						{expectedRecordings.map((r) => `${r.journey} — ${r.title}`).join(", ")}.
					</span>
				{/if}
				{#if unjudged.length > 0}
					<span class="font-normal text-fg-2">
						Separately, {unjudged.length} went unmeasured — see below.
					</span>
				{/if}
			</p>
			{#if unseen.length > 0}
				<p class="mb-2 text-accent-2-text" data-testid="journey-unseen-steps">
					{unseen.length} step{unseen.length === 1 ? " is" : "s are"} claimed by a passing test and shown in no frame:
					{unseen.map((u) => `${u.journey} step ${u.step}`).join(", ")}.
				</p>
			{/if}
		</section>

		{#if unjudged.length > 0}
			<!-- The whole point of the page. Someone deciding whether to demo A1-A4 needs "nothing was
			     found" and "nothing was watched" to be different sentences, in the same place. -->
			<div
				class="mb-6 border border-dashed border-line-2 bg-surface-2 p-4 text-body text-fg-2"
			>
				<p class="font-medium text-fg-1">
					{unjudged.length} of {manifest.journeys.length} journeys carry no verdict from this run.
				</p>
				<!-- Two sentences, not one. A journey with
				     a doc that this run didn't reach is a gap in the run, closeable by a re-run; a
				     journey with no doc at all needs a person to write it first, and no amount of
				     coverage touches that. Kept apart the way the state-count pills above already do. -->
				{#if unjudgedByDoc.ranButNoVerdict.length > 0}
					<p class="mt-1">
						{unjudgedByDoc.ranButNoVerdict.length}
						journey{unjudgedByDoc.ranButNoVerdict.length === 1 ? "" : "s"} ran and produced no verdict:
						{unjudgedByDoc.ranButNoVerdict.join(", ")} — a gap in the run, not a result about the
						product. Read {unjudgedByDoc.ranButNoVerdict.length === 1 ? "it" : "them"} as unmeasured
						rather than as passing.
					</p>
				{/if}
				{#if unjudgedByDoc.noDocYet.length > 0}
					<p class="mt-1">
						{unjudgedByDoc.noDocYet.length}
						journey{unjudgedByDoc.noDocYet.length === 1 ? "" : "s"}
						{unjudgedByDoc.noDocYet.length === 1 ? "has" : "have"} no doc yet, so nothing can grade
						{unjudgedByDoc.noDocYet.length === 1 ? "it" : "them"}:
						{unjudgedByDoc.noDocYet.join(", ")}. These need someone to write what should happen, not
						more coverage.
					</p>
				{/if}
			</div>
		{/if}

		<!-- CUR-2326: one journey at a time. A rail of every journey on the left, the selected
		     journey's recording as large as the page allows in the middle, and what was found beside
		     it on a wide screen or under it otherwise. The old layout put every journey on one long
		     page with its recordings in a two-column grid of thumbnails, which had to be fullscreened
		     one by one to see anything. The review pattern is Playwright's trace viewer and Argos's
		     journey drawer: an index, one big player, and keys to walk them. -->
		<div class="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
			<nav aria-label="Journeys" class="min-w-0 text-body">
				<div class="mb-2 flex flex-wrap gap-1" role="group" aria-label="Show">
					{#each FILTERS as f (f.key)}
						{@const n = manifest.journeys.filter(f.test).length}
						{#if f.key === "all" || f.key === "changed" || n > 0}
							<button
								type="button"
								class="border px-2 py-0.5 text-small {filter === f.key
									? 'border-line-3 bg-surface-3 text-fg-1'
									: 'border-line-1 text-fg-2 hover:text-fg-1'}"
								aria-pressed={filter === f.key}
								onclick={() => setFilter(f.key)}
							>
								{f.label} · {n}
							</button>
						{/if}
					{/each}
				</div>
				{#if groups.length > 1}
					<div class="mb-2 flex flex-wrap gap-1" role="group" aria-label="Project">
						{#each [null, ...groups] as g (g ?? "all")}
							<button
								type="button"
								class="border px-2 py-0.5 font-mono text-small {group === g
									? 'border-line-3 bg-surface-3 text-fg-1'
									: 'border-line-1 text-fg-2 hover:text-fg-1'}"
								aria-pressed={group === g}
								onclick={() => setGroup(g)}
							>
								{g ?? "All projects"}
							</button>
						{/each}
					</div>
				{/if}
				{#if filter === "changed"}
					<div class="mb-2 space-y-1 text-small text-fg-2" data-testid="journey-changed-since">
						<label class="flex items-center gap-1">
							Since
							<select
								class="border border-line-1 bg-surface-1 px-1 py-0.5 text-small text-fg-1"
								value={sinceDays ?? ""}
								onchange={(e) => {
									const v = (e.currentTarget as HTMLSelectElement).value;
									sinceDays = v === "" ? null : Number(v);
								}}
							>
								<option value="">the last graded run</option>
								<option value="7">7 days ago</option>
								<option value="14">14 days ago</option>
								<option value="30">30 days ago</option>
							</select>
						</label>
						{#if baseline}
							<p>
								Compared with <code class="font-mono">{short(baseline.sha)}</code>{baseline.ranAt
									? `, graded ${stamp(baseline.ranAt)}`
									: ""}.{baselineCaveat}
							</p>
						{:else}
							<p>Nothing earlier to compare with yet: the record of graded runs starts with this one.</p>
						{/if}
					</div>
				{/if}
				<ol
					class="flex gap-1 overflow-x-auto pb-1 lg:max-h-[calc(100vh-8rem)] lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pb-0"
					data-testid="journey-rail"
				>
					{#each visible as j (j.journey)}
						<li class="shrink-0 lg:shrink">
							<a
								href={`?journey=${encodeURIComponent(j.journey)}`}
								class="block border border-line-1 px-2 py-1.5 {EDGE[j.state]} {selected?.journey ===
								j.journey
									? 'bg-surface-3'
									: 'hover:bg-surface-2'}"
								aria-current={selected?.journey === j.journey ? "true" : undefined}
								data-journey={j.journey}
								data-state={j.state}
								onclick={(e) => {
									e.preventDefault();
									select(j.journey);
								}}
							>
								<span class="flex items-center justify-between gap-2">
									<span class="font-mono text-small">{j.journey}</span>
									<span class="border px-1 text-[0.65rem] leading-4 {TONE[j.state]}" data-testid="journey-badge">
										{badgeLabel(j)}
									</span>
								</span>
								<span class="mt-0.5 hidden truncate text-small text-fg-2 lg:block"
									>{j.project || j.journey}</span
								>
							</a>
						</li>
					{/each}
				</ol>
				<p class="mt-2 hidden text-small text-fg-3 lg:block">
					<kbd class="font-mono">j</kbd>/<kbd class="font-mono">k</kbd> journeys ·
					<kbd class="font-mono">[</kbd>/<kbd class="font-mono">]</kbd> recordings ·
					<button type="button" class="underline" onclick={() => (showKeys = !showKeys)}>
						<kbd class="font-mono">?</kbd> all keys
					</button>
				</p>
			</nav>

			{#if selected}
				{@const j = selected}
				{@const r = j.recordings[recIndex] ?? j.recordings[0]}
				<!-- CUR-2023: the id is what a filed ticket's recording link lands on (`…/journeys#A1`),
				     and the page selects that journey on load. -->
				<article id={j.journey} data-testid="journey-open" class="min-w-0 border border-line-2 {EDGE[j.state]}">
					<header
						class="flex flex-wrap items-start justify-between gap-2 border-b border-line-1 bg-surface-2 px-4 py-3"
					>
						<div class="min-w-0">
							<h2 class="font-medium">
								<span class="font-mono text-fg-3">{j.journey}</span>
								{j.project || j.journey}
							</h2>
							<!-- CUR-1574: an undocumented recording (no docs/journeys/*.md claims this ID) has
							     nothing this line could show; `j.doc` is empty for exactly that case. -->
							{#if j.doc}
								<p class="mt-0.5 text-small text-fg-3">
									{j.steps} documented step{j.steps === 1 ? "" : "s"} ·
									<code class="font-mono">{j.spec}</code>
								</p>
							{/if}
							{#if baseline && changes[j.journey]}
								<p class="mt-0.5 text-small text-caution-text" data-testid="journey-changes">
									Changed since <code class="font-mono">{short(baseline.sha)}</code>: {changes[j.journey].join("; ")}
								</p>
							{/if}
						</div>
						<span class="shrink-0 border px-2 py-1 text-small font-medium {TONE[j.state]}" data-testid="journey-open-badge">
							{badgeLabel(j)}
						</span>
					</header>

					<div class="grid gap-4 p-4 2xl:grid-cols-[minmax(0,1fr)_24rem]">
						<section class="min-w-0 space-y-2" aria-label="Recording">
							{#if j.recordings.length === 0}
								<p class="border border-dashed border-line-1 px-3 py-10 text-center text-body text-fg-3">
									No recording. There is nothing to watch for this journey.
								</p>
							{:else}
								{#if j.recordings.length > 1}
									<!-- Each recording names its status and viewport, so two walks of one test are
									     told apart before either is played (F9 step 4). -->
									<!-- Capped at about three rows so a journey with ten recordings does not push the
									     player below the fold; the rest scroll inside the strip. -->
									<div
										class="flex max-h-[5.5rem] flex-wrap gap-1 overflow-y-auto"
										role="tablist"
										aria-label="Recordings"
									>
										{#each j.recordings as rec, i (rec.slug)}
											<button
												type="button"
												role="tab"
												aria-selected={i === recIndex}
												class="max-w-full truncate border px-2 py-1 text-left text-small {i === recIndex
													? 'border-line-3 bg-surface-3'
													: 'border-line-1 text-fg-2 hover:text-fg-1'}"
												onclick={() => (recChoice = i)}
											>
												<span class={recordingTone(rec)}>{recordingStatusLabel(rec)}</span>
												{#if rec.project}· {viewportLabel(rec.project)}{/if}
												· {rec.title}
											</button>
										{/each}
									</div>
								{/if}
								<figure class="space-y-1">
									<!-- CUR-1623: a recording opens on the blank tab before its page loads, so it
									     starts where the publisher measured the first paint. The video route answers
									     Range requests for this (CUR-1646). A recording with no screen to show has no
									     video stored, and says so instead of drawing a white box. -->
									{#if r.noScreen}
										<p
											class="border border-line-1 px-3 py-10 text-center text-small text-fg-3"
											data-testid="journey-no-screen"
										>
											{r.status === "skipped"
												? "Skipped before anything appeared on screen, so there is nothing to watch."
												: "The tab stayed blank for the whole recording, so there is nothing to watch."}
										</p>
									{:else}
										{#key r.slug}
											<!-- svelte-ignore a11y_media_has_caption -->
											<!-- CUR-2244: one player per page, so nothing competes for the fetch the way ~100 tiles did. -->
											<video
												bind:this={videoEl}
												controls
												preload="metadata"
												class="max-h-[75vh] w-full border border-line-1 bg-black object-contain"
												src={`${videoHref(r.file)}#t=${r.startAt ?? 1.5}`}
											></video>
										{/key}
									{/if}
									<figcaption class="text-small text-fg-3">
										<span class={recordingTone(r)} title={r.expectedFailureReason ?? undefined}
											>{recordingStatusLabel(r)}</span
										>
										{#if r.project}· <span class="text-fg-2">{viewportLabel(r.project)}</span
											>{/if}
										· {r.title}
										{#if r.durationMs}· {secs(r.durationMs)}{/if} · {kb(r.bytes)}
										<!-- SOL-103: what the spec measured, e.g. the A1 limit message's time; the breakdown on hover. -->
										{#each r.measurements ?? [] as m (m.name)}
											· <span class="text-fg-2" title={m.detail} data-testid="journey-measurement"
												>{m.name}: {m.value} {m.unit}</span
											>
										{/each}
									</figcaption>
								</figure>
								<!-- CUR-1574: a persona spec's turn-by-turn record. Frames alone cannot say whether a
								     click landed on what the persona asked for or on a neighbour — `acted` is what the
								     driver actually did, `why` is only the model's stated intent. -->
								{#if r.personaTrace}
									<details class="text-small text-fg-3">
										<summary class="cursor-pointer">
											{r.personaTrace.trace.length} persona turn{r.personaTrace.trace.length === 1 ? "" : "s"}
											({r.personaTrace.persona}, {r.personaTrace.provider}/{r.personaTrace.model})
										</summary>
										<ol class="mt-1 space-y-1 border-l border-line-1 pl-3">
											{#each r.personaTrace.trace as t (t.turn)}
												<li>
													<span class="text-fg-2">turn {t.turn}:</span>
													{#if t.action}
														{t.action.why} → {t.acted ?? "no action resolved"}
													{:else}
														no action chosen
													{/if}
													{#if t.error}
														<span class="text-accent-2-text">— {t.error}</span>
													{/if}
												</li>
											{/each}
										</ol>
									</details>
								{/if}
							{/if}
						</section>

						<section class="min-w-0 space-y-4 text-body" aria-label="What was found">
							<p class="text-fg-2">{j.reason}</p>

							{#if j.findings.length > 0}
								<ul class="space-y-2" data-testid="doc-findings">
									{#each j.findings as f, i (i)}
										<li class="border border-line-1 p-3" data-conclusion={f.conclusion}>
											<div class="flex flex-wrap items-center gap-2">
												<span class="text-small text-fg-3">step {f.step}</span>
												<!-- "doc" means the journey description was wrong, and it is shown exactly as
												     loudly as "product". A page that could only blame the product gets ignored
												     within a week — docs/journeys/README.md says so. -->
												<span
													class="border px-1.5 py-0.5 text-small {CONCLUSION_TONE[f.conclusion] ??
														CONCLUSION_TONE.inconclusive}"
												>
													{CONCLUSION_LABEL[f.conclusion] ?? f.conclusion}
												</span>
											</div>
											{#if f.conclusion === "unseen" && f.claim}
												<p class="mt-1 text-small text-fg-2">
													{#if f.claim.kind === "spec"}
														The journey doc says <code>{f.claim.test}</code> walks this step, and no frame of this
														journey's recordings shows it.
													{:else}
														The journey doc says a frame is the way to judge this step, and none shows it.
													{/if}
												</p>
											{/if}
											{@render findingProse(f.observation, f.rationale, undefined)}
											<p class="mt-1 text-small" data-testid="finding-next-step">
												<span class="text-fg-3">Next:</span>
												{NEXT_STEP[f.conclusion] ?? NEXT_STEP.inconclusive}
											</p>
										</li>
									{/each}
								</ul>
							{/if}

							<!-- CUR-1526. The block above is the doc grader: it can only find what a journey doc
							     already anticipated. This is the second reader — the same frames, no step table,
							     the question being whether a person would mind. -->
							{#if j.pm}
								<section class="border-t border-line-1 pt-3">
									<h3 class="text-small tracking-wide text-fg-3 uppercase">
										Watched as a product manager would
									</h3>
									{#if !j.pm.watched}
										<p class="mt-1 text-fg-2">
											Nobody watched this journey this run — {j.pm.reason}. Anything above is the doc
											grader alone, so this card carries no opinion about how it felt.
										</p>
									{:else if j.pm.findings.length === 0}
										<p class="mt-1 text-fg-2">Watched, nothing above the bar.</p>
									{:else}
										<ul class="mt-2 space-y-2" data-testid="pm-findings">
											{#each j.pm.findings as f, i (i)}
												<li class="border border-line-1 p-3" data-severity={f.severity}>
													<div class="flex flex-wrap items-center gap-2">
														<span class="text-small text-fg-3">{f.area}</span>
														<span class="border px-1.5 py-0.5 text-small {SEVERITY_TONE[f.severity]}">
															{f.severity} — {SEVERITY_LABEL[f.severity]}
														</span>
														<!-- CUR-1670: this states the filing RULE, never the outcome. Tickets are
														     opened in a step that runs after the manifest is published, so no
														     ticket id exists for this line to check against. -->
														<span class="text-small text-fg-3">
															{PM_FILED.includes(f.severity)
																? "this severity is filed"
																: "this severity is not filed"}
														</span>
													</div>
													{@render findingProse(f.observation, f.rationale, f.suggestion)}
												</li>
											{/each}
										</ul>
										<p class="mt-2 text-small text-fg-3">
											Whether a ticket was actually opened for any of these is in the run's own job
											summary, not on this page (CUR-1670).
										</p>
									{/if}
									{#if j.pm.rejected && j.pm.rejected.length > 0}
										<p class="mt-2 text-small text-fg-3">
											Discarded as unusable: {j.pm.rejected.join("; ")}
										</p>
									{/if}
								</section>
							{/if}

							{#if j.excluded.length > 0}
								<p class="text-fg-2">
									Not graded, because these runs did not pass:
									{j.excluded
										.map((e: { title: string; status: string }) => `${e.title} (${e.status})`)
										.join("; ")}
								</p>
							{/if}

							{#if j.stale.length > 0}
								<p class="text-fg-2">
									{j.stale.length} recording director{j.stale.length === 1 ? "y" : "ies"} wrote
									incompletely ({j.stale
										.map((s: { missing: string }) => `missing ${s.missing}`)
										.join("; ")}) — the recording happened, the artifact did not arrive whole.
								</p>
							{/if}
						</section>
					</div>
				</article>
			{:else}
				<p class="text-body text-fg-3">No journey matches this filter.</p>
			{/if}
		</div>

		{#if showKeys}
			<div
				class="fixed right-4 bottom-4 z-50 border border-line-3 bg-surface-1 p-4 text-body shadow-lg"
				role="dialog"
				aria-label="Keyboard shortcuts"
			>
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
					<dt class="font-mono">j / k</dt>
					<dd>next / previous journey</dd>
					<dt class="font-mono">] / [</dt>
					<dd>next / previous recording</dd>
					<dt class="font-mono">space</dt>
					<dd>play or pause</dd>
					<dt class="font-mono">?</dt>
					<dd>show or hide this</dd>
				</dl>
			</div>
		{/if}

		{#if manifest.untouched}
			{@const u = manifest.untouched}
			<section class="mt-8">
				<h2 class="mb-2 font-medium">What no recording reaches</h2>
				<p class="mb-2 text-body text-fg-2">
					The cards above cover what the journey docs ask for. These are the parts of the app no
					scenario spec opens or names, read from the app's own routes and flags, so they stay
					listed until a spec reaches them.
				</p>
				<h3 class="mt-4 mb-1 text-body font-medium">
					{u.routes.length} of {u.routesTotal} pages no spec opens
				</h3>
				<p class="mb-2 text-small text-fg-3">
					A spec that reaches a page through a URL it builds at run time is not seen here.
				</p>
				<ul class="columns-1 font-mono text-small sm:columns-2">
					{#each u.routes as route (route)}
						<li>{route}</li>
					{/each}
				</ul>
				{#if u.flags}
					<h3 class="mt-4 mb-1 text-body font-medium">
						{u.flags.length} of {u.flagsOnInPreview} flags on in preview that no spec names
					</h3>
					<ul class="columns-1 font-mono text-small sm:columns-2">
						{#each u.flags as key (key)}
							<li>{key}</li>
						{/each}
					</ul>
				{:else}
					<p class="mt-4 text-body text-fg-2">
						Flags were not read for this run ({u.flagsNotRead}), so this says nothing about which
						features no recording reaches.
					</p>
				{/if}
			</section>
		{:else}
			<p class="mt-8 text-body text-fg-2">
				This run was published before the gallery listed what no recording reaches, so it says
				nothing about the pages and features outside the journeys.
			</p>
		{/if}

		{#if manifest.run.languageProbe}
			<section class="mt-8">
				<h2 class="mb-2 font-medium">Reply language, across 20 languages</h2>
				<p class="mb-2 text-body text-fg-2">
					One ordinary question per language, same run, same configuration as above — the first
					round of the two-round matrix that separates a broken language from a broken topic.
				</p>
				<pre
					class="overflow-x-auto border border-line-2 bg-surface-2 p-3 text-small">{manifest
						.run.languageProbe}</pre>
			</section>
		{/if}
	{/if}
</div>
