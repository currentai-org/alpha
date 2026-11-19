import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readDeploymentFile } from '../../config/deployment.mjs';
import { DEPLOYMENT, NEUTRAL_DEPLOYMENT } from './deployment';

const dir = mkdtempSync(join(tmpdir(), 'deployment-spec-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, body: string): string {
	const path = join(dir, name);
	writeFileSync(path, body);
	return path;
}

describe('an installation with no deployment file names no host of its own', () => {
	it('leaves every host, the apex and the publisher unset', () => {
		expect(NEUTRAL_DEPLOYMENT.apexDomain).toBeNull();
		expect(NEUTRAL_DEPLOYMENT.siteHost).toBeNull();
		expect(NEUTRAL_DEPLOYMENT.siteDevelopHost).toBeNull();
		expect(NEUTRAL_DEPLOYMENT.chatHost).toBeNull();
		expect(NEUTRAL_DEPLOYMENT.chatDevelopHost).toBeNull();
		expect(NEUTRAL_DEPLOYMENT.chatAliasHosts).toEqual([]);
		expect(NEUTRAL_DEPLOYMENT.modelRouterHost).toBeNull();
		expect(NEUTRAL_DEPLOYMENT.statusPageUrl).toBeNull();
		expect(NEUTRAL_DEPLOYMENT.mailFrom).toBeNull();
		expect(NEUTRAL_DEPLOYMENT.contactEmail).toBeNull();
		expect(NEUTRAL_DEPLOYMENT.publisher).toBeNull();
		expect(NEUTRAL_DEPLOYMENT.previewTrustedOrigins).toEqual([]);
		expect(NEUTRAL_DEPLOYMENT.mediaOrigins).toEqual([]);
	});

	it('names itself Alpha in User-Agent headers and exports', () => {
		expect(NEUTRAL_DEPLOYMENT.userAgent).toBe('alpha-chat');
		expect(NEUTRAL_DEPLOYMENT.sourceName).toBe('Alpha');
	});
});

describe('the unit tests run as a split installation on reserved example.test hosts', () => {
	it('reads config/deployment.test.json, so specs exercise the site/chat split', () => {
		expect(DEPLOYMENT.siteHost).toBe('www.example.test');
		expect(DEPLOYMENT.chatHost).toBe('alpha.example.test');
		expect(DEPLOYMENT.apexDomain).toBe('example.test');
	});
});

describe('readDeploymentFile', () => {
	it('returns the object the file DEPLOYMENT_CONFIG names', () => {
		const path = file('ok.json', JSON.stringify({ chatHost: 'chat.example.net' }));
		expect(readDeploymentFile({ DEPLOYMENT_CONFIG: path })).toEqual({
			chatHost: 'chat.example.net'
		});
	});

	it('refuses a DEPLOYMENT_CONFIG that names no file, rather than building with neutral hosts', () => {
		expect(() => readDeploymentFile({ DEPLOYMENT_CONFIG: join(dir, 'missing.json') })).toThrow(
			/names no file/
		);
	});

	it('refuses a file that does not hold a JSON object', () => {
		const path = file('list.json', '["www.example.net"]');
		expect(() => readDeploymentFile({ DEPLOYMENT_CONFIG: path })).toThrow(/JSON object/);
	});
});

describe('the deployment files in this tree', () => {
	// config/deployment.json is the installation's own and stays out of the public export; a tree
	// without it builds with the neutral defaults.
	for (const name of ['config/deployment.json', 'config/deployment.test.json']) {
		const env = { DEPLOYMENT_CONFIG: name };
		let values: Record<string, unknown> | null = null;
		try {
			values = readDeploymentFile(env);
		} catch {
			values = null;
		}
		it.skipIf(values === null)(
			`${name} names only keys the app reads, so the build accepts it`,
			() => {
				const unknown = Object.keys(values ?? {}).filter((key) => !(key in NEUTRAL_DEPLOYMENT));
				expect(unknown).toEqual([]);
			}
		);
	}
});
