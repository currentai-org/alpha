/**
 * English bootstrap/fallback copy and demo artifact types for `/alpha`.
 * Published editorial copy is managed in Payload's `alpha-landing` global.
 *
 * Make AI yours (language, data, rules) and the Alpha Public Router.
 * Product facts stay honest — only claim what the demo or live Alpha can show today.
 */

import { RETENTION_DAYS } from '$lib/chat/constants/retention';
import { CHAT_HOST } from '$lib/chat/paths';
import { DATA_HOME, MODEL_HOSTS, orgs } from '$lib/chat/routing/catalog';
import { MOZILLA_DATA_COLLECTIVE } from '$lib/chat/contribute';

// Who runs Apertus, from the catalog rather than typed here, so the FAQ moves with a host change.
const apertusHost = orgs[MODEL_HOSTS['apertus-70b']];
const APERTUS_HOST = apertusHost.region
	? `${apertusHost.name} in ${apertusHost.region}`
	: apertusHost.name;

export type Inline = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

export type FaqItem = {
	id: string;
	question: string;
	paragraphs: Inline[][];
};

export type FaqGroup = {
	heading?: string;
	items: FaqItem[];
};

export type TraceRow = { label: string; value: string };

export type FeatureArtifact =
	| { kind: 'trace'; title: string; rows: TraceRow[] }
	| { kind: 'sources'; title: string; items: { mark: string; title: string; detail: string }[] }
	| { kind: 'identity'; title: string; rows: TraceRow[] }
	| { kind: 'panel'; title: string; notes: { label: string; detail: string }[] }
	| { kind: 'steps'; title: string; steps: string[] }
	| {
			kind: 'timeline';
			title: string;
			items: { when: string; headline: string; detail: string }[];
	  };

export type FeatureId = 'language' | 'data' | 'rules' | 'router';

export type Feature = {
	id: FeatureId;
	nav: string;
	eyebrow: string;
	title: string;
	body: string;
	artifact: FeatureArtifact;
};

export const pageTitle = 'Alpha';

export const pageDescription =
	'Make AI yours with Alpha: chat in your language, see what each answer is based on, and stay in control of your messages and settings.';

export const hero = {
	eyebrow: 'Alpha, from AI Potluck',
	headline: 'Make AI yours.',
	tagline: 'Your language. Your data. Your rules.',
	sub: 'Talk in your language, see which AI answered and where it ran, keep control of what is stored, and set how Alpha behaves for yourself or together with others.',
	cta: 'Try Alpha',
	ctaHref: '/chat'
} as const;

/** Bridge from hero to feature sections — frames the three pillars for non-technical readers. */
export const sectionsIntro = {
	eyebrow: 'What you get',
	title: 'AI you can understand and steer.',
	body: 'Many chat tools hide which AI replied and what happens to your messages. Alpha is built around everyday choices — your language, your data, how it looks and behaves — and an X-ray on every answer so you are not guessing.'
} as const;

/** The caption over the live preview. */
export const preview = {
	eyebrow: 'The real app, on sample chats',
	link: 'Open the full demo'
} as const;

/** The bold look's ribbon under the hero: short facts the page goes on to show, each with an icon. */
export const ticker = [
	{ id: 'open', text: 'Open models' },
	{ id: 'hosts', text: 'Named hosts' },
	{ id: 'xray', text: 'An X-ray on every answer' },
	{ id: 'language', text: 'Your language, noticed on your device' },
	{ id: 'training', text: 'We don’t train AI on your chats' },
	{ id: 'erase', text: 'Erase everything in one click' },
	{ id: 'model', text: 'Pick the model, or leave it on Auto' }
] as const;

export type TickerId = (typeof ticker)[number]['id'];

/** The closing panel: where Alpha still needs people, after the features. */
export const closing = {
	eyebrow: 'Open calls',
	title: 'Alpha isn’t finished. Build with us.',
	body: 'Some of what Alpha needs is code. Much of it is data in more languages, people willing to test it in the real world, and partners to run open models. If one of these is yours, come build it with us.',
	actions: [
		{ label: 'Try Alpha', href: '/chat' },
		{ label: 'Share data in your language', href: MOZILLA_DATA_COLLECTIVE.home }
	],
	more: { label: 'See other ways to contribute', href: '/contribute' }
} as const;

export const stage = {
	label: 'Try the demo — send a message to sign up',
	interactLabel: 'Click to use the demo',
	interactHint: 'Scroll the page freely — click when you want to explore Alpha.',
	prompt: 'Which open projects work on speech, and what can you actually say about them?',
	answer:
		'I can name projects our catalog lists, and I will not invent details the sources do not support. The summary under this reply shows what Alpha checked for this answer.',
	trace: [
		{ label: 'AI used', value: 'Apertus' },
		{ label: 'Run on', value: 'Shared Alpha service' },
		{ label: 'Sources', value: 'Project catalog' },
		{ label: 'Web search', value: 'Not this turn' }
	]
} as const;

export const features: Feature[] = [
	{
		id: 'language',
		nav: 'Language',
		eyebrow: 'Your language',
		title: 'Chat in your language, and switch when an answer misses the mark.',
		body: 'Alpha notices the language you write in as you type, on your device, and picks the open model that handles it best, message by message. Where no model does well yet, it says so and shows how you can help. If a reply feels off, choose another in a click. Every answer names which AI wrote it and what it checked — like a receipt, not a guess.',
		artifact: {
			kind: 'panel',
			title: 'In Alpha today',
			notes: [
				{ label: 'Language fit', detail: 'Compare AIs for your language before you chat' },
				{ label: 'Switch AI', detail: 'Try a different assistant when one falls short' },
				{ label: 'Answer summary', detail: 'Which AI replied and what it used' }
			]
		}
	},
	{
		id: 'data',
		nav: 'Data',
		eyebrow: 'Your data',
		title: 'See what Alpha keeps, delete it, export it, and know where it lives.',
		body: 'Your messages are yours: see what is stored, who holds it, and know we don’t train AI on your chats. Review, delete, and export on your terms — whether you are trying Alpha as a guest or with an account.',
		artifact: {
			kind: 'steps',
			title: 'Your data in Alpha',
			steps: [
				'See what is stored about you',
				'Delete conversations and uploads',
				'Export your history',
				'Read where it is kept and by whom'
			]
		}
	},
	{
		id: 'rules',
		nav: 'Make it yours',
		eyebrow: 'Make it yours',
		title: 'Make it look, sound and think your way.',
		body: 'Choose a theme, tell Alpha how you like your answers, and leave model choice on Auto or pick the open model you trust. Your settings follow you into every chat.',
		artifact: {
			kind: 'identity',
			title: 'Three levels',
			rows: [
				{ label: 'You', value: 'Your own preferences' },
				{ label: 'Organisation', value: 'Shared rules for members' },
				{ label: 'Group', value: 'Rules you set together' }
			]
		}
	},
	{
		id: 'router',
		nav: 'X-ray',
		eyebrow: 'See inside every answer',
		title: 'Know which AI answered, where it ran, and what it checked.',
		body: 'Alpha connects you to open models anyone can inspect, run by named organisations. Every reply has an X-ray: who made the model, who ran it, what was looked up, what was checked — step by step, in plain language.',
		artifact: {
			kind: 'trace',
			title: 'Why that helps',
			rows: [
				{ label: 'For you', value: 'One chat, clear backups if needed' },
				{ label: 'Each answer', value: 'Says which AI replied' },
				{ label: 'Open models', value: 'Anyone can inspect them' },
				{ label: 'Public compute', value: 'Shared infrastructure, not a secret box' }
			]
		}
	}
];

export const faqTitle = 'Fair questions';

export const faqIntro =
	'What people ask before they trust a new AI with their questions — answered plainly.';

const t = (text: string): Inline => ({ kind: 'text', text });
const a = (text: string, href: string): Inline => ({ kind: 'link', text, href });

export const faq: FaqGroup[] = [
	{
		heading: 'Getting started',
		items: [
			{
				id: 'what-is-alpha',
				question: 'What is Alpha?',
				paragraphs: [
					[
						t('Alpha is a chat assistant from Current AI, live at '),
						a(`${CHAT_HOST}/chat`, '/chat'),
						t(
							'. You ask questions and get answers, like other AI chats — but every answer comes from an open model made and run by organisations it names, and every answer has an X-ray showing how it was made.'
						)
					]
				]
			},
			{
				id: 'account',
				question: 'Do I need an account?',
				paragraphs: [
					[
						t(
							`No. You can start chatting as a guest; guest conversations are deleted automatically after ${RETENTION_DAYS} days. Create an account when you want to keep your history and your settings across devices.`
						)
					]
				]
			},
			{
				id: 'language',
				question: 'Does it work in my language?',
				paragraphs: [
					[
						t(
							'Yes, in many. On Auto, Alpha notices the language you write in, on your device, and for each message picks the model that reads it best, judged by reading-comprehension tests — SEA-LION for Southeast Asian languages, for example — and tells you which one it chose. Where no model handles a language well yet, Alpha says it is still learning it and shows how you can help.'
						)
					]
				]
			}
		]
	},
	{
		heading: 'Your data',
		items: [
			{
				id: 'who-sees',
				question: 'Who can see my conversations?',
				paragraphs: [[t(`${DATA_HOME.chats} We don’t train AI on them.`)]]
			},
			{
				id: 'delete',
				question: 'Can I delete everything?',
				paragraphs: [
					[
						t(
							'Yes, any time. Settings → Data & privacy has one button that erases your conversations, settings and uploads. You can delete a single chat from its menu, and export your history before you go.'
						)
					]
				]
			},
			{
				id: 'where-runs',
				question: 'Where do the models actually run?',
				paragraphs: [
					[
						t(
							`Each model is run by a named organisation — Apertus by ${APERTUS_HOST}, for example. Open X-ray on any answer to see who made the model and who ran it for that reply.`
						)
					]
				]
			}
		]
	},
	{
		heading: 'Trusting the answers',
		items: [
			{
				id: 'right',
				question: 'How do I know an answer is right?',
				paragraphs: [
					[
						t(
							'You check it, and Alpha makes that easy. When an answer uses sources, they’re numbered and linked. X-ray’s Step by step shows whether Alpha looked something up or answered from memory, and you can ask other open models for a second opinion. For anything medical, legal or financial, treat Alpha as a starting point, not the final word.'
						)
					]
				]
			},
			{
				id: 'safety',
				question: 'Is it safe to use?',
				paragraphs: [
					[
						t(
							'Every message is checked for harmful content before a model sees it, and Alpha checks answers for invented links, sources and names. Alpha is also honest about being a machine: no pretend feelings, no flattery, no personality designed to keep you chatting.'
						)
					]
				]
			},
			{
				id: 'energy',
				question: 'What is the energy figure at the top?',
				paragraphs: [
					[
						t(
							'An estimate of the electricity your answers used this session, next to the time you’ve spent. We show it because AI has a real cost, and because Alpha isn’t built to keep you here longer than you need.'
						)
					]
				]
			},
			{
				id: 'open',
				question: 'Why does “open” matter?',
				paragraphs: [
					[
						t(
							'Open models can be inspected, tested and improved by anyone — researchers, public institutions, you. That makes it possible to check what an AI was trained on and how it behaves, instead of taking a company’s word for it. See where the open source AI stack is strong and where it still has gaps on the '
						),
						a('gap map', '/map'),
						t('.')
					]
				]
			}
		]
	}
];
