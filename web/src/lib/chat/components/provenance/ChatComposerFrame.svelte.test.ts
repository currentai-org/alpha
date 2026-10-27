import type { CDPSession } from '@vitest/browser-playwright';
import { cdp, page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { EmbeddedIntent } from '$lib/chat/types/EmbeddedIntent';
import Harness from './ChatComposerFrame.harness.svelte';
import { catalogByGatewayId } from '$lib/chat/routing/catalog';
import { AUTO, modelChoice } from '$lib/chat/routing/choice';

// The model menu opens on press and rises over the button that opened it, its rows under the pointer.
// The end of that gesture (a mouse release, or the click a tap synthesises) must not activate a row:
// one click or tap on the button leaves the menu open and the model as it was.

// The layout data is the real `$app/state` page with `autoRoutingEnabled` laid over it, and its
// params with the open conversation's id.
const autoFlag = vi.hoisted(() => ({ on: false }));
const openChat = vi.hoisted(() => ({ id: undefined as string | undefined }));
vi.mock('$app/state', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$app/state')>();
	const page = new Proxy(actual.page, {
		get: (target, key) =>
			key === 'data'
				? { ...target.data, autoRoutingEnabled: autoFlag.on }
				: key === 'params'
					? { ...target.params, ...(openChat.id ? { id: openChat.id } : {}) }
					: Reflect.get(target, key)
	});
	return { ...actual, page };
});

const modelButton = () => page.getByRole('button', { name: /^Model:/ });
// vitest types `cdp()` as an empty interface; the Playwright provider's own type has `send`.
const session = () => cdp() as unknown as CDPSession;

let onEmbeddedNavigate: Mock<(intent?: EmbeddedIntent) => void>;

beforeEach(async () => {
	await page.viewport(1280, 900);
	onEmbeddedNavigate = vi.fn<(intent?: EmbeddedIntent) => void>();
	render(Harness, { props: { onEmbeddedNavigate } });
});

afterEach(cleanup);

describe('the composer model button', () => {
	it('opens the model menu on a click and leaves it open, without activating the row released over', async () => {
		const before = modelButton().element().getAttribute('aria-label');
		await modelButton().click();

		await expect.element(page.getByRole('menu')).toBeVisible();
		await expect.poll(() => modelButton().element().getAttribute('aria-expanded')).toBe('true');
		expect(modelButton().element().getAttribute('aria-label'), 'the release picked a model').toBe(before);
	});

	it('opens the model menu on a tap and leaves it open, without activating the row the tap lands on', async () => {
		const button = modelButton().element();
		const before = button.getAttribute('aria-label');
		const { left, top, width, height } = button.getBoundingClientRect();
		// The test runs in an iframe that the runner scales down; the touch is dispatched to the page.
		const frame = window.frameElement?.getBoundingClientRect();
		const scale = frame ? frame.width / window.innerWidth : 1;
		const touch = {
			x: (frame?.left ?? 0) + (left + width / 2) * scale,
			y: (frame?.top ?? 0) + (top + height / 2) * scale
		};
		// Every spec file shares this browser page, so the emulation is switched off again however the
		// test ends: left on, it reports `(hover: none)` to every later file and their `hover:` rules die.
		await session().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
		try {
			await session().send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
			await session().send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

			await expect.element(page.getByRole('menu')).toBeVisible();
			// The click a tap synthesises arrives after the menu has mounted under the finger.
			await new Promise((resolve) => setTimeout(resolve, 400));
			expect(button.getAttribute('aria-expanded')).toBe('true');
			expect(button.getAttribute('aria-label'), 'the tap picked a model').toBe(before);
		} finally {
			await session().send('Emulation.setTouchEmulationEnabled', { enabled: false });
		}
	});

	it('offers no link to the routing lab, with Auto on or off: the lab is a developer page, not a picker row', async () => {
		for (const on of [false, true]) {
			cleanup();
			autoFlag.on = on;
			render(Harness, { props: { onEmbeddedNavigate } });
			await modelButton().click();
			await expect.element(page.getByRole('menu')).toBeVisible();
			const lab = page.getByRole('menu').element().querySelector('a[href$="/settings/routing"]');
			expect(lab, `the model menu links to the routing lab with Auto ${on ? 'on' : 'off'}`).toBeNull();
			await userEvent.keyboard('{Escape}');
		}
		autoFlag.on = false;
	});
});

// Whatever closes the model menu, the next thing anyone does is type their message. With focus left on
// the pill, those keystrokes would go to the button (a space reopens the menu) and the message would be lost.
describe('closing the model menu', () => {
	const box = () => page.getByRole('textbox', { name: 'Message AI Potluck' });

	it('puts focus in the message box after a pick, so what is typed next lands there', async () => {
		await modelButton().click();
		await expect.element(page.getByRole('menu')).toBeVisible();
		const other = page.getByRole('menu').element().querySelector<HTMLElement>('[data-model-id][aria-checked="false"]');
		expect(other, 'no second model to pick').not.toBeNull();
		other!.click();

		await expect.poll(() => document.activeElement).toBe(box().element());
		await userEvent.keyboard('Hi there');
		await expect.element(box()).toHaveValue('Hi there');
		expect(modelButton().element().getAttribute('aria-expanded'), 'a typed space reopened the menu').toBe('false');
	});

	it('puts focus in the message box when Escape closes the menu', async () => {
		await modelButton().click();
		await expect.element(page.getByRole('menu')).toBeVisible();
		await userEvent.keyboard('{Escape}');

		await expect.poll(() => document.activeElement).toBe(box().element());
	});
});

// On a phone the picker is a bottom sheet, not the menu, and it closed back onto the pill the same way
// the menu once did (CUR-3237): the sheet's dialog returned focus to its trigger.
describe('closing the phone model sheet', () => {
	const box = () => page.getByRole('textbox', { name: 'Message AI Potluck' });
	const sheet = () => document.querySelector<HTMLElement>('[data-model-sheet]');

	beforeEach(async () => {
		cleanup();
		await page.viewport(390, 844);
		render(Harness, { props: { onEmbeddedNavigate } });
	});

	it('puts focus in the message box after a pick, so what is typed next lands there', async () => {
		await modelButton().click();
		await expect.poll(sheet, { message: 'the phone width did not open the sheet' }).not.toBeNull();
		const other = sheet()!.querySelector<HTMLElement>('[data-model-id][aria-checked="false"]:not([disabled])');
		expect(other, 'no second model to pick').not.toBeNull();
		other!.click();

		await expect.poll(sheet).toBeNull();
		await expect.poll(() => document.activeElement).toBe(box().element());
		await userEvent.keyboard('Hi there');
		await expect.element(box()).toHaveValue('Hi there');
	});

	it('puts focus in the message box when Escape closes the sheet', async () => {
		await modelButton().click();
		await expect.poll(sheet).not.toBeNull();
		await userEvent.keyboard('{Escape}');

		await expect.poll(sheet).toBeNull();
		await expect.poll(() => document.activeElement).toBe(box().element());
	});
});

// Mistral Small is registered so CI ticket-branch previews can serve on it, and is not a model we offer
// (CUR-2763). Every gateway id is served in the harness, so only the catalog's `offered` decides.
// Sparkles mean Auto is choosing. A model picked by hand shows its maker's mark, as its menu row does.
describe("the model button's icon", () => {
	const pillLogo = () => modelButton().element().querySelector('[data-org-logo]');

	afterEach(() => {
		autoFlag.on = false;
		localStorage.removeItem('alpha:model-choice');
	});

	it("is the picked model's maker logo, not the Auto sparkles, with Auto off", async () => {
		await expect.element(modelButton()).toBeVisible();
		expect(pillLogo(), 'the button shows no maker logo for the chosen model').not.toBeNull();
	});

	it('follows a pick to the new model’s maker', async () => {
		await modelButton().click();
		const row = page
			.getByRole('menu')
			.element()
			.querySelector<HTMLElement>('[data-model-id][aria-checked="false"]');
		const maker = row?.querySelector('[data-org-logo]')?.getAttribute('data-org-logo');
		row?.click();
		await expect.poll(() => pillLogo()?.getAttribute('data-org-logo')).toBe(maker);
	});

	it('is the sparkles, and no maker logo, while Auto is chosen', async () => {
		cleanup();
		autoFlag.on = true;
		localStorage.setItem('alpha:model-choice', 'auto');
		render(Harness, { props: { onEmbeddedNavigate } });
		await expect.element(modelButton()).toHaveAccessibleName(/^Model: Auto/);
		expect(pillLogo(), 'Auto shows a maker logo, as if one model were picked').toBeNull();
		expect(modelButton().element().querySelector('svg:not([class*="text-fg-3"])')).not.toBeNull();
	});
});

describe('a model registered for CI and not offered', () => {
	const small = 'mistral-small-2603';
	const smallRow = () => page.getByRole('menu').element().querySelector(`[data-model-id="${small}"]`);

	it('is left out of the model menu in a conversation another model serves', async () => {
		await modelButton().click();

		await expect.element(page.getByRole('menu')).toBeVisible();
		expect(page.getByRole('menu').element().querySelectorAll('[data-model-id]').length).toBeGreaterThan(0);
		expect(smallRow(), 'Mistral Small 4 is listed to a visitor').toBeNull();
	});

	it('is listed, as the chosen model, where the deployment defaults to it, and stays listed after another pick', async () => {
		cleanup();
		render(Harness, { props: { onEmbeddedNavigate, currentModelId: small } });
		await modelButton().click();

		await expect.element(page.getByRole('menu')).toBeVisible();
		expect(smallRow(), 'the default model is missing from the menu').not.toBeNull();
		expect(smallRow()?.getAttribute('aria-checked')).toBe('true');

		const other = page.getByRole('menu').element().querySelector('[data-model-id][aria-checked="false"]');
		(other as HTMLElement).click();
		await modelButton().click();
		await expect.element(page.getByRole('menu')).toBeVisible();
		expect(smallRow(), 'picking another model removed the default from the menu').not.toBeNull();
		await expect.poll(() => smallRow()?.getAttribute('aria-checked')).toBe('false');
	});
});


describe('the Local marker', () => {
	// `local:{24-hex endpointId}:{servedModelId}` — localModels.ts's own shape.
	const LOCAL_ID = `local:${'a'.repeat(24)}:llama3.2:latest`;
	const localPill = () => page.getByRole('button', { name: /^Local —/ });

	it('appears when the conversation is answered by the person’s own server', async () => {
		cleanup();
		render(Harness, { props: { onEmbeddedNavigate, currentModelId: LOCAL_ID } });

		await expect.element(localPill()).toBeVisible();
	});

	it('is absent for a model served from the cloud', async () => {
		// The consequential direction, and the reason this has a test at all: the marker is a
		// privacy claim. Showing it for a conversation that does leave the machine would tell
		// someone their messages stayed home when they did not — worse than not showing it at all.
		// The default harness model is a catalog (cloud) one, rendered by the global beforeEach.
		await expect.poll(() => localPill().elements().length).toBe(0);
	});

	it('opens a panel describing the session, so it is a disclosure and not just a badge', async () => {
		cleanup();
		render(Harness, { props: { onEmbeddedNavigate, currentModelId: LOCAL_ID } });

		await localPill().click();

		await expect.element(page.getByText(/Where your message will go/i)).toBeVisible();
		await expect.poll(() => localPill().element().getAttribute('aria-expanded')).toBe('true');
	});

	it('speaks in the future before a conversation has started', async () => {
		// The empty state is where most people meet this panel -- the pill sits under the composer on
		// the landing screen -- and "this reply was written by" is plainly wrong when there is no
		// reply yet.
		cleanup();
		render(Harness, { props: { onEmbeddedNavigate, currentModelId: LOCAL_ID, started: false } });
		await localPill().click();

		await expect.element(page.getByText(/will be answered by/i)).toBeVisible();
		await expect.poll(() => page.getByText(/This reply was written by/i).elements().length).toBe(0);
	});

	it('speaks in the past once a reply exists', async () => {
		cleanup();
		render(Harness, { props: { onEmbeddedNavigate, currentModelId: LOCAL_ID, started: true } });
		await localPill().click();

		await expect.element(page.getByText(/This reply was written by/i)).toBeVisible();
		await expect.element(page.getByText(/Where your message went/i)).toBeVisible();
	});

	it('says plainly that messages still pass through Alpha and are stored', async () => {
		// The paragraph this asserts on is the reason the panel is safe to ship. "Local" means the
		// MODEL runs on the person's machine; the message still reaches Alpha and is saved. Someone
		// reading a privacy panel and concluding their messages never left the house would be worse
		// off than with no panel at all, so this copy is load-bearing rather than decorative.
		cleanup();
		render(Harness, { props: { onEmbeddedNavigate, currentModelId: LOCAL_ID } });
		await localPill().click();

		await expect.element(page.getByText(/still pass through/i)).toBeVisible();
		// A phrase that sits on one source line: the text matcher does not fold the line breaks
		// prettier introduces, so a longer quote silently never matches.
		await expect.element(page.getByText(/your account until you delete it/i)).toBeVisible();
	});

	it('does not promise an encrypted tunnel when the endpoint kind is unknown', async () => {
		// The harness supplies no page.data.models, so the kind cannot be read — exactly the state a
		// real client is in before the model list loads. The direct wording promises strictly less,
		// and claiming WireGuard here would be an assurance with nothing behind it.
		cleanup();
		render(Harness, { props: { onEmbeddedNavigate, currentModelId: LOCAL_ID } });
		await localPill().click();

		await expect.element(page.getByText(/There is no tunnel on this route/i)).toBeVisible();
		await expect.poll(() => page.getByText(/WireGuard/i).elements().length).toBe(0);
	});
});

// CUR-3190, with Auto on: a model picked in one chat is the default for new chats, and must not
// redirect another chat's next message.
describe('a model picked in another chat, with Auto on', () => {
	const nextSwitch = () => document.querySelector('[data-model-next-switch]');
	const rows = () => [...document.querySelectorAll<HTMLElement>('[role="menu"] [data-model-id]:not([disabled])')];

	// The two models the menu offers first, read from the flat menu Auto off renders, so both are ones
	// the picker serves. With Auto on they sit in the "Choose a model yourself" submenu.
	async function servedPair() {
		autoFlag.on = false;
		render(Harness, { props: { onEmbeddedNavigate, started: true } });
		await modelButton().click();
		await expect.element(page.getByRole('menu')).toBeVisible();
		const [own, other] = rows().map((r) => catalogByGatewayId(r.dataset.modelId)!);
		cleanup();
		autoFlag.on = true;
		expect(other, 'the menu offers fewer than two models').toBeDefined();
		return { own, other };
	}

	beforeEach(() => {
		cleanup();
		autoFlag.on = true;
		openChat.id = 'older-chat';
		modelChoice.set(AUTO);
	});
	afterEach(() => {
		autoFlag.on = false;
		openChat.id = undefined;
		modelChoice.set(AUTO);
	});

	it("leaves an older chat's next message on that chat's own model", async () => {
		const { own, other } = await servedPair();
		modelChoice.set(other.id);
		render(Harness, { props: { onEmbeddedNavigate, started: true, chatModelId: own.gatewayId } });
		await modelButton().click();
		await expect.element(page.getByRole('menu')).toBeVisible();
		expect(nextSwitch(), `the older chat says its next message goes to ${other.family}`).toBeNull();
	});

	it('switches the chat a model is picked in, from its next message', async () => {
		const { own, other } = await servedPair();
		render(Harness, { props: { onEmbeddedNavigate, started: true, chatModelId: own.gatewayId } });
		await modelButton().click();
		await page.getByRole('menuitem', { name: /Choose a model yourself/ }).click();
		await expect.poll(() => rows().length).toBeGreaterThan(1);
		const row = rows().find((r) => r.dataset.modelId === other.gatewayId);
		expect(row, `no menu row for ${other.gatewayId}`).toBeDefined();
		row!.click();
		await modelButton().click();
		const label = other.family === own.family ? other.name : other.family;
		await expect.poll(() => nextSwitch()?.textContent ?? '').toContain(`Next message goes to ${label}`);
	});

	// Large 3 to Medium 3.5 must not read "Next message goes to Mistral, not Mistral." (CUR-4357)
	it('names both models, not their shared family, when switching within one family', async () => {
		autoFlag.on = false;
		render(Harness, { props: { onEmbeddedNavigate, started: true } });
		await modelButton().click();
		await expect.element(page.getByRole('menu')).toBeVisible();
		const served = rows().map((r) => catalogByGatewayId(r.dataset.modelId)!);
		cleanup();
		const own = served.find((m) => served.some((o) => o.id !== m.id && o.family === m.family));
		const other = served.find((m) => m.id !== own?.id && m.family === own?.family);
		expect(other, 'the menu serves no two models of one family').toBeDefined();
		autoFlag.on = true;
		render(Harness, { props: { onEmbeddedNavigate, started: true, chatModelId: own!.gatewayId } });
		await modelButton().click();
		await page.getByRole('menuitem', { name: /Choose a model yourself/ }).click();
		await expect.poll(() => rows().length).toBeGreaterThan(1);
		rows().find((r) => r.dataset.modelId === other!.gatewayId)!.click();
		await modelButton().click();
		await expect
			.poll(() => nextSwitch()?.textContent ?? '')
			.toContain(`Next message goes to ${other!.name}, not ${own!.name}.`);
		expect(nextSwitch()?.textContent).not.toContain(`goes to ${own!.family}, not ${own!.family}`);
	});

	it('keeps the Auto row checked in an older chat when Auto is the choice', async () => {
		const { own } = await servedPair();
		render(Harness, { props: { onEmbeddedNavigate, started: true, chatModelId: own.gatewayId } });
		await modelButton().click();
		await expect.element(page.getByRole('menu')).toBeVisible();
		await expect.element(page.getByRole('menuitemradio', { name: /^Auto/ })).toHaveAttribute('aria-checked', 'true');
		expect(nextSwitch()).toBeNull();
	});
});
