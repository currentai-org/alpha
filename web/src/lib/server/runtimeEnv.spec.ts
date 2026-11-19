// The contract that makes the host-neutral refactor a no-op on Vercel: with the neutral name unset or
// blank, every accessor returns exactly what the VERCEL_* variable held, undefined and "" included, so
// a call site that used to read `process.env.VERCEL_X` cannot tell the difference.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	deployEnvName,
	deployEnvSources,
	deploymentUrl,
	gitRef,
	gitSha,
	previewBypassSecret,
	previousBuildSha,
	productionUrl,
	region
} from './runtimeEnv.js';

const PAIRS = [
	['deployEnvName', deployEnvName, 'DEPLOY_ENV', 'VERCEL_ENV'],
	['gitRef', gitRef, 'GIT_REF', 'VERCEL_GIT_COMMIT_REF'],
	['gitSha', gitSha, 'GIT_SHA', 'VERCEL_GIT_COMMIT_SHA'],
	['deploymentUrl', deploymentUrl, 'DEPLOYMENT_URL', 'VERCEL_URL'],
	['productionUrl', productionUrl, 'PRODUCTION_URL', 'VERCEL_PROJECT_PRODUCTION_URL'],
	['region', region, 'REGION', 'VERCEL_REGION']
] as const;

describe.each(PAIRS)('%s', (_name, read, own, host) => {
	it(`returns ${host} untouched when ${own} is unset — Vercel today, where nothing sets ${own}`, () => {
		expect(read({ [host]: 'v' })).toBe('v');
		expect(read({ [host]: '' })).toBe('');
		expect(read({})).toBeUndefined();
	});

	it(`falls through a blank ${own} exactly like an absent one (the scaffolded .env declares every key)`, () => {
		expect(read({ [own]: '', [host]: 'v' })).toBe('v');
		expect(read({ [own]: '' })).toBeUndefined();
	});

	it(`lets ${own} win over ${host} when it holds a value — the host move is a config change`, () => {
		expect(read({ [own]: 'ours', [host]: 'theirs' })).toBe('ours');
		expect(read({ [own]: 'ours' })).toBe('ours');
	});
});

describe('Vercel-only accessors', () => {
	it('read only the Vercel names, since nothing replaces them under another name', () => {
		expect(previewBypassSecret({ VERCEL_AUTOMATION_BYPASS_SECRET: 's' })).toBe('s');
		expect(previousBuildSha({ VERCEL_GIT_PREVIOUS_SHA: 'abc' })).toBe('abc');
		expect(previewBypassSecret({})).toBeUndefined();
		expect(previousBuildSha({})).toBeUndefined();
	});
});

describe('the default record', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('reads process.env at call time, so a spec that stubs it per test sees its own stub', () => {
		vi.stubEnv('DEPLOY_ENV', '');
		vi.stubEnv('VERCEL_ENV', 'preview');
		expect(deployEnvName()).toBe('preview');
		vi.stubEnv('VERCEL_ENV', 'production');
		expect(deployEnvName()).toBe('production');
	});

	it('reports both deploy-env inputs, null for an unset one, for the diagnostic that names the missing one', () => {
		expect(deployEnvSources({ VERCEL_ENV: 'preview' })).toEqual({
			DEPLOY_ENV: null,
			VERCEL_ENV: 'preview'
		});
	});
});
