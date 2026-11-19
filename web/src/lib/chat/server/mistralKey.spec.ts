import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg: Record<string, string | undefined> = {};
vi.mock('$lib/chat/server/config', () => ({ config: cfg }));

const { mistralKeyEnv, mistralChatLane, onRouterLane, parseWireIds, ticketBranchAllowlist } = await import(
	'./mistralKey'
);

describe('mistralKey', () => {
	beforeEach(() => {
		for (const k of Object.keys(cfg)) delete cfg[k];
		cfg.MISTRAL_API_KEY = 'main-workspace';
	});

	it('bills the CI workspace on a per-ticket branch preview when MISTRAL_API_KEY_CI is set', () => {
		cfg.MISTRAL_API_KEY_CI = 'ci-workspace';
		expect(mistralKeyEnv('dev/cur-1-thing')).toBe('MISTRAL_API_KEY_CI');
		expect(mistralChatLane('dev/cur-1-thing').apiKey).toBe('ci-workspace');
	});

	it('keeps develop and main on MISTRAL_API_KEY even when the CI key is set', () => {
		cfg.MISTRAL_API_KEY_CI = 'ci-workspace';
		expect(mistralChatLane('develop').apiKey).toBe('main-workspace');
		expect(mistralChatLane('main').apiKey).toBe('main-workspace');
	});

	it('falls back to MISTRAL_API_KEY everywhere while MISTRAL_API_KEY_CI is unset, so merging changes nothing', () => {
		expect(mistralChatLane('dev/cur-1-thing').apiKey).toBe('main-workspace');
	});

	it('uses MISTRAL_API_KEY when the branch is unknown (local dev, no VERCEL_GIT_COMMIT_REF)', () => {
		cfg.MISTRAL_API_KEY_CI = 'ci-workspace';
		expect(mistralChatLane('').apiKey).toBe('main-workspace');
	});
});

describe('ticketBranchAllowlist', () => {
	const SPEC = 'mistral-large-2512,swiss-ai/apertus-v1.5-70b,mistral-small-2603';

	it('puts TASK_MODEL first on a per-ticket branch preview, so CI turns default to Mistral Small', () => {
		expect(ticketBranchAllowlist(SPEC, 'dev/cur-1-thing', 'mistral-small-2603')).toBe(
			'mistral-small-2603,mistral-large-2512,swiss-ai/apertus-v1.5-70b'
		);
	});

	it('keeps Large 3 as the user default on develop and main', () => {
		expect(ticketBranchAllowlist(SPEC, 'develop', 'mistral-small-2603')).toBe(SPEC);
		expect(ticketBranchAllowlist(SPEC, 'main', 'mistral-small-2603')).toBe(SPEC);
	});

	it('offers no MISTRAL_MODELS id the picker leaves out on a per-ticket branch, so Large 3 stays off it', () => {
		cfg.MISTRAL_MODELS = 'mistral-large-2512,mistral-small-2603,mistral-medium-2604,mistral-large-2610';
		const picker = 'mistral-medium-2604,mistral-large-2610,swiss-ai/apertus-v1.5-70b';
		expect(ticketBranchAllowlist(picker, 'dev/cur-1-thing', 'mistral-small-2603')).toBe(
			'mistral-small-2603,mistral-medium-2604,mistral-large-2610,swiss-ai/apertus-v1.5-70b'
		);
	});

	it('changes nothing when the branch is unknown, TASK_MODEL is unset, or the spec is a wildcard', () => {
		expect(ticketBranchAllowlist(SPEC, '', 'mistral-small-2603')).toBe(SPEC);
		expect(ticketBranchAllowlist(SPEC, 'dev/cur-1-thing', '')).toBe(SPEC);
		expect(ticketBranchAllowlist('*', 'dev/cur-1-thing', 'mistral-small-2603')).toBe('*');
	});
});

describe('mistralChatLane', () => {
	beforeEach(() => {
		for (const k of Object.keys(cfg)) delete cfg[k];
		cfg.MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
		cfg.MISTRAL_API_KEY = 'main-workspace';
	});

	it('sends chat to the router with its key and id map when both router vars are set', () => {
		cfg.MISTRAL_CHAT_BASE_URL = 'https://router.example.test/v1';
		cfg.MISTRAL_CHAT_API_KEY = 'router-dev';
		cfg.MISTRAL_CHAT_MODEL_MAP = 'mistral-large-2512=mistralai/mistral-large-2512';
		expect(mistralChatLane('develop')).toEqual({
			baseURL: 'https://router.example.test/v1',
			apiKey: 'router-dev',
			keyEnv: 'MISTRAL_CHAT_API_KEY',
			wireIds: { 'mistral-large-2512': 'mistralai/mistral-large-2512' },
		});
	});

	it('keeps a per-ticket preview billing the CI workspace on La Plateforme, off the router limit develop needs', () => {
		cfg.MISTRAL_CHAT_BASE_URL = 'https://router.example.test/v1';
		cfg.MISTRAL_CHAT_API_KEY = 'router-dev';
		cfg.MISTRAL_API_KEY_CI = 'ci-workspace';
		expect(mistralChatLane('dev/cur-1-thing')).toMatchObject({
			baseURL: 'https://api.mistral.ai/v1',
			apiKey: 'ci-workspace',
			wireIds: { 'mistral-large-2610': 'mistral-large-4-0' },
		});
	});

	it('calls the router with MISTRAL_CHAT_CI_API_KEY on a per-ticket preview, so CI usage shows on its own key', () => {
		cfg.MISTRAL_CHAT_BASE_URL = 'https://router.example.test/v1';
		cfg.MISTRAL_CHAT_API_KEY = 'router-dev';
		cfg.MISTRAL_CHAT_CI_API_KEY = 'router-ci';
		expect(mistralChatLane('dev/cur-1-thing')).toMatchObject({
			baseURL: 'https://router.example.test/v1',
			apiKey: 'router-ci',
			keyEnv: 'MISTRAL_CHAT_CI_API_KEY',
		});
		expect(onRouterLane(mistralChatLane('dev/cur-1-thing'))).toBe(true);
	});

	it('reads only the two router keys as the router lane, so the warm probe and version list treat a CI-keyed lane as the router', () => {
		expect(onRouterLane({ keyEnv: 'MISTRAL_CHAT_API_KEY' })).toBe(true);
		expect(onRouterLane({ keyEnv: 'MISTRAL_CHAT_CI_API_KEY' })).toBe(true);
		expect(onRouterLane({ keyEnv: 'MISTRAL_API_KEY' })).toBe(false);
		expect(onRouterLane({ keyEnv: 'MISTRAL_API_KEY_CI' })).toBe(false);
	});

	it('keeps develop, main and an unknown branch on MISTRAL_CHAT_API_KEY when the CI router key is set', () => {
		cfg.MISTRAL_CHAT_BASE_URL = 'https://router.example.test/v1';
		cfg.MISTRAL_CHAT_API_KEY = 'router-dev';
		cfg.MISTRAL_CHAT_CI_API_KEY = 'router-ci';
		for (const branch of ['develop', 'main', '']) {
			expect(mistralChatLane(branch)).toMatchObject({ apiKey: 'router-dev', keyEnv: 'MISTRAL_CHAT_API_KEY' });
		}
	});

	it('keeps a per-ticket preview on MISTRAL_CHAT_API_KEY while the CI router key is unset, so merging changes nothing', () => {
		cfg.MISTRAL_CHAT_BASE_URL = 'https://router.example.test/v1';
		cfg.MISTRAL_CHAT_API_KEY = 'router-dev';
		expect(mistralChatLane('dev/cur-1-thing')).toMatchObject({ apiKey: 'router-dev', keyEnv: 'MISTRAL_CHAT_API_KEY' });
	});

	it('stays on La Plateforme, unchanged, while either router var is unset', () => {
		cfg.MISTRAL_CHAT_BASE_URL = 'https://router.example.test/v1';
		expect(mistralChatLane('develop')).toEqual({
			baseURL: 'https://api.mistral.ai/v1',
			apiKey: 'main-workspace',
			keyEnv: 'MISTRAL_API_KEY',
			wireIds: { 'mistral-large-2610': 'mistral-large-4-0' },
		});
	});

	it('sends Large 4 to La Plateforme as mistral-large-4-0, the id it lists, since it has no mistral-large-2610', () => {
		expect(mistralChatLane('develop').wireIds['mistral-large-2610']).toBe('mistral-large-4-0');
		expect(mistralChatLane('develop').wireIds['mistral-large-2512']).toBeUndefined();
	});

	it('parses ours=theirs pairs and skips a pair missing either side', () => {
		expect(parseWireIds('a=x/a, b = x/b ,c=,=d,e')).toEqual({ a: 'x/a', b: 'x/b' });
	});
});
