import { m } from '$lib/paraglide/messages.js';
import type { Component } from 'svelte';
import { writable } from 'svelte/store';
import { dev } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { base } from '$lib/chat/paths';
import RiPaletteLine from '~icons/ri/palette-line';
import RiUserHeartLine from '~icons/ri/user-heart-line';
import RiShieldUserLine from '~icons/ri/shield-user-line';
import RiUserLine from '~icons/ri/user-line';
import RiTeamLine from '~icons/ri/team-line';
import RiServerLine from '~icons/ri/server-line';
import RiFolderLine from '~icons/ri/folder-line';
import RiSparkling2Line from '~icons/ri/sparkling-2-line';
import RiFlaskLine from '~icons/ri/flask-line';
import RiHandHeartLine from '~icons/ri/hand-heart-line';
import RiChatCheckLine from '~icons/ri/chat-check-line';
import RiInformationLine from '~icons/ri/information-line';
import RiPulseLine from '~icons/ri/pulse-line';
import RiFlagLine from '~icons/ri/flag-line';
import RiPlugLine from '~icons/ri/plug-line';
import RiLinksLine from '~icons/ri/links-line';

/**
 * The settings section list, shared by the places that render it: the sidebar (which becomes the
 * settings nav while a settings route is open) and the phone-width section
 * list. Two groups: the person's own settings, then "Potluck" — how Alpha picks models, and how to
 * help fill its gaps. Each entry's visibility mirrors its page's own gate, so a hidden entry never
 * hides a live page or links to a dead one.
 */
export type SettingsGroup = 'settings' | 'potluck';

export interface SettingsSection {
	href: string;
	label: string;
	/** An accessible name that says more than the label, for an entry whose label alone is terse. */
	ariaLabel?: string;
	icon: Component<Record<string, unknown>>;
	current: boolean;
	group: SettingsGroup;
	/** A small tag after the label, e.g. "Dev". */
	badge?: string;
}

export interface SettingsSectionInput {
	base: string;
	path: string;
	signedIn: boolean;
	workspacesEnabled?: boolean;
	localInferenceEnabled?: boolean;
	/** The per-account gate /chat/storage itself 404s on. (CUR-1682) */
	custodialStorageEnabled?: boolean;
	/** The active model, named (CUR-2203: never its wire id). Opens its configuration page. */
	model?: { id: string; name: string };
	/** Developer tools (Model settings, Model routing) — the local dev server, or an admin. */
	devTools?: boolean;
	/** The `auto-routing` flag (layout data's `autoRoutingEnabled`). */
	autoRoutingEnabled?: boolean;
	/** The `human-eval` flag (layout data's `humanEvalEnabled`): Evaluate language opens /chat/settings/evaluate. */
	humanEvalEnabled?: boolean;
	/** The `mcp-servers` flag (layout data's `mcpServersEnabled`): Connectors shows only with it on. (CUR-3984) */
	connectorsEnabled?: boolean;
	/** The `thunderbolt-sync` flag (layout data's `thunderboltSyncEnabled`): Connections shows only with it on. (CUR-4312) */
	thunderboltSyncEnabled?: boolean;
}

/** The active model for the settings nav, from the layout data every chat page already carries. */
function activeSettingsModel(pageData: object): SettingsSectionInput['model'] {
	const data = pageData as {
		settings?: { activeModel?: string };
		models?: { id: string; name?: string; displayName?: string; unlisted?: boolean }[];
	};
	const id = data.settings?.activeModel;
	const model = id ? data.models?.find((m) => m.id === id) : undefined;
	if (!model || model.unlisted) return undefined;
	return { id: model.id, name: model.displayName ?? model.name ?? model.id };
}

/** Whether this visitor gets developer tools: the local dev server, or an admin anywhere. */
export function settingsDevTools(pageData: object): boolean {
	return dev || Boolean((pageData as { isAdmin?: boolean }).isAdmin);
}

/**
 * Everything a settings nav needs from the layout data every chat page already carries: who is
 * signed in, the per-account gates, the active model, dev tools, Auto, human eval and Connectors.
 * The sidebar, the settings layout and the phone-width section list all build their sections from
 * this, so an entry's gate is read in one place.
 */
export function settingsNavInputs(pageData: object): Omit<SettingsSectionInput, 'base' | 'path'> {
	const data = pageData as {
		loginEnabled?: boolean;
		user?: unknown;
		workspacesEnabled?: boolean;
		localInferenceEnabled?: boolean;
		custodialStorageEnabled?: boolean;
		autoRoutingEnabled?: boolean;
		humanEvalEnabled?: boolean;
		mcpServersEnabled?: boolean;
		thunderboltSyncEnabled?: boolean;
	};
	return {
		signedIn: Boolean(data.loginEnabled && data.user),
		workspacesEnabled: data.workspacesEnabled,
		localInferenceEnabled: data.localInferenceEnabled,
		custodialStorageEnabled: data.custodialStorageEnabled,
		model: activeSettingsModel(pageData),
		devTools: settingsDevTools(pageData),
		autoRoutingEnabled: data.autoRoutingEnabled === true,
		humanEvalEnabled: data.humanEvalEnabled === true,
		connectorsEnabled: data.mcpServersEnabled === true,
		thunderboltSyncEnabled: data.thunderboltSyncEnabled === true
	};
}

/**
 * The load for a developer-only settings page (Model settings, Model routing): the same gate as its
 * nav entry, so a visitor who has the URL anyway lands on Settings rather than a page the nav never
 * shows them.
 */
export async function devToolsOnlyLoad({ parent }: { parent: () => Promise<object> }): Promise<Record<string, never>> {
	if (!settingsDevTools(await parent())) redirect(302, `${base}/settings`);
	return {};
}

export const SETTINGS_GROUP_LABEL: Record<SettingsGroup, string> = { settings: 'Settings', potluck: 'Potluck' };

/** The sections split into their groups, in display order, empty groups dropped. */
export function groupSettingsSections(list: SettingsSection[]): { group: SettingsGroup; label: string; items: SettingsSection[] }[] {
	return (['settings', 'potluck'] as const)
		.map((group) => ({ group, label: group === 'settings' ? m.product_settings() : SETTINGS_GROUP_LABEL[group], items: list.filter((s) => s.group === group) }))
		.filter((g) => g.items.length > 0);
}

/** Every first path segment under /settings that is a section, not a model id. */
const SECTION_SLUGS = new Set([
	'application',
	'personalization',
	'appearance',
	'data',
	'reports',
	'account',
	'workspace',
	'local-inference',
	'models',
	'routing',
	'contribute',
	'evaluate',
	'connectors',
	'connections'
]);

export function settingsSections(input: SettingsSectionInput): SettingsSection[] {
	const { base, path } = input;
	const at = (slug: string) => `${base}/settings/${slug}`;
	const entry = (
		slug: string,
		label: string,
		icon: SettingsSection['icon'],
		group: SettingsGroup = 'settings'
	): SettingsSection => ({
		href: at(slug),
		label,
		icon,
		current: path === at(slug),
		group
	});

	const list: SettingsSection[] = [
		entry('personalization', m.product_personalization(), RiUserHeartLine),
		entry('appearance', m.product_appearance(), RiPaletteLine),
		entry('data', m.product_dataPrivacy(), RiShieldUserLine),
		// What this visitor reported and what the team decided. A guest's are kept by session. (CUR-3903)
		{ ...entry('reports', m.product_yourReports(), RiFlagLine), ariaLabel: m.product_yourReportsAria() }
	];
	// The services chat is connected to, and which of their tools run without asking. A
	// guest's choices are kept by session, like the rest of their settings. (CUR-3984)
	if (input.connectorsEnabled) {
		list.push({ ...entry('connectors', m.product_connectors(), RiPlugLine), ariaLabel: m.product_connectorsAria() });
	}
	// The active model's configuration page (custom system prompt and its on/off switch, image input),
	// named so the reader sees which model they are on. Developer-only, like every per-model page.
	const activeModelHref = input.devTools && input.model ? at(input.model.id) : undefined;
	if (input.model && activeModelHref) {
		list.push({
			href: activeModelHref,
			label: `${m.product_model()}: ${input.model.name}`,
			icon: RiSparkling2Line,
			current: path === activeModelHref,
			group: 'settings',
			badge: 'Dev'
		});
	}
	if (input.signedIn) {
		list.push(entry('account', m.product_account(), RiUserLine));
		// The apps this person let read and write their conversations, each with Disconnect. (CUR-4312)
		if (input.thunderboltSyncEnabled) {
			list.push({ ...entry('connections', m.product_connections(), RiLinksLine), ariaLabel: m.product_connectionsAria() });
		}
		// The person's own stored files, opened inside the settings pane (CUR-1769) so this
		// entry switches the pane like its siblings instead of leaving settings. (CUR-1682)
		if (input.custodialStorageEnabled) {
			list.push({
				...entry('storage', m.product_storage(), RiFolderLine),
				ariaLabel: m.product_storageAria()
			});
		}
		if (input.workspacesEnabled) list.push(entry('workspace', m.product_workspace(), RiTeamLine));
		if (input.localInferenceEnabled) {
			list.push(entry('local-inference', m.product_localInference(), RiServerLine));
		}
	}
	// Per-model feature switches and system prompts. Developer-only: the model picker in the composer
	// is how everyone else chooses. A single model's page (/settings/<model id>) counts as this entry.
	if (input.devTools) {
		const first = path.startsWith(at('')) ? path.slice(at('').length).split('/')[0] : '';
		// The active model's page belongs to its own entry above; any other model's page to this one.
		const modelPage = first !== '' && !SECTION_SLUGS.has(first) && path !== activeModelHref;
		list.push({ ...entry('models', m.product_modelSettings(), RiSparkling2Line), badge: 'Dev', current: path === at('models') || modelPage });
	}

	// Potluck: how Auto picks a model per message (with every model's scores; edits apply on this
	// device), and ways to help fill Alpha's gaps — where the sidebar's "Get involved" card and the
	// composer's language-gap notice lead. Model routing is developer-only, like Model settings: the
	// lab still carries a PLACEHOLDER badge (CUR-3252), so it is not live for visitors on prod.
	if (input.devTools) list.push({ ...entry('routing', m.product_modelRouting(), RiFlaskLine, 'potluck'), badge: 'Dev' });
	list.push(entry('contribute', m.product_contribute(), RiHandHeartLine, 'potluck'));
	// The evaluation flow itself, one click from the nav, opened inside the settings pane like its siblings.
	if (input.humanEvalEnabled) list.push(entry('evaluate', m.product_evaluateLanguage(), RiChatCheckLine, 'potluck'));
	return list;
}

export interface SettingsExternalLink {
	href: string;
	label: string;
	icon: Component<Record<string, unknown>>;
}

/** Pages outside settings that the settings list links to. They open in a new tab, so settings stays. */
export function settingsExternalLinks(): SettingsExternalLink[] {
	return [
		{ href: '/privacy-notice', label: m.product_aboutPrivacy(), icon: RiInformationLine },
		{ href: 'https://status.aipotluck.org', label: m.product_statusPage(), icon: RiPulseLine }
	];
}

/** A settings page that needs more width than the reading column (evaluation's side-by-side rating). */
export const settingsWidePage = writable(false);

/**
 * A step inside a settings section, named in the header as its title with the section as a breadcrumb
 * back (Evaluate language › Kiswahili). `parentHref` is where that crumb leads; the section by default.
 */
export const settingsSubpage = writable<{ label: string; parentHref?: string } | undefined>(undefined);

/** Where "Back to app" returns to: the last non-settings URL, recorded by the settings layout. */
export const settingsReturnTo = writable<string | undefined>(undefined);
