import { modelIdServedAs } from '../../../../config/picker';
import { HF_PROVIDER_PIN } from '../server/hfProviderPin';
/**
 * Who makes each model Alpha can route to, and who runs it — the facts behind the model picker and
 * the provenance panel. Plain data, safe on client and server.
 *
 * `status` is the honest part:
 *   - `live`        — served through the gateway today (`gatewayId` is the id `/models` returns);
 *   - `in-progress` — being wired up, not answerable yet;
 *   - `stub`        — planned; listed so the picker and credits can be designed around it.
 * Only a `live` entry that the registry actually serves (`page.data.models`) is ever selected — the
 * router checks that at call time rather than trusting this file.
 *
 * Adding a model takes one row in `models` below, `status: 'live'`, with the `gatewayId` the gateway
 * serves it under. Each environment's `MODEL_ALLOWLIST` is the switch: once it names that id, the
 * model shows in the picker there. Auto only routes to it once `data/benchmarks.json` has a row for
 * it; until then people can still pick it by hand.
 *
 * Who runs what is `MODEL_HOSTS` (typed in `PLANNED_HOSTS`, or taken from a model's Hugging Face provider
 * pin), which model host is which org is `BACKEND_HOSTS`, and where your data is kept is `DATA_HOME`.
 */

export type OrgId =
	| 'swiss-ai'
	| 'bsc'
	| 'ai-singapore'
	| 'speakleash'
	| 'zhipu'
	| 'mistral'
	| 'cohere'
	| 'infomaniak'
	| 'scaleway'
	| 'cscs'
	| 'nextbit'
	| 'bielik-ai'
	| 'plgrid'
	| 'phoeniqs'
	| 'featherless'
	| 'huggingface'
	| 'cloudflare'
	| 'openrouter'
	| 'mozilla-data-collective'
	| 'common-voice';

export interface Org {
	id: OrgId;
	name: string;
	/** One plain sentence a non-technical reader can follow. */
	blurb: string;
	/** Country or region, or undefined when unverified — never guessed. */
	region?: string;
	/** Omitted when unverified. */
	url?: string;
	/** Non-profit / public-sector / academic — surfaced in the credits. */
	public?: boolean;
	/** Square mark, vendored under static/logos (see its README). Absent → monogram. */
	logo?: string;
}

export const orgs: Record<OrgId, Org> = {
	'swiss-ai': {
		id: 'swiss-ai',
		logo: '/logos/swiss-ai.png',
		name: 'Swiss National AI Institute',
		blurb: 'EPFL, ETH Zurich and CSCS — a public, fully open model trained on openly licensed data.',
		region: 'Switzerland',
		url: 'https://www.swiss-ai.org',
		public: true
	},
	bsc: {
		id: 'bsc',
		logo: '/logos/bsc.png',
		name: 'Barcelona Supercomputing Center',
		blurb: 'Spain’s national supercomputing centre, building open models for Spanish and co-official languages.',
		region: 'Spain',
		url: 'https://www.bsc.es',
		public: true
	},
	'ai-singapore': {
		id: 'ai-singapore',
		logo: '/logos/ai-singapore.png',
		name: 'AI Singapore',
		blurb: 'A national programme building SEA-LION, open models for Southeast Asian languages.',
		region: 'Singapore',
		url: 'https://aisingapore.org',
		public: true
	},
	speakleash: {
		id: 'speakleash',
		logo: '/logos/speakleash.png',
		name: 'SpeakLeash',
		blurb: 'An open-science community building Bielik, a model for Polish.',
		region: 'Poland',
		url: 'https://speakleash.org',
		public: true
	},
	zhipu: {
		id: 'zhipu',
		logo: '/logos/zhipu.png',
		name: 'Zhipu AI',
		blurb: 'Makers of GLM, an openly released general-purpose model.',
		region: 'China',
		url: 'https://z.ai'
	},
	mistral: {
		id: 'mistral',
		logo: '/logos/mistral.png',
		name: 'Mistral AI',
		blurb: 'A European AI lab known for strong multilingual models.',
		region: 'France',
		url: 'https://mistral.ai'
	},
	cohere: {
		id: 'cohere',
		logo: '/logos/cohere.png',
		name: 'Cohere',
		blurb: 'Makers of Command, built for multilingual business use.',
		region: 'Canada',
		url: 'https://cohere.com'
	},
	infomaniak: {
		id: 'infomaniak',
		logo: '/logos/infomaniak.png',
		name: 'Infomaniak',
		blurb: 'An independent Swiss cloud that runs its data centres in Switzerland.',
		region: 'Switzerland',
		url: 'https://www.infomaniak.com'
	},
	cscs: {
		id: 'cscs',
		logo: '/logos/cscs.png',
		name: 'CSCS',
		blurb: 'The Swiss National Supercomputing Centre, home of the machines Apertus was trained on.',
		region: 'Switzerland',
		url: 'https://www.cscs.ch',
		public: true
	},
	nextbit: {
		id: 'nextbit',
		name: 'NextBit',
		blurb: 'Runs ALIA for Alpha.'
	},
	'bielik-ai': {
		id: 'bielik-ai',
		name: 'Bielik.ai',
		blurb: 'Runs Bielik for Alpha.',
		url: 'https://bielik.ai'
	},
	// No square mark vendored yet, so the monogram stands in.
	scaleway: {
		id: 'scaleway',
		name: 'Scaleway',
		// Paris and no retention: the provider pin's own record (server/modelProfiles.ts HF_PROVIDER_PIN).
		blurb: 'A French cloud in Paris. It runs GLM for Alpha through Hugging Face without keeping what you send, and serves Mistral Medium 3.5 as a second host beside Mistral’s own.',
		region: 'France',
		url: 'https://www.scaleway.com'
	},
	// No square mark vendored yet, so the monogram stands in.
	plgrid: {
		id: 'plgrid',
		name: 'PLGrid',
		blurb: "Poland's national research computing infrastructure, run by ACC Cyfronet AGH in Kraków. It runs Bielik for Alpha.",
		region: 'Poland',
		url: 'https://www.plgrid.pl',
		public: true
	},
	phoeniqs: {
		id: 'phoeniqs',
		logo: '/logos/phoeniqs.png',
		name: 'Phoeniqs',
		// Phoenix Technologies AG, Pfäffikon SZ (its imprint), on an IP block RIPE registers in CH to that
		// company (CUR-4545).
		blurb: 'The AI cloud of Phoenix Technologies, a Swiss company. It runs Apertus 1.5 70B for Alpha.',
		region: 'Switzerland',
		url: 'https://phoeniqs.com'
	},
	featherless: {
		id: 'featherless',
		logo: '/logos/featherless.png',
		name: 'Featherless',
		blurb: 'An American host for open models, one of the backends the inference gateway can send a turn to.',
		region: 'United States',
		url: 'https://featherless.ai'
	},
	huggingface: {
		id: 'huggingface',
		logo: '/logos/huggingface.png',
		name: 'Hugging Face',
		blurb: 'The home of open models — runs inference for some of them.',
		url: 'https://huggingface.co'
	},
	cloudflare: {
		id: 'cloudflare',
		logo: '/logos/cloudflare.png',
		name: 'Cloudflare',
		blurb: 'Made Clef, the open-weight classifier Auto asks to read a draft.',
		url: 'https://www.cloudflare.com'
	},
	'mozilla-data-collective': {
		id: 'mozilla-data-collective',
		logo: '/logos/mozilla-data-collective.png',
		name: 'Mozilla Data Collective',
		blurb: 'A community-governed home for datasets, where whoever shares one sets its terms.',
		url: 'https://mozilladatacollective.com',
		public: true
	},
	'common-voice': {
		id: 'common-voice',
		logo: '/logos/common-voice.png',
		name: 'Common Voice',
		blurb: 'Mozilla’s open collection of recorded speech, in more than a hundred languages.',
		url: 'https://commonvoice.mozilla.org',
		public: true
	},
	openrouter: {
		id: 'openrouter',
		logo: '/logos/openrouter.png',
		name: 'OpenRouter',
		blurb: 'A service that connects to many model hosts through one door.',
		url: 'https://openrouter.ai'
	}
};

/**
 * ── Associations: who does what for Alpha, today. ─────────────────────────────────────────────────
 * The one place to edit when a model moves host or storage changes. XRAY, the model picker and the
 * credits all read from here and state it plainly — no history, no hedging. A model left out of
 * `MODEL_HOSTS` simply shows no "where it runs" line.
 */

/**
 * Where Alpha keeps what you give it. Every screen that says where your data lives reads these words,
 * so they cannot drift apart. Only what is true today (CUR-415): conversations and settings sit in
 * Alpha's own Postgres (`server/db/client.ts`); only the files a person uploads sit with Hugging Face,
 * in a bucket Current AI holds (`server/storage/custodialStorage.ts`). Plain constants rather than the
 * admin-editable copy CMS, because a privacy statement has to stay tied to the code.
 */
export const DATA_HOME = {
	/** Conversations and settings, as a full sentence. */
	chats: 'Your conversations and settings are stored by Current AI in Alpha’s own database.',
	/** The same fact as a lead line and its caption, for tiles and rows already under a "your data" heading. */
	chatsLead: 'Stored by Current AI',
	chatsWhere: 'in Alpha’s own database',
	/** Files a person uploads. */
	// The wording names Current AI and says who that is. (CUR-2070)
	files: 'Files you upload are stored with Hugging Face, in storage held by Current AI, the nonprofit that runs Alpha.',
	/** The same, once the person has linked a bucket of their own (CUR-3386): its files are theirs, not ours. */
	filesWithLinkedBucket:
		'Files in Alpha storage are stored with Hugging Face, in storage held by Current AI, the nonprofit that runs Alpha. A bucket you linked is yours: its files stay in your own Hugging Face account.',
	/** Who holds uploaded files, for screens that credit them with a logo. */
	filesHost: 'huggingface' as OrgId
} as const;

/**
 * Every model host a turn's routing record can name, by host: the one table behind each "where did
 * this answer run" surface (the provenance badge and footer, X-ray's route and compute rows) and behind
 * the Swiss claim. Name, link, logo and country are the org's, so a host is one row here and nothing
 * else.
 *
 * Swiss means the org's `region` is Switzerland, and that region is only ever set once verified. That
 * is the claim "sovereign public compute in Switzerland" rests on, so a host earns it here by its org,
 * never by being nameable (CUR-996): Featherless and AI Singapore have rows and are not Swiss.
 *
 * `service` names the org's product on that host, when the host is one service among the org's.
 * Hosts are measured backends, not plans: `MODEL_HOSTS` says who is meant to run a model, this
 * says who a host is. Routers and gateways (router.stg, api-internal) are not here: they name no
 * compute. `pnpm gen:served-backends` writes the copy the scripts, the evals and agent-service read
 * (config/served-backends.generated.json); `servedBackends.spec.ts` fails when it drifts.
 */
export const BACKEND_HOSTS: Record<string, { org: OrgId; service?: string }> = {
	'api.inference.cscs.ch': { org: 'cscs' },
	// CSCS's own inference API, which agent-service dials directly (PROVIDER_CSCS_BASE,
	// agent-service/fly/agent-proxy.toml). The chat's direct CSCS lane is retired (CUR-162).
	'api.swissai.svc.cscs.ch': { org: 'cscs' },
	'api.infomaniak.com': { org: 'infomaniak' },
	// Apertus 1.5 70B's host, as its turns record it on www and alpha (CUR-4545).
	'maas.phoeniqs.com': { org: 'phoeniqs' },
	'api.featherless.ai': { org: 'featherless' },
	'api.sea-lion.ai': { org: 'ai-singapore' },
	'api.mistral.ai': { org: 'mistral', service: 'La Plateforme' },
	// ALIA's and Bielik's hosts, as their turns record them on www (CUR-3941).
	'api.nextbit256.com': { org: 'nextbit' },
	'llmlab.plgrid.pl': { org: 'plgrid' },
	// The staging router answers Mistral Medium 3.5 from here as well as from La Plateforme (CUR-4343).
	'api.scaleway.ai': { org: 'scaleway' }
};

/** A model host as its org describes it. `label` is the readable name with the country when the org
 *  has one, e.g. "Mistral AI La Plateforme (France)"; "NextBit" when its country is on no record. */
export interface BackendOrg {
	host: string;
	org: Org;
	name: string;
	country?: string;
	label: string;
	swiss: boolean;
}

/** The org behind a bare backend host, or undefined for a host the catalog does not know. */
export function backendOrg(host: string): BackendOrg | undefined {
	const row = Object.hasOwn(BACKEND_HOSTS, host) ? BACKEND_HOSTS[host] : undefined;
	if (!row) return undefined;
	const org = orgs[row.org];
	const name = row.service ? `${org.name} ${row.service}` : org.name;
	const country = org.region;
	return { host, org, name, country, label: country ? `${name} (${country})` : name, swiss: country === 'Switzerland' };
}

/** The hosts an answer may come from while the Swiss compute claim stays true, sorted. */
export const SWISS_BACKEND_HOSTS: readonly string[] = Object.keys(BACKEND_HOSTS)
	.filter((host) => backendOrg(host)?.swiss)
	.sort();

/**
 * Who is meant to run each model, keyed by catalog id, for a model the Hugging Face router does not pin.
 * A pinned model's host is its pin (`HF_PROVIDER_PIN`, `MODEL_HOSTS` below), so it is not typed here.
 */
const PLANNED_HOSTS: Record<string, OrgId> = {
	// The gateway serves the 70B from one provider, Phoeniqs (gateway request log;
	// `server/harnessProfiles.ts`, CUR-4403).
	'apertus-70b': 'phoeniqs',
	'apertus-8b': 'infomaniak',
	'alia-40b': 'nextbit',
	'sea-lion-qwen-32b': 'ai-singapore',
	'sea-lion-gemma-27b': 'ai-singapore',
	// The gateway serves all three SEA-LIONs from AI Singapore's own API (api_base api.sea-lion.ai).
	'sea-lion-nemotron-120b': 'ai-singapore',
	// The gateway serves Bielik from PLGrid's LLMLab (api_base llmlab.plgrid.pl), run by Cyfronet.
	'bielik-11b': 'plgrid',
	'mistral-large': 'mistral',
	'mistral-large-4': 'mistral',
	'mistral-medium': 'mistral',
	'mistral-small': 'mistral',
	'cohere-command-a': 'huggingface'
};

/** The catalog org behind each Hugging Face provider id a pin can name. A pin to a provider missing here
 *  leaves its model with no host, which `routing.spec.ts` fails. */
const HF_PROVIDER_ORGS: Readonly<Record<string, OrgId>> = {
	scaleway: 'scaleway',
	'featherless-ai': 'featherless',
	'zai-org': 'zhipu'
};

/** How much thinking a model is suited to — matched against the detected effort. */
export type Tier = 'quick' | 'balanced' | 'deep';

export type ModelStatus = 'live' | 'in-progress' | 'stub';

export interface CatalogModel {
	/** Stable catalog id (not the gateway id). */
	id: string;
	name: string;
	/** Friendly family name shown to people who don't care about model ids. */
	family: string;
	maker: OrgId;
	/** Who runs it — filled from `MODEL_HOSTS`; don't set it on an entry. */
	provider?: OrgId;
	/** The id the gateway serves it under, when it has one. */
	gatewayId?: string;
	tier: Tier;
	/**
	 * Languages it is built for, as ISO 639-1 codes — its specialism. `*` means broadly
	 * multilingual with no single focus.
	 */
	languages: string[];
	/** Languages it handles well without being built around them. */
	alsoGood?: string[];
	status: ModelStatus;
	/**
	 * False for a model a person may pick by hand that Auto never chooses or measures against (CUR-1683).
	 * `'own-languages'` lets Auto choose it only for a draft in one of its `languages`: SEA-LION v4.8
	 * and GLM 5.2 are rated above Medium overall, so unscoped they would take every English draft too
	 * (CUR-4283).
	 * `'large-tasks'` lets Auto choose it only for a draft the classifier reads as large: Large 4 is rated
	 * far above Medium, so unscoped it would take every draft and Medium would stop being the default (CUR-4574).
	 */
	autoPick?: false | 'own-languages' | 'large-tasks';
	/**
	 * Requests a minute our account may send this model, shared by every site, when the provider sets
	 * one we know. Auto spends a scarce model only on a task that needs it (router.ts `capacityCost`);
	 * a model with no figure is treated as unconstrained.
	 */
	requestsPerMinute?: number;
	/**
	 * False for a model registered so a CI ticket-branch preview can serve on it, and never offered to a
	 * visitor: the picker lists it only in a conversation it is already serving (CUR-2763).
	 */
	offered?: false;
	/** One line on why you'd want this model, in plain words. */
	strength: string;
	/**
	 * Whether it reads a photo, as observed on a host that served it, by sending a random background
	 * colour with a random 4-digit number on it and checking that the model named both. Hosts' `/models` lists can't be relied on
	 * for this (the LiteLLM router lists no modalities), so this is the answer the registry uses.
	 * Image input still opens only where the `multimodal` gate is on.
	 */
	readsImages: boolean;
}

const models: Omit<CatalogModel, 'provider'>[] = [
	{
		id: 'apertus-70b',
		name: 'Apertus 1.5 70B',
		family: 'Apertus',
		maker: 'swiss-ai',
		gatewayId: 'swiss-ai/apertus-v1.5-70b',
		tier: 'deep',
		languages: ['*'],
		status: 'live',
		strength: 'Alpha’s main model — fully open, trained on over a thousand languages.',
		// Image input: both probes read an image on Infomaniak, via the router and the gateway.
		readsImages: true
	},
	{
		id: 'apertus-8b',
		name: 'Apertus 1.5 8B',
		family: 'Apertus',
		maker: 'swiss-ai',
		gatewayId: 'swiss-ai/apertus-v1.5-8b',
		tier: 'quick',
		languages: ['*'],
		status: 'live',
		// No site's picker serves it (config/inference.ts), so nobody is offered it and Auto never picks it.
		autoPick: false,
		offered: false,
		strength: 'The small Apertus — quick answers to simple questions, using less energy.',
		// Image input: both probes read an image on the gateway.
		readsImages: true
	},
	{
		id: 'alia-40b',
		name: 'ALIA 40B',
		family: 'ALIA',
		maker: 'bsc',
		gatewayId: 'BSC-LT/ALIA-40b-instruct',
		tier: 'balanced',
		languages: ['es', 'ca', 'gl', 'eu'],
		alsoGood: ['en', 'pt', 'fr'],
		status: 'live',
		strength: 'Built for Spanish, Catalan, Galician and Basque.',
		// Image input: refused, "alia-salamandra:40b is not a multimodal model" (gateway and router).
		readsImages: false
	},
	{
		id: 'sea-lion-qwen-32b',
		name: 'SEA-LION v4 (Qwen) 32B',
		family: 'SEA-LION',
		maker: 'ai-singapore',
		gatewayId: 'aisingapore/Qwen-SEA-LION-v4-32B-IT',
		tier: 'deep',
		languages: ['id', 'ms', 'th', 'vi', 'tl', 'my', 'km', 'lo', 'ta'],
		alsoGood: ['en', 'zh'],
		status: 'live',
		strength: 'Built for Southeast Asian languages — Indonesian, Thai, Vietnamese, Tagalog and more.',
		// Image input: refused, "is not a multimodal model" (gateway and router).
		readsImages: false
	},
	{
		// Served by the publicai gateway and the staging router (both list it and answer a test chat).
		// Auto may pick it: benchmarks.json rates it from its base model and SEA-HELM (CUR-4283).
		id: 'sea-lion-nemotron-120b',
		name: 'SEA-LION v4.8 (Nemotron) 120B',
		family: 'SEA-LION',
		maker: 'ai-singapore',
		gatewayId: 'aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B',
		tier: 'deep',
		languages: ['id', 'ms', 'th', 'vi', 'tl', 'my', 'km', 'lo', 'ta'],
		alsoGood: ['en'],
		status: 'live',
		strength: 'The newest and largest SEA-LION, for harder questions in Southeast Asian languages.',
		autoPick: 'own-languages',
		// Image input: refused, "is not a multimodal model" (gateway and router).
		readsImages: false
	},
	{
		id: 'sea-lion-gemma-27b',
		name: 'SEA-LION v4 (Gemma) 27B',
		family: 'SEA-LION',
		maker: 'ai-singapore',
		gatewayId: 'aisingapore/Gemma-SEA-LION-v4-27B-IT',
		tier: 'balanced',
		languages: ['id', 'ms', 'th', 'vi', 'tl', 'my', 'km', 'lo', 'ta'],
		alsoGood: ['en'],
		status: 'live',
		strength: 'A lighter SEA-LION for everyday Southeast Asian language questions.',
		// Image input: both probes read an image on the gateway and on Featherless via Hugging Face.
		readsImages: true
	},
	{
		id: 'bielik-11b',
		name: 'Bielik 11B v3',
		family: 'Bielik',
		maker: 'speakleash',
		gatewayId: 'speakleash/Bielik-11B-v3.0-Instruct',
		tier: 'balanced',
		languages: ['pl'],
		alsoGood: ['en'],
		status: 'live',
		strength: 'Built for Polish.',
		// Image input: refused, "is not a multimodal model" (gateway and router).
		readsImages: false
	},
	{
		id: 'glm-5.2',
		name: 'GLM 5.2',
		family: 'GLM',
		maker: 'zhipu',
		gatewayId: 'zai-org/GLM-5.2',
		tier: 'deep',
		languages: ['zh'],
		alsoGood: ['en'],
		status: 'live',
		// Auto's pick for Chinese only, at every task size: its measured Chinese (0.92) edges Large 4's
		// gateway run (0.89), within both runs' 95% ranges (CUR-392).
		autoPick: 'own-languages',
		strength: 'A large open model, strongest in Chinese and English reasoning.',
		// Image input: refused, "glm-5.2 is not a multimodal model" (Hugging Face; GLM 5.3 too).
		readsImages: false
	},
	{
		id: 'mistral-large',
		name: 'Mistral Large 3',
		family: 'Mistral',
		maker: 'mistral',
		gatewayId: 'mistral-large-2512',
		tier: 'deep',
		languages: ['*'],
		alsoGood: ['en', 'fr', 'de', 'es', 'it', 'pt'],
		status: 'live',
		// On no site's picker (web/config/picker.ts, CUR-4683), and never Auto's pick: Large 4 takes large
		// drafts and Medium the rest, Medium also while Large 4 is busy (CUR-392).
		autoPick: false,
		// Through the staging router (web/config/picker.ts), shared by www, develop and CI (CUR-4035). Taken from
		// the rate-limit header the router returns for Mistral (CUR-4574).
		requestsPerMinute: 150,
		strength: 'A strong European model for demanding questions in major European languages.',
		// Image input: both probes read an image on the router and preview's Mistral lane.
		readsImages: true
	},
	{
		// The staging router serves it as `mistralai/mistral-large-2610` and asks Mistral for
		// `mistral-large-4` (CUR-3027). Offered by hand on every site, second after Medium, the default.
		// Auto picks it for a large task only (CUR-4574). Chat turns stream, and streamed calls get
		// Large 4 itself.
		id: 'mistral-large-4',
		name: 'Mistral Large 4',
		family: 'Mistral',
		maker: 'mistral',
		gatewayId: 'mistral-large-2610',
		tier: 'deep',
		languages: ['*'],
		alsoGood: ['en', 'fr', 'de', 'es', 'it', 'pt'],
		status: 'live',
		autoPick: 'large-tasks',
		// Taken from the rate-limit header the router returns for Mistral (CUR-4574).
		requestsPerMinute: 4000,
		strength: 'Mistral’s newest and largest model.',
		// Image input: the model list reports vision, but both routers answer
		// with Large 3 in its place, text included, so image reading is not observed.
		readsImages: true
	},
	{
		// Every site's default (CUR-4002), Large 3's backup on the direct lane (CUR-2460) and the arithmetic
		// route (CUR-3313).
		id: 'mistral-medium',
		name: 'Mistral Medium 3.5',
		family: 'Mistral',
		maker: 'mistral',
		gatewayId: 'mistral-medium-2604',
		tier: 'balanced',
		languages: ['*'],
		alsoGood: ['en', 'fr', 'de', 'es', 'it', 'pt'],
		status: 'live',
		// Through the staging router (web/config/picker.ts). Taken from the rate-limit header the
		// router returns for Mistral (CUR-4574).
		requestsPerMinute: 4000,
		strength: 'The mid-sized Mistral: quick, good in many languages, and the model Alpha starts on.',
		// Image input: both probes read an image as `mistralai/mistral-medium-3-5`, preview's id for it.
		readsImages: true
	},
	{
		id: 'mistral-small',
		name: 'Mistral Small 4',
		family: 'Mistral',
		maker: 'mistral',
		gatewayId: 'mistral-small-2603',
		tier: 'quick',
		languages: ['*'],
		alsoGood: ['en', 'fr', 'de', 'es', 'it', 'pt'],
		status: 'live',
		autoPick: false,
		offered: false,
		strength: 'The quick Mistral — everyday questions in major European languages, at a fraction of the cost.',
		// Image input: both probes read an image on the router and preview's Mistral lane.
		readsImages: true
	},
	{
		id: 'cohere-command-a',
		name: 'Command A',
		family: 'Command',
		maker: 'cohere',
		tier: 'balanced',
		languages: ['*'],
		alsoGood: ['ar', 'ja', 'ko', 'hi'],
		status: 'stub',
		strength: 'Recommended by Hugging Face for multilingual everyday work.',
		// Image input: not served anywhere yet, so not tested.
		readsImages: false
	}
];

/**
 * Who runs each model, keyed by catalog id. A model the Hugging Face router pins to one provider
 * (`HF_PROVIDER_PIN`, the choice of who receives visitor text) takes that provider's org, so re-pinning
 * it moves X-ray's "where it runs" line with it: GLM 5.2 runs at Scaleway (CUR-2112).
 */
export const MODEL_HOSTS: Record<string, OrgId> = {
	...PLANNED_HOSTS,
	...Object.fromEntries(
		models.flatMap((m) => {
			const pin = m.gatewayId ? HF_PROVIDER_PIN[m.gatewayId.toLowerCase()] : undefined;
			return pin ? [[m.id, HF_PROVIDER_ORGS[pin]]] : [];
		})
	)
};

export const catalog: CatalogModel[] = models.map((m) => ({ ...m, provider: MODEL_HOSTS[m.id] }));

/** Where the provider serving a gateway id is recorded, for provenance on persisted answers. */
/**
 * The key a served id and a catalog `gatewayId` are matched on: lower case, without the publisher
 * prefix. Lanes name one checkpoint differently — Mistral's own API serves `mistral-large-2512`, the
 * LiteLLM router (CUR-1380) `mistralai/mistral-large-2512` — and both are the same catalog entry.
 */
export function servedKey(id: string): string {
	const lower = id.toLowerCase();
	return lower.slice(lower.lastIndexOf('/') + 1);
}

// Another host's name for the same weights resolves to our entry: Scaleway serves Medium 3.5 as
// `mistral-medium-3.5-128b`, and X-ray must not read "Not in Alpha's catalogue yet" for it (CUR-3313).
export function catalogByGatewayId(gatewayId: string | undefined): CatalogModel | undefined {
	if (!gatewayId) return undefined;
	const byKey = (id: string) => catalog.find((m) => m.gatewayId && servedKey(m.gatewayId) === id);
	const ownId = modelIdServedAs(gatewayId);
	return byKey(servedKey(gatewayId)) ?? (ownId ? byKey(servedKey(ownId)) : undefined);
}

/**
 * The catalog entry a served id is built on: itself, or for a reasoning variant (`…-70b-thinking`,
 * preview's backup lane) the checkpoint it varies. For what the two share, such as the maker. The
 * variant keeps its own name through `identity.ts`, so `catalogByGatewayId` stays exact (CUR-1873).
 */
export function catalogBaseOf(gatewayId: string | undefined): CatalogModel | undefined {
	return catalogByGatewayId(gatewayId) ?? catalogByGatewayId(gatewayId?.replace(/-thinking$/i, ''));
}
