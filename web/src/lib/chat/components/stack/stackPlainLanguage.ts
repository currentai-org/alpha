/**
 * Plain-language names for the parts Alpha is built from. The roadmap's product ids
 * ("inference-platform", "compute-router") are accurate but mean nothing to most people; XRAY's
 * "The stack" tab shows these instead, grouped by what each part does for you. Unknown ids fall
 * back to a readable version of the id, so a new roadmap product never disappears.
 */
export interface PlainPart {
	name: string;
	/** One sentence, no jargon. */
	what: string;
	group: StackGroupId;
}

export type StackGroupId = 'app' | 'find' | 'model' | 'safety' | 'act';

export const STACK_GROUPS: { id: StackGroupId; label: string; blurb: string }[] = [
	{ id: 'app', label: 'The app you use', blurb: 'What you see and touch.' },
	{ id: 'find', label: 'Finding information', blurb: 'How Alpha looks things up before answering.' },
	{ id: 'model', label: 'Thinking up the answer', blurb: 'The AI model, and the computers that run it.' },
	{ id: 'safety', label: 'Keeping it safe and honest', blurb: 'Checks, and showing you what happened.' },
	{ id: 'act', label: 'Doing things for you', blurb: 'Tasks beyond a single answer.' }
];

export const PLAIN_PARTS: Record<string, PlainPart> = {
	chat: { name: 'Chat window', what: 'The page you’re typing in right now.', group: 'app' },
	'mobile-app': { name: 'Phone app', what: 'Alpha as an app on your phone.', group: 'app' },
	projects: { name: 'Projects', what: 'Keeping related chats and files together.', group: 'app' },
	'voice-output': { name: 'Read aloud', what: 'Speaks answers out loud when you ask.', group: 'app' },
	rag: { name: 'Knowledge library', what: 'Checked documents Alpha can quote from.', group: 'find' },
	'web-search': { name: 'Web search', what: 'Looks up current information online.', group: 'find' },
	'federated-rag': {
		name: 'Private data vaults',
		what: 'Asks private collections for a summary without seeing the raw data.',
		group: 'find'
	},
	'foundation-model': { name: 'The AI model', what: 'The open model that writes the answer.', group: 'model' },
	'model-router': { name: 'Model chooser', what: 'Picks the best model for your question.', group: 'model' },
	'inference-engine': { name: 'Model engine', what: 'Software that runs the model quickly.', group: 'model' },
	'inference-platform': {
		name: 'Model hosting',
		what: 'The service that keeps the model online.',
		group: 'model'
	},
	'compute-router': {
		name: 'Traffic director',
		what: 'Sends each request to a computer that’s free.',
		group: 'model'
	},
	'sovereign-compute': {
		name: 'Public computers',
		what: 'Publicly owned supercomputers that can run the model.',
		group: 'model'
	},
	'api-management': {
		name: 'Access and usage',
		what: 'Keeps track of who uses what, fairly.',
		group: 'model'
	},
	'trust-and-safety': {
		name: 'Safety check',
		what: 'Screens messages for harmful content.',
		group: 'safety'
	},
	'stack-provenance': {
		name: 'Receipts',
		what: 'Records which parts made each answer — what X-ray shows you.',
		group: 'safety'
	},
	'stack-telemetry': {
		name: 'Health monitor',
		what: 'Watches whether every part is working.',
		group: 'safety'
	},
	'agent-service': { name: 'Task helper', what: 'Carries out multi-step tasks for you.', group: 'act' },
	'skills-framework': { name: 'Skills', what: 'Reusable abilities Alpha can learn.', group: 'act' }
};

export function plainPart(id: string): PlainPart {
	return (
		PLAIN_PARTS[id] ?? {
			name: id.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
			what: '',
			group: 'app'
		}
	);
}
