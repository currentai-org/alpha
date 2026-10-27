import { z } from 'zod';
import type { LexicalRoot } from '$lib/lexical/types';
import * as defaults from './copy';

const text = z.string().min(1);
const link = z.object({ label: text, href: text });
const lexical = z.looseObject({ root: z.looseObject({ children: z.array(z.unknown()) }) });

/** The editorial contract shared by every landing look and the Payload boundary. */
export const alphaLandingSchema = z.object({
	pageTitle: text,
	pageDescription: text,
	hero: z.object({
		eyebrow: text,
		headline: text,
		tagline: text,
		sub: text,
		cta: text,
		ctaHref: text,
		headlineStart: text,
		headlineAccent: text,
		demoCta: text,
		languagePillar: text,
		dataPillar: text,
		rulesPillar: text
	}),
	sectionsIntro: z.object({ eyebrow: text, title: text, body: text }),
	preview: z.object({ eyebrow: text, link: text }),
	ticker: z.array(
		z.object({
			key: z.enum(['open', 'hosts', 'xray', 'language', 'training', 'erase', 'model']),
			text
		})
	),
	closing: z.object({
		eyebrow: text,
		title: text,
		body: text,
		actions: z.array(link).min(2),
		more: link
	}),
	stage: z.object({
		label: text,
		interactLabel: text,
		interactHint: text,
		prompt: text,
		answer: text
	}),
	features: z
		.array(
			z.object({
				key: z.enum(['language', 'data', 'rules', 'router']),
				nav: text,
				eyebrow: text,
				title: text,
				body: text
			})
		)
		.min(1),
	faqEyebrow: text,
	faqTitle: text,
	faqIntro: text,
	faq: z.array(
		z.object({
			heading: text,
			items: z.array(z.object({ key: text, question: text, answer: lexical }))
		})
	)
});

export type AlphaLandingContent = z.infer<typeof alphaLandingSchema>;

/** Preserve the original authored links as native Payload rich text when seeding. */
function toLexical(paragraphs: defaults.Inline[][]): LexicalRoot {
	return {
		root: {
			type: 'root',
			version: 1,
			direction: null,
			format: '',
			indent: 0,
			children: paragraphs.map((paragraph) => ({
				type: 'paragraph',
				version: 1,
				direction: null,
				indent: 0,
				children: paragraph.map((part) => {
					const node = {
						type: 'text',
						version: 1,
						text: part.text,
						format: 0,
						detail: 0,
						mode: 'normal',
						style: ''
					};
					return part.kind === 'link'
						? {
								type: 'link',
								version: 3,
								fields: { linkType: 'custom', url: part.href, newTab: false },
								children: [node]
							}
						: node;
				})
			}))
		}
	};
}

/** English bootstrap/fallback copy; routine edits are served from the CMS. */
export const defaultAlphaLandingContent: AlphaLandingContent = {
	pageTitle: defaults.pageTitle,
	pageDescription: defaults.pageDescription,
	hero: {
		...defaults.hero,
		headlineStart: 'Make AI',
		headlineAccent: 'yours',
		demoCta: 'Try the demo',
		languagePillar: 'Your language.',
		dataPillar: 'Your data.',
		rulesPillar: 'Your rules.'
	},
	sectionsIntro: defaults.sectionsIntro,
	preview: defaults.preview,
	ticker: defaults.ticker.map(({ id, text }) => ({ key: id, text })),
	closing: { ...defaults.closing, actions: [...defaults.closing.actions] },
	stage: defaults.stage,
	features: defaults.features.map(({ id, nav, eyebrow, title, body }) => ({
		key: id,
		nav,
		eyebrow,
		title,
		body
	})),
	faqEyebrow: 'Before you start',
	faqTitle: defaults.faqTitle,
	faqIntro: defaults.faqIntro,
	faq: defaults.faq.map((group) => ({
		heading: group.heading ?? 'Questions',
		items: group.items.map((item) => ({
			key: item.id,
			question: item.question,
			answer: toLexical(item.paragraphs)
		}))
	}))
};
