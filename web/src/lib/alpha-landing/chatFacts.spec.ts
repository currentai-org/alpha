import { describe, expect, it } from 'vitest';
import { CHAT_HOST } from '$lib/chat/paths';
import { RETENTION_DAYS } from '$lib/chat/constants/retention';
import { DATA_HOME, MODEL_HOSTS, orgs } from '$lib/chat/routing/catalog';
import { MOZILLA_DATA_COLLECTIVE } from '$lib/chat/contribute';
import * as site from './chatFacts';

// The site keeps its own copy of the facts /alpha states about Alpha, so it can leave chat's code
// behind when chat moves to the public repo. Until then, every value it copies must equal chat's.
describe("the /alpha landing's facts about Alpha match chat's own", () => {
	it('names the host chat is served on', () => {
		expect(site.CHAT_HOST).toBe(CHAT_HOST);
	});

	it('states the guest retention chat enforces', () => {
		expect(site.GUEST_RETENTION_DAYS).toBe(RETENTION_DAYS);
	});

	it('says where conversations are stored, in the words chat uses', () => {
		expect(site.CHATS_STORED_BY).toBe(DATA_HOME.chats);
	});

	it('names the organisation the catalog routes Apertus to', () => {
		const host = orgs[MODEL_HOSTS['apertus-70b']];
		expect(site.APERTUS_HOST).toBe(host.region ? `${host.name} in ${host.region}` : host.name);
	});

	it("links the Mozilla Data Collective chat's contribute page links", () => {
		expect(site.MOZILLA_DATA_COLLECTIVE_HOME).toBe(MOZILLA_DATA_COLLECTIVE.home);
	});
});
