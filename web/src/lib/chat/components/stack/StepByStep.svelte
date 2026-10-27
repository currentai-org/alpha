<script lang="ts">
	import type { Component } from 'svelte';
	import type { AssistRole, AssistedBy, Message } from '$lib/chat/types/Message';
	import { Badge, Collapsible, Favicon } from '@aipotluck/alpha-ds';
	import { faviconSrc } from '$lib/favicon';
	import { provenanceFacts } from '$lib/chat/utils/trace/provenanceFacts';
	import { summarizeToolRun } from '$lib/chat/utils/trace/toolRunSummary';
	import { DISPOSITION_COPY } from '$lib/chat/utils/responseDisposition';
	import { catalog, catalogByGatewayId, orgs } from '$lib/chat/routing/catalog';
	import { resolveModelIdentity, servedModelId } from '$lib/chat/identity';
	import { ranOn } from '$lib/chat/provenanceLine';
	import { useShowServing } from '$lib/chat/stores/showServing.svelte';
	import { assistHostLabel } from '$lib/chat/utils/trace/assistHost';
	import type { SafetyRule } from '$lib/chat/types/SafetyRule';
	import {
		classifyRules,
		factCheckStep,
		formatDay,
		ragSources,
		screenOrder,
		webOrigins,
		webSources,
		type RuleRow,
		type StepSource
	} from './stepEvidence';
	import SecondOpinion from '../chat/SecondOpinion.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import RiChat3Line from '~icons/ri/chat-3-line';
	import RiShieldCheckLine from '~icons/ri/shield-check-line';
	import RiBookOpenLine from '~icons/ri/book-open-line';
	import RiGlobalLine from '~icons/ri/global-line';
	import RiQuillPenLine from '~icons/ri/quill-pen-line';
	import RiToolsLine from '~icons/ri/tools-line';
	import RiEyeLine from '~icons/ri/eye-line';
	import RiCheckboxCircleLine from '~icons/ri/checkbox-circle-line';
	import RiSave3Line from '~icons/ri/save-3-line';
	import RiTeamLine from '~icons/ri/team-line';
	import RiStopCircleLine from '~icons/ri/stop-circle-line';
	import RiArrowRightSLine from '~icons/ri/arrow-right-s-line';
	import RiRouteLine from '~icons/ri/route-line';
	import RiCalculatorLine from '~icons/ri/calculator-line';
	import RiFileSearchLine from '~icons/ri/file-search-line';
	import RiPriceTag3Line from '~icons/ri/price-tag-3-line';
	import RiTranslate2 from '~icons/ri/translate-2';
	import { languageName } from '$lib/chat/routing/languages';
	import { MCP_CALL_TITLE, mcpCallWhat } from './mcpCallCopy';

	/**
	 * XRAY → "Step by step", written for someone who has never heard of a model, a pipeline or a
	 * safety classifier. Each step answers three questions in order: what happened, what it means for
	 * you, and (optionally) the evidence — sources, the tool that ran, how long it took.
	 *
	 * Built from `provenanceFacts` (the same facts as the receipt and the developer trace), so it can't
	 * claim anything the turn didn't record. Only steps that actually happened are listed.
	 */
	let {
		message,
		modelId,
		question,
		loading = false,
		followUp = false,
		safetyRules = [],
		attachedFiles = []
	}: {
		message: Message;
		modelId?: string;
		question?: string;
		loading?: boolean;
		/** Earlier messages in this chat went with the question, so it isn't the chat's first turn. */
		followUp?: boolean;
		/** The named safety rules (the layout's `safetyRules`), listed under a safety check that ran. */
		safetyRules?: SafetyRule[];
		/** Names of the files the question carried. The answer read them, so it isn't from training alone (CUR-4353). */
		attachedFiles?: string[];
	} = $props();

	type Tone = 'ok' | 'note' | 'stop';
	interface Step {
		id: string;
		icon: Component;
		title: string;
		/** What happened, in one plain sentence. */
		what: string;
		/** Why it matters to you — optional. */
		why?: string;
		tone: Tone;
		/** Measured time for this step, and how to read it ("took 1.2 s", "first words after 1.2 s", "done after 1.2 s"). */
		ms?: number;
		timeLabel?: (time: string) => string;
		sources?: StepSource[];
		/** A quoted block the step received, e.g. a private source's summary. */
		quote?: string;
		/** Code a step ran and what it printed (CUR-4232), shown as-is. */
		code?: string;
		/** The named safety rules and how this turn left each one. */
		rules?: RuleRow[];
		/** A helper model's id, the host it ran on, and that host in words (CUR-984). */
		assist?: { model: string; host: string; hostLabel: string };
	}

	const facts = $derived(provenanceFacts(message));
	const t = $derived(message.timings);

	const served = $derived(servedModelId(message.routerMetadata, modelId));
	const model = $derived(catalogByGatewayId(served));
	const modelName = $derived(model?.name ?? (served ? resolveModelIdentity(served).short : m.message_stepModelFallback()));
	const maker = $derived(model ? orgs[model.maker] : undefined);
	// After a failover the footer says "(backup)"; the write step names the model that was picked too. (CUR-3968)
	const backupLine = $derived.by(() => {
		const fo = message.failover;
		if (!fo) return undefined;
		const picked = catalogByGatewayId(fo.from)?.name ?? resolveModelIdentity(fo.from).short;
		return fo.reason === 'skipped'
			? m.message_stepWriteBackupSkipped({ picked, model: modelName })
			: m.message_stepWriteBackup({ picked, model: modelName });
	});
	// Where it ran comes from this answer's routing record, never the catalogue's planned host. (CUR-3562)
	const ran = $derived(ranOn(message.routerMetadata?.backend, message.routerMetadata?.provider));
	// The person may hide which model wrote the answer and where it ran. (CUR-549)
	const serving = useShowServing();

	// The models that worked on this answer without writing it, each named with where it ran.
	// Functions, not strings, so the copy follows a language switch. (CUR-984)
	const ASSIST_COPY: Record<
		AssistRole,
		{
			id: string;
			icon: Component;
			title: () => string;
			did: (p: { model: string }) => string;
			didOn: (p: { model: string; host: string }) => string;
			// The same fact with no model or host, for when the person hides which model ran. (CUR-549)
			didHidden: () => string;
		}
	> = {
		'search-decision': {
			id: 'assist-search-decision',
			icon: RiRouteLine,
			title: () => m.message_stepAssistSearchTitle(),
			did: (p) => m.message_stepAssistSearchWhat(p),
			didOn: (p) => m.message_stepAssistSearchWhatHost(p),
			didHidden: () => m.message_stepAssistSearchWhatHidden()
		},
		'math-route': {
			id: 'assist-math-route',
			icon: RiCalculatorLine,
			title: () => m.message_stepAssistMathTitle(),
			did: (p) => m.message_stepAssistMathWhat(p),
			didOn: (p) => m.message_stepAssistMathWhatHost(p),
			didHidden: () => m.message_stepAssistMathWhatHidden()
		},
		// The other models that read the message, each from its own call's record. (CUR-3563)
		'safety-screen': {
			id: 'assist-safety-screen',
			icon: RiShieldCheckLine,
			title: () => m.message_stepAssistSafetyTitle(),
			did: (p) => m.message_stepAssistSafetyWhat(p),
			didOn: (p) => m.message_stepAssistSafetyWhatHost(p),
			didHidden: () => m.message_stepAssistSafetyWhatHidden()
		},
		'query-rewrite': {
			id: 'assist-query-rewrite',
			icon: RiFileSearchLine,
			title: () => m.message_stepAssistQueryTitle(),
			did: (p) => m.message_stepAssistQueryWhat(p),
			didOn: (p) => m.message_stepAssistQueryWhatHost(p),
			didHidden: () => m.message_stepAssistQueryWhatHidden()
		},
		title: {
			id: 'assist-title',
			icon: RiPriceTag3Line,
			title: () => m.message_stepAssistTitleTitle(),
			did: (p) => m.message_stepAssistTitleWhat(p),
			didOn: (p) => m.message_stepAssistTitleWhatHost(p),
			didHidden: () => m.message_stepAssistTitleWhatHidden()
		}
	};
	const assistStep = (role: AssistRole): Step | undefined => {
		const entry: AssistedBy | undefined = message.routerMetadata?.assistedBy?.find((e) => e.role === role);
		if (!entry) return undefined;
		const copy = ASSIST_COPY[role];
		const name = resolveModelIdentity(entry.model).short;
		const host = entry.provider || entry.backend || '';
		const hostLabel = assistHostLabel(entry);
		return {
			id: copy.id,
			icon: copy.icon,
			title: copy.title(),
			what: !serving.current
				? copy.didHidden()
				: hostLabel
					? copy.didOn({ model: name, host: hostLabel })
					: `${copy.did({ model: name })} ${m.message_stepHostNotRecorded()}`,
			why: m.message_stepAssistWhy(),
			tone: 'ok',
			assist: { model: entry.model, host, hostLabel }
		};
	};

	const took = (time: string) => m.message_stepTimeTook({ time });

	const steps = $derived.by(() => {
		const f = facts;
		const out: Step[] = [
			{
				id: 'asked',
				icon: RiChat3Line,
				title: m.message_stepAskedTitle(),
				what: followUp ? m.message_stepAskedWhat() : m.message_stepAskedWhatFirst(),
				tone: 'ok'
			}
		];

		// The picker was on Auto and Auto chose this answer's model. (CUR-3944)
		const auto = message.autoRoute;
		const autoModel = auto && catalog.find((c) => c.id === auto.model);
		if (auto && autoModel) {
			out.push({
				id: 'auto-route',
				icon: RiRouteLine,
				title: serving.current ? m.message_stepAutoTitle({ model: autoModel.name }) : m.message_stepAutoTitleHidden(),
				// Auto's own explanation can name the model, so it stays out while the model is hidden.
				what: !serving.current
					? m.message_stepAutoWhatHidden()
					: auto.explanation || m.message_stepAutoWhat({ model: autoModel.name }),
				why: m.message_stepAutoWhy(),
				tone: 'ok'
			});
		}

		// The answer is asked for by name in the language the person wrote, so a model that
		// would otherwise default to English (as with Hausa) answers in that language. (CUR-2237)
		const asked = message.routerMetadata?.answerLanguage;
		if (asked) {
			const language = languageName(asked);
			out.push({
				id: 'answer-language',
				icon: RiTranslate2,
				title: m.message_stepLanguageTitle({ language }),
				what: m.message_stepLanguageWhat({ language }),
				tone: 'ok'
			});
		}

		if (f.servedFromCache) {
			out.push({
				id: 'cache',
				icon: RiBookOpenLine,
				title: m.message_stepCacheTitle(),
				what: m.message_stepCacheWhat(),
				why: m.message_stepCacheWhy(),
				tone: 'note'
			});
			return out;
		}

		const order = screenOrder(t);
		const screenRan = f.screen === 'clear' || f.screen === 'flagged';
		out.push({
			id: 'safety',
			icon: RiShieldCheckLine,
			title: m.message_stepSafetyTitle(),
			what:
				f.screen === 'flagged'
					? message.moderation?.unscreened
						? m.message_stepSafetyUnscreened()
						: message.moderation?.ruleLabel
							? m.message_stepSafetyMatchedRule({ rule: message.moderation.ruleLabel })
							: m.message_stepSafetyMatched()
					: f.screen === 'failed-open'
						? m.message_stepSafetyFailedOpen()
						: f.screen === 'clear'
							? message.moderation?.ruleLabel
								? m.message_stepSafetyMatchedRule({ rule: message.moderation.ruleLabel })
								: m.message_stepSafetyClear()
							: m.message_stepSafetyNone(),
			why: !screenRan
				? undefined
				: order === 'first'
					? m.message_stepSafetyWhyFirst()
					: order === 'alongside-discarded'
						? m.message_stepSafetyWhyDiscarded()
						: m.message_stepSafetyWhyAlongside(),
			tone: f.screen === 'flagged' ? 'stop' : f.screen === 'clear' ? 'ok' : 'note',
			ms: t?.gateMs,
			timeLabel: took,
			rules:
				screenRan && !message.moderation?.unscreened && safetyRules.length
					? classifyRules(safetyRules, {
							triggeredLabel: message.moderation?.ruleLabel,
							blocked: message.moderation?.flagged
						})
					: undefined
		});

		const screenHelper = assistStep('safety-screen');
		if (screenHelper) out.push(screenHelper);

		if (f.declined) {
			out.push({
				id: 'declined',
				icon: RiStopCircleLine,
				title: m.message_stepDeclinedTitle(),
				what: m.message_stepDeclinedWhat(),
				tone: 'stop'
			});
			return out;
		}

		const searchHelper = assistStep('search-decision');
		if (searchHelper) out.push(searchHelper);
		const rewriteHelper = assistStep('query-rewrite');
		if (rewriteHelper) out.push(rewriteHelper);

		const used = f.disposition === 'answered';
		if (used) {
			for (const hit of f.ragHits) {
				out.push({
					id: `rag-${hit.engine}`,
					icon: RiBookOpenLine,
					title: m.message_stepRagTitle(),
					what:
						hit.count === 1
							? m.message_stepRagWhatOne({ source: hit.label })
							: m.message_stepRagWhatMany({ count: hit.count, source: hit.label }),
					why: m.message_stepRagWhy(),
					tone: 'ok',
					ms: t?.ragMs,
					timeLabel: took,
					sources: ragSources(message, hit.engine)
				});
			}
			if (f.vault) {
				out.push({
					id: 'vault',
					icon: RiBookOpenLine,
					title: m.message_stepVaultTitle(),
					what: m.message_stepVaultWhat(),
					tone: 'ok',
					quote: message.rag?.vaultSynthesis?.trim()
				});
			}
			if (f.webCount) {
				const query = message.webSearch?.query ?? '';
				const origins = webOrigins(f.webEngines);
				const day = message.webSearch?.asOf ? formatDay(message.webSearch.asOf) : undefined;
				out.push({
					id: 'web',
					icon: RiGlobalLine,
					title: m.message_stepWebTitle(),
					what: day
						? f.webCount === 1
							? m.message_stepWebWhatOne({ query, day, origins })
							: m.message_stepWebWhatMany({ query, day, origins, count: f.webCount })
						: f.webCount === 1
							? m.message_stepWebWhatOneUndated({ query, origins })
							: m.message_stepWebWhatManyUndated({ query, origins, count: f.webCount }),
					why: m.message_stepWebWhy(),
					tone: 'ok',
					ms: t?.retrievalMs,
					timeLabel: took,
					sources: webSources(message)
				});
			} else if (f.searchAttempted) {
				out.push({
					id: 'web-none',
					icon: RiGlobalLine,
					title:
						f.searchRan || f.searchFailed ? m.message_stepWebTitle() : m.message_stepWebConsideredTitle(),
					what: f.searchFailed
						? m.message_stepWebUnfinished()
						: f.searchRan
							? m.message_stepWebNothingReliable()
							: m.message_stepWebNotNeeded(),
					why: m.message_stepWebNoneWhy(),
					tone: 'note'
				});
			}
		}

		const mathHelper = assistStep('math-route');
		if (mathHelper) out.push(mathHelper);

		// The model's own calculate calls, which the caption under the answer already shows. Like
		// that caption, a refused call drops out once a later one worked, and nothing here says "checked". (CUR-3943)
		const calls = message.calculations ?? [];
		if (calls.length) {
			const worked = calls.filter((c) => c.result !== undefined);
			out.push({
				id: 'calculator',
				icon: RiCalculatorLine,
				title: m.message_stepCalculatorTitle(),
				what: worked.length
					? serving.current
						? m.message_stepCalculatorWhat({
								model: modelName,
								working: worked.map((c) => `${c.expression} = ${c.result}`).join('; ')
							})
						: m.message_stepCalculatorWhatHidden({ working: worked.map((c) => `${c.expression} = ${c.result}`).join('; ') })
					: serving.current
						? m.message_stepCalculatorRefused({ model: modelName })
						: m.message_stepCalculatorRefusedHidden(),
				why: worked.length ? m.message_stepCalculatorWhy() : undefined,
				tone: worked.length ? 'ok' : 'note'
			});
		}

		if (f.answered) {
			out.push({
				id: 'write',
				icon: RiQuillPenLine,
				title: m.message_stepWriteTitle(),
				what: f.interrupted
					? serving.current
						? m.message_stepWriteInterrupted({ model: modelName })
						: m.message_stepWriteInterruptedHidden()
					: !serving.current
						? m.message_stepWriteWhatHidden()
						: maker && ran?.org && maker.id === ran.org.id
						? m.message_stepWriteWhatMakerServed({ model: modelName, maker: maker.name })
						: maker && ran
							? m.message_stepWriteWhatMakerHost({ model: modelName, maker: maker.name, host: ran.label })
							: maker
								? m.message_stepWriteWhatMaker({ model: modelName, maker: maker.name })
								: ran
									? m.message_stepWriteWhatHost({ model: modelName, host: ran.label })
									: m.message_stepWriteWhat({ model: modelName }),
				why: [serving.current ? backupLine : undefined, f.grounded
						? m.message_stepWriteWhyGrounded()
						: attachedFiles.length
							? m.message_stepWriteWhyAttached({ names: attachedFiles.join(', ') })
							: m.message_stepWriteWhyUngrounded()
				]
					.filter(Boolean)
					.join(' '),
				tone: f.interrupted ? 'note' : 'ok',
				ms: t?.ttftMs,
				timeLabel: (time) => m.message_stepTimeFirstWords({ time })
			});

			if (f.disposition !== 'answered') {
				out.push({
					id: 'disposition',
					icon: RiEyeLine,
					title: m.message_stepDispositionTitle(),
					what: DISPOSITION_COPY[f.disposition].chip,
					tone: 'note'
				});
			}

			if (f.mcpRan && message.mcp?.tool) {
				out.push({
					id: 'tool',
					icon: RiToolsLine,
					title: m.message_stepToolTitle(),
					what: m.message_stepToolWhat({ tool: message.mcp.tool }),
					tone: 'ok',
					sources: message.mcp.space
						? [{ n: 1, title: message.mcp.tool, url: message.mcp.space, from: m.message_stepToolFrom() }]
						: undefined
				});
			}
			if (f.agentToolsRan && message.agentTools?.toolKinds?.length) {
				const summary = message.agentTools.counts ? summarizeToolRun(message.agentTools.counts) : '';
				out.push({
					id: 'agent',
					icon: RiToolsLine,
					title: m.message_stepAgentTitle(),
					what: summary ? `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.` : m.message_stepAgentFallback(),
					tone: 'ok'
				});
			}
			if (message.mcp?.skipped) {
				out.push(
					message.mcp.failed
						? {
								id: 'tool-skipped',
								icon: RiToolsLine,
								title: m.message_stepToolFailedTitle(),
								what: m.message_stepToolFailedWhat(),
								tone: 'note'
							}
						: {
								id: 'tool-skipped',
								icon: RiToolsLine,
								title: m.message_stepToolSkippedTitle(),
								what: m.message_stepToolSkippedWhat(),
								tone: 'note'
							}
				);
			}

			// Each call to a configured MCP server, with what came of it. (CUR-3026)
			(message.mcpCalls ?? []).forEach((c, i) => {
				out.push({
					id: `mcp-call-${i}`,
					icon: RiToolsLine,
					title: MCP_CALL_TITLE[c.outcome]?.() ?? m.message_mcpTitleDefault(),
					what: mcpCallWhat(c),
					tone: c.outcome === 'ok' ? 'ok' : 'note',
					ms: c.ms,
					timeLabel: took,
					...(c.input || c.output ? { code: [c.input, c.output].filter(Boolean).join('\n\n') } : {})
				});
			});

			if (f.outputScreen !== 'unknown') {
				out.push({
					id: 'output',
					icon: RiEyeLine,
					title: m.message_stepOutputTitle(),
					what:
						f.outputScreen === 'flagged'
							? m.message_stepOutputFlagged()
							: f.outputScreen === 'failed-open'
								? m.message_stepOutputFailedOpen()
								: m.message_stepOutputClear(),
					tone: f.outputScreen === 'flagged' ? 'stop' : f.outputScreen === 'failed-open' ? 'note' : 'ok'
				});
			}

			// One whole sentence per fix, so no language has to stitch fragments together.
			const fixes: string[] = [];
			const links = message.urlNotice?.count ?? 0;
			const labels = message.labelNotice?.count ?? 0;
			if (links) fixes.push(links === 1 ? m.message_stepFixLinksOne() : m.message_stepFixLinksMany({ count: links }));
			if (labels) fixes.push(labels === 1 ? m.message_stepFixLabelsOne() : m.message_stepFixLabelsMany({ count: labels }));
			if (message.sourceNotice) fixes.push(m.message_stepFixSources());
			if (message.nameNotice) fixes.push(m.message_stepFixName());
			out.push({
				id: 'honesty',
				icon: RiCheckboxCircleLine,
				title: m.message_stepHonestyTitle(),
				what: fixes.length ? fixes.join(' ') : m.message_stepHonestyClear(),
				why: m.message_stepHonestyWhy(),
				tone: fixes.length ? 'note' : 'ok'
			});

			// Only when the fact check ran on this answer; the count comes from its stamp. (CUR-2927)
			if (message.groundcheckNotice) {
				out.push({
					id: 'factcheck',
					icon: RiFileSearchLine,
					title: 'Fact check',
					...factCheckStep(message.groundcheckNotice),
					why: 'Each claim was compared with the sources this answer used, and any none of them back is taken out.'
				});
			}

			const titleHelper = assistStep('title');
			if (titleHelper) out.push(titleHelper);

			out.push({
				id: 'saved',
				icon: RiSave3Line,
				title: m.message_stepSavedTitle(),
				what: m.message_stepSavedWhat(),
				tone: 'ok',
				ms: t?.totalMs,
				timeLabel: (time) => m.message_stepTimeDone({ time })
			});
		}

		if (f.verified) {
			const n = message.opinions?.length ?? 0;
			out.push({
				id: 'second-opinion',
				icon: RiTeamLine,
				title: m.message_secondOpinion(),
				what: [secondOpinionWhat(n, message.verdict?.agreement), ...panelHosts(message.opinions ?? [])].join(' '),
				tone: 'ok'
			});
		}
		return out;
	});

	// Where each panelist's own call ran, from the stored take's routing record (CUR-3563).
	function panelHosts(opinions: NonNullable<Message['opinions']>): string[] {
		return opinions.map((o) => {
			const host = assistHostLabel(o);
			return host
				? m.message_stepSecondTakeHost({ model: o.modelShort, host })
				: m.message_stepSecondTakeNoHost({ model: o.modelShort });
		});
	}

	function secondOpinionWhat(n: number, agreement?: 'high' | 'mixed' | 'low'): string {
		const one = n === 1;
		if (agreement === 'high') return one ? m.message_stepSecondHighOne() : m.message_stepSecondHighMany({ count: n });
		if (agreement === 'mixed') return one ? m.message_stepSecondMixedOne() : m.message_stepSecondMixedMany({ count: n });
		if (agreement === 'low') return one ? m.message_stepSecondLowOne() : m.message_stepSecondLowMany({ count: n });
		return one ? m.message_stepSecondOne() : m.message_stepSecondMany({ count: n });
	}

	const seconds = (ms: number) => (ms < 1000 ? `${Math.max(0.1, ms / 1000).toFixed(1)} s` : ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
	const total = $derived(t?.totalMs);
	let openSources = $state<Record<string, boolean>>({});
	const sourcesToggle = (open: boolean, n: number) =>
		open
			? n === 1
				? m.message_stepHideSourcesOne()
				: m.message_stepHideSourcesMany({ count: n })
			: n === 1
				? m.message_stepSeeSourcesOne()
				: m.message_stepSeeSourcesMany({ count: n });

	const dot: Record<Tone, string> = {
		ok: 'border-line-2 bg-surface-2 text-fg-2',
		note: 'border-line-3 bg-surface-2 text-fg-1',
		stop: 'border-fg-1 bg-fg-1 text-surface-1'
	};
</script>

<div class="flex flex-col gap-3" data-step-by-step>
	<p class="type-caption text-fg-3">
		{total
			? m.message_stepsSummaryTimed({ count: steps.length, time: seconds(total) })
			: m.message_stepsSummary({ count: steps.length })}
	</p>

	<ol class="relative flex flex-col">
		{#each steps as step, i (step.id)}
			{@const Icon = step.icon}
			{@const last = i === steps.length - 1}
			<li
				class="relative flex gap-3 pb-4 last:pb-0"
				data-step-id={step.id}
				data-assist-model={step.assist?.model}
				data-assist-host={step.assist?.host}
				data-assist-host-label={step.assist?.hostLabel}
			>
				{#if !last}
					<span aria-hidden="true" class="absolute top-8 bottom-0 left-4 -translate-x-1/2 w-px bg-line-2"></span>
				{/if}
				<span
					aria-hidden="true"
					class="relative flex size-8 shrink-0 items-center justify-center rounded-pill border {dot[step.tone]}"
				>
					<Icon class="size-4" />
				</span>
				<div class="flex min-w-0 flex-1 flex-col gap-1 pt-1">
					<div class="flex items-baseline justify-between gap-3">
						<span class="type-body font-medium text-fg-1">
							<span class="sr-only">{m.message_stepNumber({ number: i + 1 })} </span>{step.title}
						</span>
						{#if step.ms}
							<span class="shrink-0 type-caption text-fg-3 tabular-nums">
								{step.timeLabel?.(seconds(step.ms))}
							</span>
						{/if}
					</div>
					<p class="type-body text-fg-2">{step.what}</p>
					{#if step.tone === 'note'}
						<span><Badge tone="caution">{m.message_stepWorthKnowing()}</Badge></span>
					{/if}
					{#if step.why}
						<p class="type-caption text-fg-3">{step.why}</p>
					{/if}
{#if step.code}
<pre class="max-h-64 overflow-auto rounded-sharp border border-line-1 bg-surface-2 p-2 type-caption text-fg-2 whitespace-pre-wrap" data-step-code>{step.code}</pre>
{/if}
{#if step.quote}
<blockquote class="border-l border-line-2 pl-3 type-caption text-fg-2" data-step-quote>“{step.quote}”</blockquote>
{/if}
{#if step.rules?.length}
<ul class="flex flex-wrap gap-1.5" aria-label={m.message_stepRulesChecked()} data-step-rules>
{#each step.rules as rule (rule.label)}
<li><Badge tone={rule.state === 'triggered' ? 'destructive' : rule.state === 'clear' ? 'positive' : 'outline'}>{rule.state === 'triggered'
	? m.message_ruleMatched({ rule: rule.label })
	: rule.state === 'clear'
		? m.message_ruleClear({ rule: rule.label })
		: m.message_ruleNotChecked({ rule: rule.label })}</Badge></li>
{/each}
</ul>
{/if}
					{#if step.sources?.length}
						<Collapsible.Root bind:open={() => openSources[step.id] ?? false, (v) => (openSources[step.id] = v)}>
							<Collapsible.Trigger>
								<RiArrowRightSLine class={openSources[step.id] ? 'rotate-90' : ''} aria-hidden="true" />
								{sourcesToggle(openSources[step.id] ?? false, step.sources.length)}
							</Collapsible.Trigger>
							<Collapsible.Panel>
								<ol class="flex flex-col gap-2 pt-1">
{#each step.sources as src (src.n)}
<li class="flex flex-col gap-0.5 border-l border-line-2 pl-3" data-step-source>
<span class="flex items-center gap-2 type-caption">
<span class="text-fg-3 tabular-nums">[{src.n}]</span>
{#if src.url}
<Favicon src={faviconSrc(src.url)} />
<a href={src.url} target="_blank" rel="noreferrer" class="min-w-0 truncate text-fg-1 underline decoration-line-3 underline-offset-2 hover:decoration-fg-1">{src.title || src.url}</a>
{:else}
<span class="min-w-0 truncate text-fg-1">{src.title}</span>
{/if}
</span>
<span class="type-caption text-fg-3">{src.from}{src.date ? ` · ${formatDay(src.date)}` : ''}{src.cited === true ? ` · ${m.message_sourceCited()}` : src.cited === false ? ` · ${m.message_sourceNotCited()}` : ''}</span>
{#if src.excerpt}
<p class="line-clamp-3 type-caption text-fg-2">“{src.excerpt}”</p>
{/if}
</li>
									{/each}
								</ol>
							</Collapsible.Panel>
						</Collapsible.Root>
					{/if}
				</div>
			</li>
		{/each}
	</ol>

	{#if !loading && facts.answered && !facts.declined && question && !facts.verified}
		<div class="flex flex-col gap-2 border-t border-line-1 pt-3" data-second-opinion-offer>
			<span class="type-body font-medium text-fg-1">{m.message_notSureTitle()}</span>
			<span class="type-caption text-fg-3">{m.message_notSureBody()}</span>
			<SecondOpinion {question} messageId={message.id} opinions={message.opinions} verdict={message.verdict} />
		</div>
	{/if}
</div>
