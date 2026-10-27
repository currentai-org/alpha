<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import { untrack, type Snippet } from 'svelte';
	import { on } from 'svelte/events';
	import { fly } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { dev } from '$app/environment';
	import { Badge, ComposerAccessory, Menu, Sheet, Ticker, buttonRecipe, cn, useCompact } from '@aipotluck/alpha-ds';
	import { catalog, catalogByGatewayId, orgs, servedKey, type CatalogModel } from '$lib/chat/routing/catalog';
	import { DIFFICULTY_LABEL } from '$lib/chat/routing/classifier';
	import { localLanguageName } from '$lib/chat/routing/languages';
	import { route, shownLanguage } from '$lib/chat/routing/router';
	import { languageSupport } from '$lib/chat/routing/benchmarks';
	import { AUTO, modelChoice, modelPickRequest, pickerChoice } from '$lib/chat/routing/choice';
	import { useDraftAnalysis } from '$lib/chat/routing/draftAnalysis.svelte';
	import { mergeClef } from '$lib/chat/routing/clef';
	import { readWithClef } from '$lib/chat/routing/remoteRead';
	import { busyHere, busyNow, keepServerBusyFresh, serverBusy, serverBusyNow } from '$lib/chat/routing/busyHere';
	import {
		activeBenchmarks,
		activeRoutingConfig,
		benchmarkOverride,
		dismissedGaps,
		autoRouteNote,
		nextTurnModel,
		pendingAutoRoute,
		recentLanguageGap
	} from '$lib/chat/routing/state';
	import { describeLocalServer, isLocalModelId, pickerDisplayName } from '$lib/chat/identity';
	import { page } from '$app/state';
	import { useSettingsStore } from '$lib/chat/stores/settings';
	import ProvenanceBreakdown from './ProvenanceBreakdown.svelte';
	import OrgLogo from './OrgLogo.svelte';
	import RoutingWhy from './RoutingWhy.svelte';
	import ClefCredit from './ClefCredit.svelte';
	import LanguageGapPanel from './LanguageGapPanel.svelte';
	import LanguageSupportPanel from './LanguageSupportPanel.svelte';
	import { languageCoverage } from '$lib/chat/routing/coverage';
	import { LAUNCH_LANGUAGES } from '$lib/chat/languageData';
	import RiTranslate2 from '~icons/ri/translate-2';
	import RiSeedlingLine from '~icons/ri/seedling-line';
	import RiSparkling2Line from '~icons/ri/sparkling-2-line';
	import RiShieldCheckLine from '~icons/ri/shield-check-line';
	import RiArrowDownSLine from '~icons/ri/arrow-down-s-line';
	import RiScan2Line from '~icons/ri/scan-2-line';
	import RiSpyLine from '~icons/ri/spy-line';
	import RiServerLine from '~icons/ri/server-line';
	import RiImageLine from '~icons/ri/image-line';
	import RiErrorWarningLine from '~icons/ri/error-warning-line';
	import type { Message } from '$lib/chat/types/Message';
	import type { EmbeddedIntent } from '$lib/chat/types/EmbeddedIntent';
	import { stackOpen, STACK_MAP_ENABLED } from '$lib/chat/stores/stack';
	import XRayComposerPanel from '../stack/XRayComposerPanel.svelte';

	/**
	 * The chat composer's accessory row (Recursive's composer pattern): a privacy pill that opens the
	 * provenance breakdown crediting the model maker, the host and Hugging Face's private storage, and
	 * the XRAY pill, and, with Auto on, a Languages pill whose panel explains how Auto picks a model
	 * and shows the languages the served models handle. The composer itself is `children`, handed the
	 * model picker — whose dropdown explains, in plain words, how Alpha picked a model, links to that
	 * panel, and has a flyout listing every model — to place inside its toolbar. Auto is behind the `auto-routing` flag: with it off the menu is just the list
	 * of models, and it reads and writes the model chosen in settings.
	 *
	 * With Auto on, the model is chosen per message, not per chat. Before the chat starts, Auto's pick (or a manual
	 * one) starts it. Mid-chat, with Auto on, the model that answered last carries on unless the next
	 * message is a clearly better fit for another one, and then Auto switches for that message. The
	 * last-used model sits above Auto, so staying on it is one tap. The choice is published as
	 * `nextTurnModel`, which the conversation page applies just before it sends; every answer records
	 * the model that wrote it.
	 */
	let {
		draft = '',
		currentModelId,
		servedIds,
		started = false,
		messages = [],
		loading = false,
		embeddedDemo = false,
		onEmbeddedNavigate,
		photoAttached = false,
		children
	}: {
		draft?: string;
		/** A photo is on the composer: with Auto choosing, only a model that reads photos is offered it. */
		photoAttached?: boolean;
		/** The model this chat uses (the conversation's, or the default before one starts). */
		currentModelId: string;
		/** Ids the registry serves now. */
		servedIds: string[];
		/** A conversation exists — the next message continues it. */
		started?: boolean;
		/** The conversation, for the XRAY panel. */
		messages?: Message[];
		loading?: boolean;
		/** The /alpha demo: links to the full app's pages report an intent instead of navigating. */
		embeddedDemo?: boolean;
		onEmbeddedNavigate?: (intent?: EmbeddedIntent) => void;
		/** The composer; receives the model picker to render in its toolbar. */
		children?: Snippet<[Snippet]>;
	} = $props();

	let open = $state<string | null>(null);
	let pickerOpen = $state(false);
	// Desktop: the model menu is layered over the message box — its right edge on the box's right edge,
	// its bottom on the box's bottom edge — so it reads as rising out of the composer rather than
	// floating above it. The anchor is a zero-height line along the box's bottom edge; the menu sits
	// on top of it (side="top", no offset).
	let pillEl = $state<HTMLButtonElement | null>(null);
	type Measurable = { getBoundingClientRect: () => DOMRect };
	let menuAnchor = $state<Measurable | null>(null);
	function composerBottomEdge(shell: HTMLElement): Measurable {
		return {
			getBoundingClientRect: () => {
				const r = shell.getBoundingClientRect();
				return new DOMRect(r.left, r.bottom, r.width, 0);
			}
		};
	}
	/** Closing the model menu hands focus to the message box rather than back to the pill: the next
	 *  thing anyone does after picking a model is type, and with the pill focused those keystrokes
	 *  went to the button (a space reopened the menu) and the first message was lost. */
	function focusComposer(e: Event) {
		const box = pillEl?.closest('[data-composer-accessory]')?.querySelector<HTMLTextAreaElement>('textarea');
		if (!box || box.disabled) return;
		e.preventDefault();
		box.focus();
	}
	const phone = useCompact();

	// XRAY follows the shared `stackOpen` store, so an answer's "How this was made" link and the
	// welcome CTA open the same panel as the pill does.
	// Two one-way syncs sharing `lastStack`, so neither echoes the other's write back.
	let lastStack = false;
	$effect(() => {
		const s = $stackOpen;
		untrack(() => {
			if (s === lastStack) return;
			lastStack = s;
			if (s) open = 'xray';
			else if (open === 'xray') open = null;
		});
	});
	$effect(() => {
		const want = open === 'xray';
		untrack(() => {
			if (want === lastStack) return;
			lastStack = want;
			stackOpen.set(want);
		});
	});

	const servedById = $derived(new Map(servedIds.map((id) => [servedKey(id), id])));
	const isServed = (gatewayId?: string) => !!gatewayId && servedById.has(servedKey(gatewayId));
	const servedId = (m: CatalogModel | undefined) => (m?.gatewayId ? servedById.get(servedKey(m.gatewayId)) : undefined);
	// Which served models read images, from the same list the composer offers photos by. A model that
	// doesn't is marked "Text only", but only where photos can be attached here and some model reads
	// them, since otherwise every model is text only and the mark says nothing.
	const imageReaders = $derived(
		new Set(
			((page.data.models ?? []) as { id: string; multimodal?: boolean }[])
				.filter((served) => served.multimodal === true)
				.map((served) => servedKey(served.id))
		)
	);
	const marksTextOnly = $derived(
		page.data.attachmentsEnabled === true && page.data.imageInputEnabled === true && imageReaders.size > 0
	);
	const readsImages = (model: CatalogModel | undefined) =>
		!!model?.gatewayId && imageReaders.has(servedKey(model.gatewayId));
	const textOnlyMark = (model: CatalogModel) =>
		marksTextOnly && !!model.gatewayId && !imageReaders.has(servedKey(model.gatewayId)) ? ` · ${m.product_textOnly()}` : '';

	// Auto is behind the `auto-routing` flag. Off, there is one model preference, the one Settings →
	// Models edits, so the picker reads and writes it and nothing here reads the draft.
	const settings = useSettingsStore();
	const autoOn = $derived(page.data.autoRoutingEnabled === true);
	// A local model's id IS its served id already (no gatewayId indirection, unlike a catalog entry —
	// see choose() below), so when it's the active model it has to be threaded through directly rather
	// than via catalogByGatewayId, which only ever resolves catalog entries.
	// A pick made in a started chat switches that chat from its next message on (CUR-3190). It is held
	// for the conversation it was made in, so opening another chat doesn't carry it over, and it still
	// becomes the default for new chats. With Auto on that default is the shared `modelChoice`, which a
	// started chat reads only when it is Auto itself: a model picked in another chat leaves this one on
	// its own model.
	let midChatPick = $state<{ conv: string; id: string } | null>(null);
	const convId = $derived(page.params.id);
	const pendingPick = $derived(started && convId && midChatPick?.conv === convId ? midChatPick.id : undefined);
	// The picker id of the model this chat uses: a local id as is, a catalog entry by its catalog id.
	const currentPickerId = $derived(
		isLocalModelId(currentModelId) ? currentModelId : catalogByGatewayId(currentModelId)?.id
	);
	const chosenId = $derived(
		started
			? (pendingPick ?? (autoOn && $modelChoice === AUTO ? AUTO : (currentPickerId ?? '')))
			: pickerChoice(
					autoOn,
					$modelChoice,
					isLocalModelId($settings.activeModel)
						? $settings.activeModel
						: catalogByGatewayId($settings.activeModel)?.id
				)
	);
	/** The served id for a picker id: a local id is its own; a catalog entry goes through the registry. */
	function servedIdFor(id: string): string | undefined {
		if (isLocalModelId(id)) return servedIds.includes(id) ? id : undefined;
		// The registry's own id (its casing), which is what settings validates against.
		const gatewayId = catalog.find((m) => m.id === id)?.gatewayId;
		return gatewayId ? servedById.get(servedKey(gatewayId)) : undefined;
	}
	// A pick asked for from elsewhere (a composer notice's "Use Mistral Large 3") goes through choose().
	$effect(() => {
		const requested = $modelPickRequest;
		if (!requested) return;
		untrack(() => choose(requested));
		modelPickRequest.set(null);
	});

	function choose(id: string) {
		if (autoOn) {
			if (started && convId) midChatPick = { conv: convId, id };
			modelChoice.set(id);
			// A picked model is the person's model everywhere, Settings included; Auto is what applies
			// until they pick one, so choosing Auto leaves the saved model as it was.
			const picked = id === AUTO ? undefined : servedIdFor(id);
			if (picked) void settings.instantSet({ activeModel: picked });
			return;
		}
		const match = servedIdFor(id);
		if (!match) return;
		if (started && convId) midChatPick = { conv: convId, id };
		void settings.instantSet({ activeModel: match });
	}

	// Whether this conversation is being answered on the person's own machine. Deliberately the same
	// signal ChatIntroduction's greeting reads (CUR-3037), so the pill and the "served from your own
	// local inference server" line can never disagree about the same session -- they are two
	// statements about one fact, and a user seeing one without the other would reasonably wonder
	// which to believe. Note this follows the CONVERSATION's model: picking a local model mid-chat
	// shows the marker once that turn has been answered, not at the moment of picking.
	const localInference = $derived(isLocalModelId(currentModelId));

	// The server's own name, and which route reaches it. The name is the label the person gave the
	// server when they added it: a local model's displayName is `${label}:${servedModelId}`
	// (localModels.ts), so everything before the first colon is the label. The kind decides which
	// route the panel describes -- a managed endpoint is reached through an encrypted tunnel, a
	// direct one is a URL this deployment dials over the network. Telling the wrong one would be a
	// privacy claim we cannot stand behind, so an unknown kind falls back to the direct wording,
	// which promises strictly less.
	const localServer = $derived.by(() => {
		if (!localInference) return null;
		const entry = page.data.models?.find(
			(m: { id: string }) => m.id === currentModelId
		) as { displayName?: string; localEndpointKind?: 'direct' | 'managed' } | undefined;
		return describeLocalServer(entry?.displayName, entry?.localEndpointKind);
	});

	// The model that answered last (the conversation's), or the default before one starts.
	const current = $derived(catalogByGatewayId(currentModelId));

	// Auto classifies the draft after each pause in typing, locally: language and dialect, task size,
	// likely skills. That picks the model, and a language none of the models handle well raises the
	// dataset call-to-action. With the `clef-routing` flag on, a longer pause also sends the draft to
	// Clef (routing/clef.ts), whose read is merged over the local one when it lands.
	const clefOn = untrack(() => page.data.clefRoutingEnabled === true);
	const draftAnalysis = useDraftAnalysis(() => draft, {
		publish: true,
		// Only while Auto is choosing: a model picked by hand needs no reading of the draft.
		remote: clefOn ? { read: readWithClef, merge: mergeClef, active: () => chosenId === AUTO } : undefined
	});
	const decision = $derived(autoOn ? draftAnalysis.current : undefined);
	const manual = $derived(chosenId === AUTO ? undefined : catalog.find((m) => m.id === chosenId));
	const manualServed = $derived(manual && isServed(manual.gatewayId) ? manual : undefined);
	// A photo on the composer narrows Auto to the models that read photos: a text-only model leaves the
	// photo out of what it is sent, so routing there would answer without it. Where none reads photos,
	// nothing changes (the composer offers no photos then).
	const photoRouting = $derived(autoOn && !manualServed && photoAttached && imageReaders.size > 0);
	const routedIds = $derived(
		photoRouting ? servedIds.filter((id) => imageReaders.has(servedKey(id))) : servedIds
	);
	// Models getting no answer through right now, by the server's mark (set by failed
	// turns and by the warm cron's probe) and by this tab's own failed turns. Auto routes around them; the
	// picker shows them as unavailable, and a hand pick stays where it is and says so before sending. (CUR-4043, CUR-4042)
	const busyIds = $derived(
		busyNow(serverBusyNow(page.data.busyModels as string[] | undefined, $serverBusy), $busyHere)
	);
	// An open tab re-reads the server's marks, so a model that goes down or comes back after
	// the page loaded is routed around, or chosen again, without a reload. (CUR-4629)
	$effect(() => {
		const everyMs = page.data.busyRefreshMs as number | null | undefined;
		if (page.data.autoRoutingEnabled === true && everyMs) return keepServerBusyFresh(everyMs);
	});
	const busyRowNote = $derived(m.routing_unavailableRow());
	const isBusy = (gatewayId?: string) => !!gatewayId && busyIds.some((id) => servedKey(id) === servedKey(gatewayId));
	const routeFor = (ids: string[]) =>
		decision
			? route(decision, ids, {
					benchmarks: $activeBenchmarks,
					config: $activeRoutingConfig,
					stickTo: started ? current?.id : undefined,
					busy: busyIds
				})
			: undefined;
	const choice = $derived(routeFor(routedIds));

	// A language none of the models handle well gets a pill left of Private, labelled with the language
	// and following the draft as it's detected. It goes (and its panel closes) once the draft is cleared
	// or moves to a well-covered language. The first time a language shows up on this device the
	// panel opens by itself (desktop only, and only when no other panel is open).
	const shownGap = $derived(choice?.gap ? { gap: choice.gap, scores: choice.scores } : undefined);
	$effect(() => {
		const g = choice?.gap;
		// The sidebar's "Get involved" card and the Contribute page follow the same signal, so they
		// return to their general copy once the draft is cleared or moves to a well-covered language.
		recentLanguageGap.set(g ?? null);
		untrack(() => {
			if (!g) {
				if (open === 'language') open = null;
				return;
			}
			if ($dismissedGaps.includes(g.tag)) return;
			dismissedGaps.update((d) => [...d, g.tag]);
			if (open === null && !phone.current) open = 'language';
		});
	});
	// A well-covered language for scale in the panel's chart: the best served support for English.
	const englishReference = $derived.by(() => {
		const served = catalog.filter((m) => m.status === 'live' && isServed(m.gatewayId));
		if (!served.length || shownGap?.gap.tag === 'eng') return undefined;
		const english = served
			.map((m) => languageSupport($activeBenchmarks, m.id, 'eng'))
			.reduce((a, b) => (b.value > a.value ? b : a));
		return { name: 'English', value: english.value, raw: english.measured?.raw };
	});
	// The language half is an estimate unless this message's language was measured.
	const placeholderScores = $derived(
		$activeBenchmarks.status === 'placeholder' && !choice?.scores.some((s) => s.languageVia === 'measured')
	);

	// Mid-chat: Auto's pick for this message, when it isn't the model that answered last.
	const better = $derived(
		started && !manual && choice && current && choice.model.id !== current.id ? choice.model : undefined
	);
	// With Auto on, Auto switches for that message (the continuity bonus already keeps the last model
	// unless another is clearly better).
	const switching = $derived(!!better);

	// With a photo attached and no draft yet to route on, Auto still moves off a text-only model: the
	// first served model that reads photos.
	const photoReader = $derived(
		photoRouting
			? catalog.find((m) => m.status === 'live' && isServed(m.gatewayId) && readsImages(m))
			: undefined
	);
	const autoNext = $derived<CatalogModel | undefined>(
		manualServed ?? (switching ? better : started ? current : choice?.model) ?? current
	);

	/** The model the next message goes to. */
	const next = $derived<CatalogModel | undefined>(
		autoOn
			? photoRouting && !readsImages(autoNext)
				? (photoReader ?? autoNext)
				: autoNext
			: started
				? (pendingPick ? catalog.find((m) => m.id === pendingPick) : current)
				: (manualServed ?? current)
	);
	// What Auto would have picked without the photo, so the switch can say why it happened.
	const withoutPhoto = $derived.by(() => {
		if (!photoRouting) return undefined;
		const plain = routeFor(servedIds)?.model;
		const plainBetter = started && plain && current && plain.id !== current.id ? plain : undefined;
		return plainBetter ?? (started ? current : plain) ?? current;
	});
	const photoSwitch = $derived(
		photoRouting && next && withoutPhoto && next.id !== withoutPhoto.id && !readsImages(withoutPhoto)
			? { from: withoutPhoto, to: next }
			: undefined
	);

	// Publish the mid-chat choice for the conversation page to apply before sending. A pick the
	// person made holds for whatever they send; Auto's own switch holds only for the draft it judged.
	$effect(() => {
		if (!started) return nextTurnModel.set(null);
		if (!autoOn) {
			const id = pendingPick ? servedIdFor(pendingPick) : undefined;
			if (!id || id.toLowerCase() === currentModelId.toLowerCase()) return nextTurnModel.set(null);
			return nextTurnModel.set({ modelId: id });
		}
		const id = servedId(next);
		if (!id || id.toLowerCase() === currentModelId.toLowerCase()) return nextTurnModel.set(null);
		// A switch made for the photo holds for whatever is sent with it, like a pick, not only for this draft.
		nextTurnModel.set(manualServed || photoSwitch ? { modelId: id } : { modelId: id, text: draftAnalysis.text });
	});

	// mid-chat, Auto's choice for the draft travels with it, so the answer's X-ray can say Auto
	// chose the model and why. The landing page records the first message's choice itself.
	// An empty draft leaves the choice alone: it is the message just sent, which the conversation page
	// reads after this effect has run (the landing's first message, and a send awaiting the PATCH). (CUR-3944)
	$effect(() => {
		if (!started) return;
		if (!autoOn || manualServed) return pendingAutoRoute.set(null);
		if (!choice || !draftAnalysis.text) return;
		pendingAutoRoute.set({ text: draftAnalysis.text, note: autoRouteNote(choice) });
	});

	// Mid-chat, the model that answered last gets its own row above Auto: picking it stays on it.
	const lastUsed = $derived(autoOn && started && current && isServed(current.gatewayId) ? current : undefined);

	// What the privacy panel describes: the model that will answer the next message.
	const forecast = $derived(next);

	// Sparkles mean Auto is choosing. A model picked by hand shows its maker's mark instead, the same
	// one its row in the picker shows, and a local model its server.
	const pillAuto = $derived(autoOn && chosenId === AUTO);
	const pillLocal = $derived(!pillAuto && isLocalModelId(chosenId));
	const pillModel = $derived(pillAuto || pillLocal ? undefined : !autoOn && started ? next : (manual ?? current));

	const pillLabel = $derived.by(() => {
		// With Auto off the pill names the exact model (two Apertus sizes share a family).
		if (!autoOn) return started ? (next?.family ?? m.product_model()) : (manual?.name ?? current?.name ?? m.product_model());
		if (manual) return manual.family;
		if (started) return switching && next ? `${m.product_auto()} · ${next.family}` : (current?.family ?? m.product_model());
		const lang = decision ? shownLanguage(decision) : 'und';
		return lang !== 'und' ? `${m.product_auto()} · ${localLanguageName(lang, getLocale())}` : m.product_auto();
	});

	// A model that isn't offered (CUR-2763) is listed only where this deployment defaults to it (a CI
	// ticket-branch preview, whose allowlist puts it first) or in a conversation it is already serving.
	const deploymentDefault = $derived(servedIds[0] ? servedKey(servedIds[0]) : undefined);
	const listed = (m: (typeof catalog)[number]) =>
		m.offered !== false ||
		(!!m.gatewayId && servedKey(m.gatewayId) === deploymentDefault) ||
		(started && m.id === current?.id);
	const available = $derived(catalog.filter((m) => m.status === 'live' && isServed(m.gatewayId) && listed(m)));
	// Models Alpha can't serve yet are a roadmap for the team, not a choice: dev builds only.
	const upcoming = $derived(
		dev ? catalog.filter((m) => m.offered !== false && !(m.status === 'live' && isServed(m.gatewayId))) : []
	);
	const statusLabel = { live: 'Not switched on', 'in-progress': 'In progress', stub: 'Coming soon' } as const;

	// Per-user local (LAN/self-hosted) endpoints never enter the shared, static `catalog` — there's no
	// org/gatewayId concept for a per-user server — so they get their own section here rather than
	// synthetic entries folded into `catalog` itself, which every OTHER `catalog` consumer (marketing
	// bentos, vignettes, the data-home credits page) assumes is the fixed public roster. `servedIds`
	// already carries local ids verbatim (see choose() above); this just picks them out and looks up a
	// display name from the same page data ChatWindow itself reads to build `servedIds`.
	const localModels = $derived(
		servedIds
			.filter(isLocalModelId)
			.map((id) => {
				const displayName = page.data.models?.find((m: { id: string }) => m.id === id)?.displayName ?? id;
				return { id, name: pickerDisplayName({ id, displayName }) };
			})
	);

	// Language × effort preview: sample pairs cycle until there's a draft to classify.
	const SAMPLES = [
		{ language: 'English', effort: 'Quick question' },
		{ language: 'Català', effort: 'Pregunta ràpida' },
		{ language: 'Deutsch', effort: 'Braucht Sorgfalt' },
		{ language: 'Bahasa Indonesia', effort: 'Pertanyaan sehari-hari' },
		{ language: 'Français', effort: 'Demande réfléchie' },
		{ language: 'Tiếng Việt', effort: 'Câu hỏi nhanh' },
		{ language: 'Polski', effort: 'Wymaga namysłu' },
		{ language: 'Español', effort: 'Pregunta cotidiana' }
	];
	let sampleIndex = $state(0);
	const reduceMotion = $derived(prefersReducedMotion.current);
	$effect(() => {
		if (decision || reduceMotion || started) return;
		const t = setInterval(() => (sampleIndex = (sampleIndex + 1) % SAMPLES.length), 2200);
		return () => clearInterval(t);
	});
	const preview = $derived<{ language: string; effort: string; model?: CatalogModel }>(
		decision && choice
			? {
					language: shownLanguage(decision) === 'und' ? m.product_anyLanguage() : localLanguageName(shownLanguage(decision), getLocale()),
					effort: `${choice.model.family} · ${DIFFICULTY_LABEL[decision.difficulty.value]}`,
					model: choice.model
				}
			: SAMPLES[sampleIndex]
	);
	const previewKey = $derived(`${preview.language}|${preview.effort}`);

	// The Languages pill: the model Auto picks for each of Alpha's launch languages (the A2 list, the
	// languages Alpha says it supports), and (while Auto is choosing) its read of the draft. It reads the
	// busy marks as a sorted key, so the server's minute-by-minute re-read recomputes it only when the
	// set of busy models changes, and never on typing.
	const busyKey = $derived([...new Set(busyIds.map(servedKey))].sort().join(','));
	const coverage = $derived(
		languageCoverage(
			servedIds,
			{
				benchmarks: $activeBenchmarks,
				config: $activeRoutingConfig,
				busy: busyKey ? busyKey.split(',') : []
			},
			(tag) => localLanguageName(tag, getLocale()),
			LAUNCH_LANGUAGES
		)
	);
	const languagesOn = $derived(autoOn && coverage.strong.length > 0);
	const liveRead = $derived(
		chosenId === AUTO && decision && choice && shownLanguage(decision) !== 'und'
			? { tag: shownLanguage(decision), model: choice.model }
			: undefined
	);
	// The Language pill names the language Auto reads in the draft, whichever it is. A language Alpha
	// is still learning already has its own pill with its name, so this one stays "Language" then.
	const languagePillText = $derived(
		liveRead && !shownGap ? localLanguageName(liveRead.tag, getLocale()) : m.product_languagesPill()
	);

	// Inside the composer the picker is a quiet ghost control (the composer's model selector), not
	// a bordered accessory pill: the name and a chevron, a tint on hover and while open.
	const modelTrigger = cn(
		buttonRecipe({ variant: 'ghost', size: 'sm', shape: 'pill', casing: 'sentence' }),
		'route-notice min-w-0 max-w-40 gap-1 px-2 type-caption [&_svg]:size-3.5 aria-expanded:bg-tint-active aria-expanded:text-fg-1'
	);

	// With Auto choosing, a new read of the draft that changes what the pill says, or the model the
	// message goes to, plays the pill's notice once (`route-notice`), so a switch made while the
	// person types isn't missed. A read landing mid-notice joins the one already playing; none plays
	// while the picker is open (it already shows the read) or under reduced motion. The draft the
	// composer mounted with isn't new, so its read lands quietly.
	const mountedDraft = untrack(() => draft);
	const autoRead = $derived(pillAuto && decision && choice ? `${pillLabel}|${next?.id ?? ''}` : undefined);
	let noticing = $state(false);
	let lastRead: string | undefined;
	$effect(() => {
		const read = autoRead;
		const changed = read !== lastRead;
		lastRead = read;
		if (!read || !changed) return;
		untrack(() => {
			if (draft === mountedDraft || noticing || reduceMotion || pickerOpen || pillEl?.getAttribute('aria-expanded') === 'true') return;
			noticing = true;
		});
	});
	// Ends with the notice, or when opening the picker cuts it short.
	$effect(() => {
		if (!pillEl) return;
		const done = (e: AnimationEvent) => {
			if (e.animationName === 'ds-route-notice') noticing = false;
		};
		const stops = [on(pillEl, 'animationend', done), on(pillEl, 'animationcancel', done)];
		return () => stops.forEach((stop) => stop());
	});

	// Pressing the button opens the menu over it (its bottom edge is the composer's), so the end of the
	// gesture lands on its last row and activates it: the release of a mouse press, or the click that
	// follows a tap. The menu ignores the pointer until the gesture is over.
	let pressing = $state(false);
	function holdMenuStill(e: PointerEvent) {
		pressing = true;
		const stops = [
			on(window, e.pointerType === 'mouse' ? 'pointerup' : 'click', release, { capture: true }),
			on(window, 'pointercancel', release, { capture: true })
		];
		// A tap that never becomes a click (the finger slid off) still releases the menu.
		const fallback = setTimeout(release, 800);
		function release() {
			pressing = false;
			clearTimeout(fallback);
			for (const stop of stops) stop();
		}
	}
</script>

{#snippet howWeChose()}
	<!-- No box: a quiet block under Auto. Before a chat starts, a "language × task size" line cycles
	     samples until you type; once you type it shows what Alpha detected. Mid-chat there's nothing
	     to preview until the next message is being written. -->
	{#if !started || (decision && choice) || $benchmarkOverride}
	<div class="flex flex-col gap-2 px-2 pt-1 pb-2" data-how-we-chose>
		{#if (decision && choice) || !started}
			<div class="relative h-7 overflow-hidden" aria-hidden="true" data-language-preview>
				{#key previewKey}
					<span
						class="absolute inset-0 flex items-center gap-2"
						in:fly={{ y: reduceMotion ? 0 : 14, duration: reduceMotion ? 0 : 320, opacity: 0 }}
						out:fly={{ y: reduceMotion ? 0 : -14, duration: reduceMotion ? 0 : 240, opacity: 0 }}
					>
						<span class="border border-line-2 px-1.5 py-0.5 type-label text-fg-2 rounded-sharp">{preview.language}</span>
						<span class="flex min-w-0 items-center gap-1.5 type-body text-fg-1">
							{#if preview.model}<OrgLogo org={orgs[preview.model.maker]} size="xs" />{/if}
							<span class="truncate">{preview.effort}</span>
						</span>
					</span>
				{/key}
			</div>
		{/if}
		{#if decision && choice}
			<RoutingWhy
				analysis={decision}
				{choice}
				pending={draftAnalysis.pending}
				refining={draftAnalysis.refining}
				placeholder={placeholderScores}
			/>
		{:else if !started}
			<p class="type-caption text-fg-2">
				{clefOn ? m.product_autoStartClef() : m.product_autoStartDevice()}
			</p>
		{/if}
		{#if clefOn}
			<ClefCredit
				classifier={decision?.source === 'remote' ? decision.classifier : undefined}
				tabindex={phone.current ? undefined : -1}
			/>
		{/if}
		{#if $benchmarkOverride}
			<p class="type-caption text-caution-text" data-routing-override>Using your edited benchmark scores on this device.</p>
		{/if}
	</div>
	{/if}
{/snippet}

{#snippet nextSwitch()}
	<!-- Mid-chat, and only when the next message goes to a different model than the last answer. -->
	{#if started && next && current && next.id !== current.id}
		<!-- Two models of one family need their own names, or it reads "goes to Mistral, not Mistral". -->
		{@const sameFamily = next.family === current.family}
		<p class="flex items-center gap-2 px-2 py-2 type-caption text-fg-2" data-model-next-switch>
			<OrgLogo org={orgs[next.maker]} size="sm" />
			<span>Next message goes to <span class="text-fg-1">{sameFamily ? next.name : next.family}</span>, not {sameFamily ? current.name : current.family}.</span>
		</p>
	{/if}
{/snippet}

{#snippet modelRow(m: (typeof catalog)[number], enabled: boolean)}
	<button
		type="button"
		role="radio"
		aria-checked={chosenId === m.id}
		data-model-id={m.gatewayId}
		disabled={!enabled}
		onclick={() => {
			choose(m.id);
			pickerOpen = false;
		}}
		class="flex min-h-control-lg w-full items-center gap-3 px-3 py-2 text-left rounded-sharp transition-control hover:bg-tint-subtle aria-checked:bg-tint-hover disabled:opacity-50"
	>
		<OrgLogo org={orgs[m.maker]} size="sm" />
		<span class="flex min-w-0 flex-1 flex-col">
			<span class="truncate type-body text-fg-1">{m.name}</span>
			<span class="min-w-0 type-caption text-fg-3"
				><Ticker>{orgs[m.maker].name}{enabled ? textOnlyMark(m) : ` · ${statusLabel[m.status]}`}</Ticker></span
			>
			<!-- CUR-4043: still pickable, and a hand pick stays on it; the note says why Auto is going elsewhere. -->
			{#if enabled && isBusy(m.gatewayId)}<span class="type-caption text-caution-text" data-model-busy data-model-unavailable>{busyRowNote}</span>{/if}
		</span>
		{#if chosenId === m.id}<span class="size-1.5 bg-fg-1 rounded-pill" aria-hidden="true"></span>{/if}
	</button>
{/snippet}

{#snippet localModelRow(lm: { id: string; name: string })}
	<button
		type="button"
		role="radio"
		aria-checked={chosenId === lm.id}
		data-model-id={lm.id}
		onclick={() => {
			choose(lm.id);
			pickerOpen = false;
		}}
		class="flex min-h-control-lg w-full items-center gap-3 px-3 py-2 text-left rounded-sharp transition-control hover:bg-tint-subtle aria-checked:bg-tint-hover"
	>
		<RiServerLine aria-hidden="true" class="size-5 shrink-0 text-fg-2" />
		<span class="flex min-w-0 flex-1 flex-col">
			<span class="truncate type-body text-fg-1">{lm.name}</span>
			<span class="truncate type-caption text-fg-3">{m.product_localServer()}</span>
		</span>
		{#if chosenId === lm.id}<span class="size-1.5 bg-fg-1 rounded-pill" aria-hidden="true"></span>{/if}
	</button>
{/snippet}

{#snippet desktopModels()}
	<Menu.RadioGroup value={chosenId} onValueChange={choose}>
		<Menu.GroupLabel>{m.product_available()}</Menu.GroupLabel>
		{#each available as m (m.id)}
			<Menu.RadioItem value={m.id} data-model-id={m.gatewayId}>
				<OrgLogo org={orgs[m.maker]} size="sm" />
				<span class="flex min-w-0 flex-col">
					<span class="truncate">{m.name}</span>
					<span class="min-w-0 type-caption text-fg-3"><Ticker>{orgs[m.maker].name}{textOnlyMark(m)}</Ticker></span>
					{#if isBusy(m.gatewayId)}<span class="type-caption text-caution-text" data-model-busy data-model-unavailable>{busyRowNote}</span>{/if}
				</span>
			</Menu.RadioItem>
		{/each}
		{#if localModels.length}
			<Menu.Separator />
			<Menu.GroupLabel>{m.product_availableLocally()}</Menu.GroupLabel>
			{#each localModels as lm (lm.id)}
				<Menu.RadioItem value={lm.id} data-model-id={lm.id}>
					<RiServerLine aria-hidden="true" class="size-5 shrink-0 text-fg-2" />
					<span class="flex min-w-0 flex-col">
						<span class="truncate">{lm.name}</span>
						<span class="truncate type-caption text-fg-3">{m.product_localServer()}</span>
					</span>
				</Menu.RadioItem>
			{/each}
		{/if}
		{#if upcoming.length}
			<Menu.Separator />
			<Menu.GroupLabel class="flex items-center gap-2">{m.product_notAvailable()} <Badge>Dev</Badge></Menu.GroupLabel>
			{#each upcoming as m (m.id)}
				<Menu.RadioItem value={m.id} disabled>
					<OrgLogo org={orgs[m.maker]} size="sm" />
					<span class="flex min-w-0 flex-col">
						<span class="truncate">{m.name}</span>
						<span class="min-w-0 type-caption text-fg-3"><Ticker>{orgs[m.maker].name} · {statusLabel[m.status]}</Ticker></span>
					</span>
				</Menu.RadioItem>
			{/each}
		{/if}
	</Menu.RadioGroup>
{/snippet}

{#snippet pillContent()}
	{#if pillAuto}
		<RiSparkling2Line aria-hidden="true" />
	{:else if pillLocal}
		<RiServerLine aria-hidden="true" />
	{:else if pillModel}
		<OrgLogo org={orgs[pillModel.maker]} size="xs" class="size-3.5" />
	{/if}
	<span class="min-w-0 truncate">{pillLabel}</span>
	<RiArrowDownSLine aria-hidden="true" class="text-fg-3" />
{/snippet}

{#snippet modelPicker()}
	{#if phone.current}
		<!-- Phones: the picker is a bottom sheet — Auto, how we chose, then every model in one list. -->
		<button
			type="button"
			class={modelTrigger}
			aria-label={m.product_modelAria({ name: pillLabel, detail: autoOn ? m.product_howChooses() : '' })}
			data-model-pill
			data-noticing={noticing || undefined}
			bind:this={pillEl}
			onclick={() => {
				open = null;
				pickerOpen = true;
			}}
		>
			{@render pillContent()}
		</button>
		<Sheet.Root bind:open={pickerOpen}>
			<Sheet.Portal>
				<Sheet.Backdrop />
				<Sheet.Popup data-model-sheet onCloseAutoFocus={focusComposer}>
					<Sheet.Header title={m.product_model()} />
					<Sheet.Body class="gap-3">
						{@render nextSwitch()}
						<div role="radiogroup" aria-label={m.product_model()} class="flex flex-col gap-1">
							{#if autoOn}
								{#if lastUsed}
									<button
										type="button"
										role="radio"
										aria-checked={$modelChoice === lastUsed.id}
										onclick={() => lastUsed && modelChoice.set(lastUsed.id)}
										class="flex min-h-control-lg w-full items-center gap-3 px-3 py-2 text-left rounded-sharp transition-control hover:bg-tint-subtle aria-checked:bg-tint-hover"
										data-model-last-used
									>
										<OrgLogo org={orgs[lastUsed.maker]} size="sm" />
										<span class="flex min-w-0 flex-1 flex-col">
											<span class="type-body text-fg-1">{lastUsed.name}</span>
											<span class="type-caption text-fg-3">{m.product_lastUsed()}</span>
										</span>
										{#if $modelChoice === lastUsed.id}<span class="size-1.5 bg-fg-1 rounded-pill" aria-hidden="true"></span>{/if}
									</button>
								{/if}
								<button
									type="button"
									role="radio"
									aria-checked={$modelChoice === AUTO}
									onclick={() => modelChoice.set(AUTO)}
									class="flex min-h-control-lg w-full items-center gap-3 px-3 py-2 text-left rounded-sharp transition-control hover:bg-tint-subtle aria-checked:bg-tint-hover"
								>
									<RiSparkling2Line aria-hidden="true" class="size-5 shrink-0 text-fg-2" />
									<span class="flex min-w-0 flex-1 flex-col">
										<span class="type-body text-fg-1">{m.product_auto()}</span>
										<span class="type-caption text-fg-3">{m.product_autoModelHelp()}</span>
									</span>
									{#if $modelChoice === AUTO}<span class="size-1.5 bg-fg-1 rounded-pill" aria-hidden="true"></span>{/if}
								</button>
								{#if $modelChoice === AUTO}
									{@render howWeChose()}
								{/if}
								{#if languagesOn}
									<button
										type="button"
										onclick={() => {
											pickerOpen = false;
											open = 'languages';
										}}
										class="flex min-h-control-lg w-full items-center gap-3 px-3 text-left type-body text-fg-2 rounded-sharp hover:bg-tint-subtle hover:text-fg-1"
										data-languages-link
									>
										<RiTranslate2 aria-hidden="true" class="size-4" /> {m.product_languagesHowAuto()}
									</button>
								{/if}
							{/if}
							<p class="px-3 pt-3 type-label text-fg-3">{m.product_available()}</p>
							{#each available as m (m.id)}{@render modelRow(m, true)}{/each}
							{#if localModels.length}
								<p class="px-3 pt-3 type-label text-fg-3">{m.product_availableLocally()}</p>
								{#each localModels as m (m.id)}{@render localModelRow(m)}{/each}
							{/if}
							{#if upcoming.length}
								<p class="flex items-center gap-2 px-3 pt-3 type-label text-fg-3">{m.product_notAvailable()} <Badge>Dev</Badge></p>
								{#each upcoming as m (m.id)}{@render modelRow(m, false)}{/each}
							{/if}
						</div>
					</Sheet.Body>
				</Sheet.Popup>
			</Sheet.Portal>
		</Sheet.Root>
	{:else}
	<Menu.Root
		onOpenChange={(o) => {
			if (!o) return;
			open = null;
			const shell = pillEl?.closest('[data-composer-accessory]')?.querySelector<HTMLElement>('.composer-shell');
			menuAnchor = shell ? composerBottomEdge(shell) : null;
		}}
	>
		<Menu.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					bind:this={pillEl}
					onpointerdown={(e) => {
						holdMenuStill(e);
						(props.onpointerdown as ((e: PointerEvent) => void) | undefined)?.(e);
					}}
					type="button"
					class={modelTrigger}
					aria-label={m.product_modelAria({ name: pillLabel, detail: autoOn ? m.product_howChooses() : '' })}
					data-model-pill
					data-noticing={noticing || undefined}
				>
					{@render pillContent()}
				</button>
			{/snippet}
		</Menu.Trigger>
		<Menu.Portal>
			<Menu.Positioner side="top" align="end" sideOffset={0}>
				<Menu.Popup class={cn('w-80', pressing && 'pointer-events-none!')} customAnchor={menuAnchor} onCloseAutoFocus={focusComposer}>
					{#if started && next && current && next.id !== current.id}
						{@render nextSwitch()}
						<Menu.Separator />
					{/if}
					{#if autoOn}
						<!-- Through choose(), so going back to Auto or staying on the last-used model holds for this chat too. -->
						<Menu.RadioGroup value={started ? chosenId : $modelChoice} onValueChange={choose}>
							{#if lastUsed}
								<!-- Mid-chat: the model that answered last, above Auto; one tap stays on it. -->
								<Menu.RadioItem value={lastUsed.id} data-model-last-used>
									<OrgLogo org={orgs[lastUsed.maker]} size="sm" />
									<span class="flex min-w-0 flex-col">
										<span class="truncate">{lastUsed.name}</span>
										<span class="truncate type-caption text-fg-3">{m.product_lastUsed()}</span>
									</span>
								</Menu.RadioItem>
							{/if}
							<Menu.RadioItem value={AUTO} closeOnSelect={false}>
								<span class="flex flex-col">
									<span>{m.product_auto()}</span>
									<span class="type-caption text-fg-3">{m.product_autoModelHelp()}</span>
								</span>
							</Menu.RadioItem>
						</Menu.RadioGroup>
						{#if $modelChoice === AUTO}
							{@render howWeChose()}
						{/if}
						{#if languagesOn}
							<Menu.Item onSelect={() => (open = 'languages')} data-languages-link>
								<RiTranslate2 aria-hidden="true" />
								{m.product_languagesHowAuto()}
							</Menu.Item>
						{/if}
						<Menu.Separator />
						<Menu.SubmenuRoot>
							<Menu.SubmenuTrigger>{m.product_chooseModel()}</Menu.SubmenuTrigger>
							<Menu.Portal>
								<Menu.Positioner>
									<Menu.Popup class="w-72">{@render desktopModels()}</Menu.Popup>
								</Menu.Positioner>
							</Menu.Portal>
						</Menu.SubmenuRoot>
					{:else}
						{#if started}
							<div class="flex flex-col gap-1 px-2 py-2">
								<p class="type-body text-fg-1">{m.product_currentChatModel({ model: current?.family ?? m.product_model() })}</p>
								<p class="type-caption text-fg-3">{m.product_nextChatChoice()}</p>
							</div>
							<Menu.Separator />
						{/if}
						{@render desktopModels()}
					{/if}
				</Menu.Popup>
			</Menu.Positioner>
		</Menu.Portal>
	</Menu.Root>
	{/if}
{/snippet}

<ComposerAccessory.Root bind:open>
	<ComposerAccessory.Panel value="privacy" label={m.product_whereMessageGoes()}>
		<h2 class="pr-8 type-caption text-fg-2 max-md:hidden">{m.product_whereMessageGoes()}</h2>
		<ProvenanceBreakdown
			model={forecast}
			signedIn={Boolean(page.data.user)}
			draftReadBy={clefOn && chosenId === AUTO ? 'Clef' : undefined}
		/>
	</ComposerAccessory.Panel>

	{#if localInference && localServer}
		<!-- CUR-3037. Written for someone who cares about privacy and does not read architecture
		     diagrams, so it walks the route the message actually takes rather than naming components.

		     Tense follows `started`, because the empty state is where most people meet this panel and
		     "this reply was written by" is plainly wrong when there is no reply yet. Only the two
		     sentences that refer to a specific message switch: the numbered steps stay in a timeless
		     present ("travels", "sends", "writes"), which reads correctly either way, and the heading
		     names the mode rather than an event.
		     The closing paragraph is the important one: "local" changes WHO RUNS THE MODEL, not
		     whether Alpha handles the message, and a panel that let someone believe otherwise would
		     be worse than no panel at all. -->
		<ComposerAccessory.Panel value="local" label="Local — answered on your own computer" title="Local">
			<h2 class="pr-8 type-caption text-fg-2 max-md:hidden">Answered on your own computer</h2>
			<p class="type-body text-fg-1">
				{#if started}
					This reply was written by <strong>{localServer.name}</strong>, your own computer, rather
					than by an AI provider's servers.
				{:else}
					Your message will be answered by <strong>{localServer.name}</strong>, your own computer,
					rather than by an AI provider's servers.
				{/if}
			</p>

			<p class="type-caption text-fg-2">
				Where your message {started ? 'went' : 'will go'}
			</p>
			<ol class="flex list-decimal flex-col gap-2 pl-5 type-body text-fg-1">
				<li>
					<strong>Your browser to Alpha.</strong> Your message travels over an encrypted
					connection, the same way any website receives what you type.
				</li>
				{#if localServer.managed}
					<li>
						<strong>Alpha to your computer.</strong> Instead of handing it to an AI provider,
						Alpha sends it back to you through a private encrypted tunnel — WireGuard, the
						technology commercial VPNs are built on. Your computer opened that tunnel by dialling
						out, so nothing on your home network had to be exposed to the internet.
					</li>
				{:else}
					<li>
						<strong>Alpha to your computer</strong>, at the address you entered for this server.
						There is no tunnel on this route: Alpha connects to your machine over the network
						directly.
					</li>
				{/if}
				<li>
					<strong>Your computer writes the reply</strong>, using the model running on your own
					hardware, and sends it back the same way.
				</li>
			</ol>

			<hr class="border-line-surface" />
			<p class="type-caption text-fg-2">
				<strong class="text-fg-1">What this means:</strong> no outside AI provider ever receives
				this conversation.
			</p>
			<p class="type-caption text-fg-2">
				<strong class="text-fg-1">What it doesn't mean:</strong> your messages still pass through
				Alpha's servers on the way to and from your computer, and the conversation is saved to
				your account until you delete it. Running the model locally changes who runs the model,
				not whether Alpha handles the message.
			</p>
		</ComposerAccessory.Panel>
	{/if}

	{#if STACK_MAP_ENABLED}
		<ComposerAccessory.Panel value="xray" tone="xray" label={m.product_xrayAnswer()} title={m.product_xray()}>
			<XRayComposerPanel {messages} {loading} conversationModelId={currentModelId} />
		</ComposerAccessory.Panel>
	{/if}

	{#if languagesOn}
		<ComposerAccessory.Panel value="languages" label={m.product_languagesSee()} title={m.product_languagesPill()}>
			<LanguageSupportPanel
				{coverage}
				placeholder={$activeBenchmarks.status === 'placeholder'}
				live={liveRead}
				{embeddedDemo}
				{onEmbeddedNavigate}
			/>
		</ComposerAccessory.Panel>
	{/if}

	{#if shownGap}
		<ComposerAccessory.Panel value="language" tone="seed" label={m.product_learningLanguage({ language: shownGap.gap.name })} title={shownGap.gap.name}>
			<LanguageGapPanel
				gap={shownGap.gap}
				scores={shownGap.scores}
				weakSupport={$activeRoutingConfig.weakSupport}
				reference={englishReference}
				placeholder={placeholderScores}
				{embeddedDemo}
				{onEmbeddedNavigate}
			/>
		</ComposerAccessory.Panel>
	{/if}


	{#if next && isBusy(next.gatewayId)}
		<!-- CUR-4042: the next message goes to a model that is getting no answers through (picked by hand,
		     or every other model is unavailable too). Said before sending; the pick itself never moves. -->
		<ComposerAccessory.Notice icon={RiErrorWarningLine} data-model-unavailable-notice>
			{m.routing_unavailablePick({ model: next.name })}
		</ComposerAccessory.Notice>
	{/if}
	{#if photoSwitch}
		<!-- Auto moved off a model that can't read the attached photo; say so where the composer is. -->
		<ComposerAccessory.Notice icon={RiImageLine} data-testid="auto-photo-switch">
			{m.product_autoPickedForPhoto({ model: photoSwitch.to.name, from: photoSwitch.from.name })}
		</ComposerAccessory.Notice>
	{/if}
	{@render children?.(modelPicker)}

	<ComposerAccessory.Row>
		{#if shownGap}
			<ComposerAccessory.Pill
				value="language"
				tone="seed"
				icon={RiSeedlingLine}
				label={m.product_learningHelp({ language: shownGap.gap.name })}
			>
				{shownGap.gap.name}
			</ComposerAccessory.Pill>
		{/if}
		<ComposerAccessory.Pill value="privacy" icon={RiShieldCheckLine} label={m.product_whereMessageGoes()}>
			{m.product_whereItGoes()}
		</ComposerAccessory.Pill>
		{#if localInference}
			<ComposerAccessory.Pill
				value="local"
				icon={RiSpyLine}
				label="Local — this conversation is answered on your own machine"
			>
				Local
			</ComposerAccessory.Pill>
		{/if}
		{#if languagesOn}
			<ComposerAccessory.Pill value="languages" icon={RiTranslate2} label={m.product_languagesSee()}>
				{languagePillText}
			</ComposerAccessory.Pill>
		{/if}
		{#if STACK_MAP_ENABLED}
			<ComposerAccessory.Pill value="xray" tone="xray" icon={RiScan2Line} label={m.product_xraySee()}>
				{m.product_xray()}
			</ComposerAccessory.Pill>
		{/if}
	</ComposerAccessory.Row>
</ComposerAccessory.Root>
