// config/posthogRegion.mjs is where every PostHog consumer reads its region. Unset, it must
// name the live project, EU 345429, where production moved from US.
import { describe, expect, it } from 'vitest';
import {
	CLOUD_HOSTS,
	posthogAppHost,
	posthogAssetsHost,
	posthogIngestHost,
	posthogProjectId
} from '../../config/posthogRegion.mjs';
import * as upstream from './posthogUpstream';

describe('posthogRegion — unset env names the live EU project', () => {
	it('defaults every value to EU', () => {
		expect(posthogIngestHost({})).toBe('https://eu.i.posthog.com');
		expect(posthogAssetsHost(posthogIngestHost({}))).toBe('https://eu-assets.i.posthog.com');
		expect(posthogAppHost({})).toBe('https://eu.posthog.com');
		expect(posthogProjectId({})).toBe('345429');
	});

	it('ignores a relative, non-https or path-carrying value', () => {
		for (const bad of ['/rs', 'http://ph.example.org', 'https://ph.example.org/x', 'eu', ' ']) {
			expect(posthogIngestHost({ POSTHOG_INGEST_HOST: bad })).toBe('https://eu.i.posthog.com');
			expect(posthogAppHost({ POSTHOG_APP_HOST: bad })).toBe('https://eu.posthog.com');
		}
		expect(posthogProjectId({ POSTHOG_PROJECT_ID: 'abc' })).toBe('345429');
	});
});

describe('posthogRegion — an explicit EU env moves every value together', () => {
	const EU = {
		POSTHOG_INGEST_HOST: 'https://eu.i.posthog.com',
		POSTHOG_APP_HOST: 'https://eu.posthog.com',
		POSTHOG_PROJECT_ID: '345429'
	};

	it('reads the EU hosts and project', () => {
		expect(posthogIngestHost(EU)).toBe('https://eu.i.posthog.com');
		expect(posthogAssetsHost(posthogIngestHost(EU))).toBe('https://eu-assets.i.posthog.com');
		expect(posthogAppHost(EU)).toBe('https://eu.posthog.com');
		expect(posthogProjectId(EU)).toBe('345429');
	});

	it('derives the app host from a cloud ingest host when POSTHOG_APP_HOST is unset', () => {
		expect(posthogAppHost({ POSTHOG_INGEST_HOST: 'https://eu.i.posthog.com' })).toBe(
			'https://eu.posthog.com'
		);
	});

	it('treats a self-hosted origin as its own app and assets host', () => {
		const self = { POSTHOG_INGEST_HOST: 'https://ph.example.org' };
		expect(posthogAssetsHost(posthogIngestHost(self))).toBe('https://ph.example.org');
		expect(posthogAppHost(self)).toBe('https://ph.example.org');
	});

	it('lists an ingest and an assets host per cloud region for the transition CSP, EU included', () => {
		expect(CLOUD_HOSTS).toHaveLength(4);
		expect(CLOUD_HOSTS).toEqual(
			expect.arrayContaining(['https://eu.i.posthog.com', 'https://eu-assets.i.posthog.com'])
		);
		for (const h of CLOUD_HOSTS)
			expect(h).toMatch(/^https:\/\/[a-z]{2}(-assets)?\.i\.posthog\.com$/);
	});
});

describe('posthogUpstream — the app reads the same logic', () => {
	it('re-exports the region functions', () => {
		expect(upstream.posthogIngestHost).toBe(posthogIngestHost);
		expect(upstream.posthogAssetsHost).toBe(posthogAssetsHost);
	});
});
