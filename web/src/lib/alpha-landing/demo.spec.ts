import { describe, expect, it } from 'vitest';
import { PICKER, PICKER_BEFORE_WITHDRAWALS } from '../../../config/picker';
import { catalogByGatewayId } from '$lib/chat/routing/catalog';
import { heuristicClassify } from '$lib/chat/routing/heuristic';
import { route } from '$lib/chat/routing/router';
import { STARTER_COUNT } from '$lib/chat/utils/starterRotation';
import { shelf } from '$lib/chat/constants/starterShelf';
import {
	DEMO_ACTIVE_CONVERSATION_ID,
	createDemoThreads,
	demoConversationList,
	demoThreadModel
} from './demo-conversation';
import { DEMO_MODEL_ID, demoModels } from './demo-models';
import { wwwPickerCatalog } from '$lib/chat/routing/wwwPicker';
import { createDemoPageData } from './demo-page-data';
import { createDemoShellData } from './demo-shell-data';

// The demo is the real app on sample data, so these pin the parts that are ours to keep true:
// the payload it hands the app, and the sample conversations' claims about how Alpha behaves.

describe('/alpha demo payload', () => {
	it('greets with the sovereign serving line, as /chat does, not the hedged prototype wording', () => {
		const data = createDemoPageData();
		expect(data.servingProvenance.isSovereign).toBe(true);
		expect(data.servingProvenance.computeTail).toBe(
			"served by the Public AI Inference Utility's sovereign infrastructure."
		);
	});

	it('offers as many prompt examples as the chat loader, all from the graded starter shelf', () => {
		const { starters } = createDemoPageData();
		expect(starters).toHaveLength(STARTER_COUNT);
		for (const s of starters) expect(shelf).toContain(s);
	});

	it("lists exactly www's picker, in its order, for the landing model card and the demo (CUR-4099)", () => {
		expect(wwwPickerCatalog.map((m) => m.gatewayId)).toEqual([...PICKER.production]);
		// The demo's answers are recordings, so it keeps a model that is temporarily withdrawn (CUR-4162).
		expect(demoModels.map((m) => m.id)).toEqual([...PICKER_BEFORE_WITHDRAWALS.production]);
	});

	it('serves every live catalog model with a gateway id, so Auto can pick between them', () => {
		expect(demoModels.map((m) => m.id)).toContain(DEMO_MODEL_ID);
		expect(demoModels.length).toBeGreaterThan(1);
		for (const m of demoModels) expect(catalogByGatewayId(m.id)?.status).toBe('live');
	});

	it('offers only models www’s picker serves or has withdrawn for now, so the demo never shows one no site offers', () => {
		for (const m of demoModels) expect(PICKER_BEFORE_WITHDRAWALS.production, m.id).toContain(m.id);
	});

	it('shows the sample conversations in the sidebar and no signed-in user', () => {
		const shell = createDemoShellData();
		expect(shell.user).toBeNull();
		expect(shell.conversations.map((c) => String(c.id))).toEqual(
			demoConversationList().map((c) => c.id)
		);
	});
});

describe('/alpha demo sample conversations', () => {
	const threads = Object.entries(createDemoThreads()).map(([id, make]) => ({
		id,
		messages: make()
	}));

	it('lists newest first and opens on the newest', () => {
		const list = demoConversationList();
		expect(list[0].id).toBe(DEMO_ACTIVE_CONVERSATION_ID);
		const times = list.map((c) => c.updatedAt.getTime());
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});

	it('names, for every answer, a model the demo serves', () => {
		const served = new Set(demoModels.map((m) => m.id));
		for (const { id, messages } of threads) {
			for (const m of messages.filter((x) => x.from === 'assistant')) {
				expect(served, `${id} ${m.id}`).toContain(m.routerMetadata?.model);
			}
		}
	});

	it('cites no source number an answer does not carry', () => {
		for (const { id, messages } of threads) {
			for (const m of messages.filter((x) => x.from === 'assistant')) {
				const carried = (m.rag?.sources.length ?? 0) + (m.webSearch?.sources.length ?? 0);
				const cited = [...m.content.matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
				expect(Math.max(0, ...cited), `${id} ${m.id}`).toBeLessThanOrEqual(carried);
			}
		}
	});

	it('records, for each turn, the model Auto would pick for that question, staying on the last one mid-chat', () => {
		const served = demoModels.map((m) => m.id);
		const misses: string[] = [];
		for (const { id, messages } of threads) {
			let previous: string | undefined;
			for (let i = 0; i < messages.length; i += 2) {
				const question = messages[i].content;
				const recorded = catalogByGatewayId(messages[i + 1].routerMetadata?.model);
				const picked = route(heuristicClassify(question), served, { stickTo: previous })?.model;
				if (picked?.id !== recorded?.id) {
					misses.push(
						`${id}: Auto would send "${question.slice(0, 50)}…" to ${picked?.name}, not ${recorded?.name}`
					);
				}
				previous = recorded?.id;
			}
		}
		expect(misses).toEqual([]);
	});

	it('names, in any answer that says which model wrote it, the model its X-ray credits (CUR-3854)', () => {
		const wrong: string[] = [];
		let named = 0;
		for (const { id, messages } of threads) {
			for (const m of messages) {
				const said = /the model writing this is \*\*([^*]+)\*\*/.exec(m.content)?.[1];
				if (!said) continue;
				named++;
				const credited = catalogByGatewayId(m.routerMetadata?.model)?.name;
				if (said !== credited) wrong.push(`${id}: says ${said}, X-ray credits ${credited}`);
			}
		}
		expect(named).toBeGreaterThan(0);
		expect(wrong).toEqual([]);
	});

	it('follows the model that wrote the last answer, and starts a new chat on the default', () => {
		const switching = threads.find((t) => t.id === 'alpha-demo-conv-vietnamese');
		const models = switching?.messages
			.filter((m) => m.from === 'assistant')
			.map((m) => m.routerMetadata?.model);
		expect(new Set(models).size).toBeGreaterThan(1);
		expect(demoThreadModel('alpha-demo-conv-vietnamese')).toBe(models?.at(-1));
		expect(demoThreadModel(undefined)).toBe(DEMO_MODEL_ID);
	});
});
