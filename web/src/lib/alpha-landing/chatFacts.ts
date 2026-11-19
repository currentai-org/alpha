/**
 * Facts about Alpha that the /alpha landing states in its copy and feature cards.
 *
 * The site's own copy of values chat defines, because chat moves to the public alpha repo and the
 * site may not import it. It lives beside the landing, not in `$lib/website`, because the
 * public snapshot ships the landing and leaves `$lib/website` out. `chatFacts.spec.ts` checks each one against chat's source, so
 * the two cannot drift while both live in this repo.
 */
import { DEPLOYMENT } from '$lib/deployment';

/** Chat's own host (chat's paths.ts, from the installation's deployment file), or null for none. */
export const CHAT_HOST: string | null = DEPLOYMENT.chatHost;

/** Days a guest's conversations are kept (chat's constants/retention.ts). */
export const GUEST_RETENTION_DAYS = 30;

/** Where conversations and settings are stored, as a full sentence (chat's DATA_HOME.chats). */
export const CHATS_STORED_BY =
	'Your conversations and settings are stored by Current AI in Alpha’s own database.';

/** Who runs Apertus, and where (the Apertus host in chat's routing catalog). */
export const APERTUS_HOST = 'Phoeniqs in Switzerland';

/** The Mozilla Data Collective's home page (chat's contribute.ts). */
export const MOZILLA_DATA_COLLECTIVE_HOME = 'https://mozilladatacollective.com';
