<script lang="ts">
	import { tick } from 'svelte';
	import { Button, Checkbox, Kbd, Textarea } from '@aipotluck/alpha-ds';
	import { CANT_TELL, type Direction, type EvalFlag, type EvalQuestion } from '$lib/chat/evaluate/types';
	import { EXCLUDING_FLAGS } from '$lib/chat/evaluate/rating';
	import OptionTiles from './OptionTiles.svelte';
	import RiArrowLeftLine from '~icons/ri/arrow-left-line';
	import RiArrowRightLine from '~icons/ri/arrow-right-line';
	import RiFlagLine from '~icons/ri/flag-line';

	/**
	 * The rubric one question at a time: a segmented bar for where you are, the question large, its
	 * answers as tiles. Picking one moves on; Back goes back. Keys 1–9 pick, Enter moves on. "What a
	 * good answer does" shows on the "is it correct?" step, next to the question it serves.
	 *
	 * The last step (rated answers only) holds the optional flags and comment, and a review of every
	 * answer, each one a way back to its question. `missing` (a refusal) jumps to the first one named.
	 */
	let {
		questions,
		answers = $bindable({}),
		flags = [],
		selectedFlags = $bindable([]),
		comment = $bindable(''),
		reference = [],
		dir,
		lang,
		missing = [],
		submitting = false,
		submitLabel,
		onsubmit
	}: {
		questions: EvalQuestion[];
		answers?: Record<string, string | undefined>;
		flags?: EvalFlag[];
		selectedFlags?: string[];
		comment?: string;
		reference?: string[];
		dir: Direction;
		lang?: string;
		missing?: string[];
		submitting?: boolean;
		submitLabel: string;
		onsubmit: () => void;
	} = $props();

	let step = $state(0);
	const last = $derived(questions.length);
	const question = $derived(questions[step] as EvalQuestion | undefined);
	const excluded = $derived(selectedFlags.some((f) => EXCLUDING_FLAGS.has(f)));
	let heading = $state<HTMLElement>();

	async function go(to: number) {
		step = Math.max(0, Math.min(last, to));
		await tick();
		heading?.focus({ preventScroll: true });
	}

	// A refusal names questions: open the first of them.
	$effect(() => {
		const first = missing.find((k) => !answers[k]);
		if (first) go(questions.findIndex((q) => q.key === first));
	});

	function pick(key: string, value: string) {
		answers[key] = value;
		if (questions[step]?.key === key) setTimeout(() => go(step + 1), 180);
	}

	function choiceLabel(q: EvalQuestion): string {
		const v = answers[q.key];
		if (!v) return 'Not answered';
		if (v === CANT_TELL) return q.cantTellLabel ?? 'I can’t tell';
		const o = q.options.find((opt) => String(opt.value) === v);
		return o ? (q.type === 'scale' ? `${o.value} · ${o.label}` : o.label) : v;
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const target = e.target instanceof Element ? e.target : null;
		if (target?.closest('textarea, input, select, [contenteditable]')) return;
		if (question && /^[1-9]$/.test(e.key)) {
			const values = [...question.options.map((o) => String(o.value)), ...(question.allowCantTell ? [CANT_TELL] : [])];
			const v = values[Number(e.key) - 1];
			if (v) {
				e.preventDefault();
				pick(question.key, v);
			}
		} else if (e.key === 'Enter' && question && answers[question.key] && !target?.closest('button, a')) {
			e.preventDefault();
			go(step + 1);
		}
	}

	function toggleFlag(key: string, on: boolean) {
		selectedFlags = on ? [...new Set([...selectedFlags, key])] : selectedFlags.filter((k) => k !== key);
	}

	function cannotRate() {
		toggleFlag('task_badly_written', true);
		go(last);
	}
</script>

<svelte:window {onkeydown} />

<div class="flex flex-col gap-5" data-eval-stepper data-eval-step={question?.key ?? 'finish'}>
	<!-- Where you are: one segment per question, then the finishing step. -->
	<div class="flex flex-col gap-2">
		<div class="flex gap-1" aria-hidden="true">
			{#each [...questions, null] as q, i (q?.key ?? 'finish')}
				<span
					class="h-1 flex-1 rounded-sharp transition-control {i < step || (q && answers[q.key])
						? 'bg-fg-1'
						: i === step
							? 'bg-fg-3'
							: 'bg-line-2'}"
				></span>
			{/each}
		</div>
		<p class="type-label text-fg-3" data-eval-step-count>
			{question ? `Question ${step + 1} of ${questions.length}` : 'Last step'}
		</p>
	</div>

	{#if question}
		{#key question.key}
			<section class="flex flex-col gap-4" aria-labelledby="eval-q-label" data-eval-question={question.key}>
				<div class="flex flex-col gap-1.5">
					<h3 id="eval-q-label" bind:this={heading} tabindex="-1" class="type-title text-fg-1 outline-none">
						{question.label}
					</h3>
					{#if question.help}<p class="type-body text-fg-2">{question.help}</p>{/if}
				</div>

				{#if question.key === 'accuracy' && reference.length}
					<div class="flex flex-col gap-1.5 border border-line-2 bg-surface-2 p-3 rounded-card" data-eval-reference>
						<h4 class="type-label text-fg-2">What a good answer does</h4>
						<ul {dir} {lang} class="flex list-disc flex-col gap-1 ps-5 type-body text-fg-1">
							{#each reference as line, j (j)}<li>{line}</li>{/each}
						</ul>
					</div>
				{/if}

				{#if missing.includes(question.key) && !answers[question.key]}
					<p class="type-body text-accent-2-text" role="alert" data-eval-missing-note>
						This one still needs an answer before the rating can be sent.
					</p>
				{/if}

				<OptionTiles
					{question}
					bind:value={() => answers[question.key] ?? '', (v) => (answers[question.key] = v || undefined)}
					onpick={(v) => pick(question.key, v)}
				/>

				{#if question.example}
					<p class="type-caption text-fg-3">For example: {question.example}</p>
				{/if}
			</section>
		{/key}
	{:else}
		<section class="flex flex-col gap-5" aria-labelledby="eval-q-label" data-eval-question="finish">
			<h3 id="eval-q-label" bind:this={heading} tabindex="-1" class="type-title text-fg-1 outline-none">
				{flags.length ? 'Anything else about this answer?' : 'Check your answers'}
			</h3>

			{#if flags.length}
				<div class="flex flex-col gap-1.5" role="group" aria-label="Optional flags" data-eval-flags>
					{#each flags as flag (flag.key)}
						<label
							class="flex cursor-pointer items-center gap-3 border border-line-2 bg-surface-raised px-3 py-2.5 type-body text-fg-1 rounded-card transition-control hover:tint-hover has-data-checked:border-fg-1 has-data-checked:tint-active"
						>
							<Checkbox.Root
								checked={selectedFlags.includes(flag.key)}
								onCheckedChange={(on) => toggleFlag(flag.key, on === true)}
								data-eval-flag={flag.key}
							>
								<Checkbox.Indicator />
							</Checkbox.Root>
							{flag.label}
						</label>
					{/each}
				</div>
			{/if}

			{#if answers.usable === 'no' && flags.length}
				<div class="flex flex-col gap-1.5" data-eval-comment>
					<label for="eval-comment" class="type-body text-fg-1">
						What was the main problem? <span class="text-fg-3">(optional)</span>
					</label>
					<Textarea id="eval-comment" bind:value={comment} maxlength={1000} minRows={2} />
					<p class="type-caption text-fg-3">Please don’t include personal information.</p>
				</div>
			{/if}

			<ol class="flex flex-col divide-y divide-line-2 border border-line-2 rounded-card" data-eval-review>
				{#each questions as q, i (q.key)}
					<li>
						<button
							type="button"
							class="flex w-full items-baseline gap-3 px-3 py-2 text-left transition-control hover:tint-hover"
							onclick={() => go(i)}
						>
							<span class="w-4 shrink-0 type-code text-fg-3">{i + 1}</span>
							<span class="min-w-0 flex-1 type-caption text-fg-2">{q.label}</span>
							<span class="max-w-1/2 text-right type-caption {answers[q.key] ? 'text-fg-1' : excluded ? 'text-fg-3' : 'text-accent-2-text'}">
								{choiceLabel(q)}
							</span>
						</button>
					</li>
				{/each}
			</ol>
		</section>
	{/if}

	<div class="flex items-center gap-2 border-t border-line-2 pt-4" data-eval-actions>
		<Button variant="ghost" casing="sentence" size="sm" disabled={step === 0} onclick={() => go(step - 1)}>
			<RiArrowLeftLine aria-hidden="true" /> Back
		</Button>
		{#if question}
			{#if flags.length}
				<Button variant="ghost" casing="sentence" size="sm" onclick={cannotRate} data-eval-cannot-rate>
					<RiFlagLine aria-hidden="true" /> Can’t rate it
				</Button>
			{/if}
			<span class="flex-1"></span>
			<Button casing="sentence" disabled={!answers[question.key]} onclick={() => go(step + 1)} data-eval-next-question>
				Next <Kbd class="max-sm:hidden">↵</Kbd>
			</Button>
		{:else}
			<span class="flex-1"></span>
			<Button variant="primary" casing="sentence" disabled={submitting} onclick={onsubmit} data-eval-submit>
				{submitting ? 'Sending…' : submitLabel} <RiArrowRightLine aria-hidden="true" />
			</Button>
		{/if}
	</div>
</div>
