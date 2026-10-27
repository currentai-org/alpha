import type { Message } from '$lib/chat/types/Message';
import type { MessageTimings } from '$lib/chat/types/MessageTimings';
import type { RagSource } from '$lib/chat/types/Rag';
import type { SearchSource } from '$lib/chat/types/Search';
import { MessageUpdateType } from '$lib/chat/types/MessageUpdate';
import { estimateTokensFromText } from '$lib/chat/utils/energyEstimate';
import { base } from '$lib/chat/paths';
import { COMMON_VOICE, MOZILLA_DATA_COLLECTIVE } from '$lib/chat/contribute';
import { DEMO_MODEL_ID, demoGatewayId } from './demo-models';
import { MODEL_HOSTS, orgs } from '$lib/chat/routing/catalog';

// Who runs Apertus in the sample answer, from the catalog so the demo moves with a host change (CUR-4587).
const APERTUS_HOST = orgs[MODEL_HOSTS['apertus-70b']];

/**
 * Sample conversations for the /alpha demo. Each one carries the same record a real turn persists —
 * the model that served it, the safety screens, what was looked up (with real, working source
 * links), per-stage timings, and any second opinion — so X-ray, Step by step, the model picker and
 * the footprint all have something true-to-life to show.
 *
 * Add a conversation by appending to `THREADS`; the sidebar and the demo pick it up automatically.
 * Models come from the catalog and links from the app's own constants, so a rename or a moved page
 * fails here instead of going stale. What a thread says about how Alpha works must match the app:
 * see this folder's README for what to re-check when the app changes.
 */

const APERTUS = DEMO_MODEL_ID;
const ALIA = demoGatewayId('alia-40b');
const BIELIK = demoGatewayId('bielik-11b');
const SEA_LION = demoGatewayId('sea-lion-nemotron-120b');
// Auto's pick for most drafts: Large 4 is kept for tasks it is sure are large (CUR-4574).
const MISTRAL = demoGatewayId('mistral-medium');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Turn {
	q: string;
	a: string;
	model?: string;
	timings?: MessageTimings;
	web?: { query: string; sources: Omit<SearchSource, 'n' | 'snippet'>[] };
	rag?: { query: string; sources: Omit<RagSource, 'n' | 'snippet'>[] };
	extra?: Partial<Message>;
}

interface DemoThread {
	id: string;
	title: string;
	/** How long ago the conversation was last active, so the sidebar groups it like a real history. */
	ago: number;
	turns: Turn[];
}

const clear = {
	flagged: false,
	label: null,
	score: 0.01,
	kind: 'toxicity' as const,
	screened: true
};

// Who's asking: people at EU public bodies and non-profits — a city hall, a regional government, a
// library, an NGO — plus questions about Current AI, AI Potluck and the partner projects Alpha runs.
const THREADS: DemoThread[] = [
	{
		id: 'alpha-demo-conv-1',
		title: 'What is Current AI?',
		ago: 8 * MIN,
		turns: [
			{
				q: 'What is Current AI, and who is behind Alpha?',
				a: '**Current AI** is a non-profit coalition building public-interest AI. It was launched at the AI Action Summit in Paris in February 2025, backed by governments, philanthropies and companies [1].\n\nAlpha is Current AI’s chat assistant. Current AI didn’t build the models itself — it **serves** open ones made by others, such as **Apertus** from the Swiss AI Initiative, and says so on every answer [2]. It also coordinates **AI Potluck**, a shared effort to assemble an open alternative to closed AI from open components [2].',
				timings: { gateMs: 220, ragMs: 680, retrievalMs: 1740, ttftMs: 2380, totalMs: 7900 },
				web: {
					query: 'Current AI public interest AI partnership',
					sources: [{ engine: 'Firecrawl', title: 'Current AI', url: 'https://www.currentai.org' }]
				},
				rag: {
					query: 'Current AI AI Potluck Alpha',
					sources: [{ engine: 'Potluck', title: 'AI Potluck — about the project', url: '/' }]
				}
			},
			{
				q: 'And what is the AI Potluck, in one paragraph?',
				a: 'AI Potluck works like a shared meal: instead of one lab building everything, many organisations each bring a piece — a model, a dataset, a safety tool, compute — and the pieces are assembled into a complete, open source AI stack. The **gap map** shows which layers are healthy, which are fragile, and where nothing open exists yet [1], so funders and builders can see where help matters most.',
				timings: { gateMs: 190, ragMs: 610, retrievalMs: 610, ttftMs: 1290, totalMs: 4800 },
				rag: {
					query: 'AI Potluck gap map layers',
					sources: [{ engine: 'Potluck', title: 'Gap map — the open source AI stack', url: '/map' }]
				}
			}
		]
	},
	{
		id: 'alpha-demo-conv-ai-act',
		title: 'AI Act duties for a city',
		ago: 2 * HOUR,
		turns: [
			{
				q: 'Our city wants to use AI to triage citizen emails. What does the EU AI Act require of us?',
				a: 'As the organisation *using* the system you’re a **deployer** under the Act [1]. For email triage, the key questions are:\n\n- **Is it high-risk?** Triage that decides access to essential public services or benefits can fall under Annex III; routing emails to the right department usually doesn’t [1].\n- **Transparency** — people should know when they’re dealing with an AI system [2].\n- **Human oversight and logs** — if it is high-risk, staff must be able to override it, and you keep its logs; these obligations apply from **August 2026** [2].\n- **AI literacy** — staff using it need suitable training, required since February 2025 [2].\n\nFor your specific setup, check with your data-protection officer or legal team — I can summarise, not advise.',
				timings: { gateMs: 260, retrievalMs: 2210, ttftMs: 3310, totalMs: 12600 },
				web: {
					query: 'EU AI Act deployer obligations public authority',
					sources: [
						{
							engine: 'Firecrawl',
							title: 'Regulation (EU) 2024/1689 — EUR-Lex',
							url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj'
						},
						{
							engine: 'Wikipedia',
							title: 'Artificial Intelligence Act — Wikipedia',
							url: 'https://en.wikipedia.org/wiki/Artificial_Intelligence_Act'
						}
					]
				},
				extra: {
					outputModeration: { ...clear },
					opinions: [
						{
							model: ALIA,
							modelShort: 'ALIA 40B',
							openness: 'open weights',
							sovereign: true,
							answer:
								'A public body using AI is a deployer. Routing emails is likely not high-risk; deciding eligibility for services would be. Tell people they are interacting with AI and train staff.'
						},
						{
							model: BIELIK,
							modelShort: 'Bielik 11B',
							openness: 'open weights',
							sovereign: true,
							answer:
								'Deployer obligations: transparency, human oversight and logging for high-risk uses from August 2026, and AI literacy for staff.'
						}
					],
					verdict: {
						agreement: 'high',
						headline: 'All three models agree on the deployer role and the main duties.',
						consensus: [
							'The city is a deployer',
							'Simple routing is unlikely to be high-risk',
							'Transparency and staff training apply'
						],
						contradictions: [],
						weakSpots: [
							'Where triage becomes “access to public services” depends on the exact setup'
						]
					}
				}
			}
		]
	},
	{
		id: 'alpha-demo-conv-vietnamese',
		title: 'Tóm tắt ý kiến cư dân',
		ago: 4 * HOUR,
		turns: [
			// Written in English, so Mistral Medium 3.5 answers; the Vietnamese follow-up goes to SEA-LION v4.8.
			// The history shows the model that wrote each answer, which is what per-message switching leaves behind.
			{
				q: 'We have about 400 free-text answers from a public consultation on a new neighbourhood park. How should I summarise them?',
				a: 'Read before you count. A routine that works for a few hundred answers:\n\n1. **Skim about 40 answers** and note what keeps coming up.\n2. **Agree 5–8 themes**, plus one for “other”.\n3. **Tag every answer** with its main theme; a spreadsheet is enough.\n4. **Count and quote** — how many answers raise each theme, with one short, representative quote.\n5. **Say where people disagree** instead of averaging opposite views.\n\nIf you paste the answers in, I can propose the themes and a first summary. Leave out names and other personal details first.',
				timings: { gateMs: 200, ttftMs: 1450, totalMs: 6600 }
			},
			{
				q: 'Bạn có thể tóm tắt trong năm ý những gì cư dân yêu cầu trong cuộc tham vấn về công viên mới của khu phố không?',
				a: 'Đây là năm chủ đề được nhắc đến nhiều nhất trong các câu trả lời:\n\n1. **Thêm bóng mát** — trồng cây và làm giàn che ở khu vui chơi.\n2. **Vòi nước uống** gần các sân thể thao.\n3. **Giờ mở cửa** — công viên đóng cửa muộn hơn vào mùa hè.\n4. **Khu riêng cho chó**, tách biệt với khu vui chơi của trẻ em.\n5. **Lối đi dễ tiếp cận** — đường không có bậc thang cho xe lăn và xe đẩy em bé.\n\nBạn có muốn tôi soạn một thông báo để đăng trên trang web của chính quyền địa phương không?',
				model: SEA_LION,
				timings: { gateMs: 230, ttftMs: 1720, totalMs: 7100 }
			}
		]
	},
	{
		id: 'alpha-demo-conv-german',
		title: 'Bürgerbrief in Leichter Sprache',
		ago: 7 * HOUR,
		turns: [
			{
				q: 'Kannst du diesen Satz in Leichte Sprache übersetzen: „Die Beantragung des Wohngeldes erfolgt ausschließlich über das Online-Portal der Stadtverwaltung.“',
				a: 'Sie wollen **Wohngeld**?\nDann müssen Sie einen Antrag stellen.\n\nDen Antrag stellen Sie **im Internet**.\nAuf der Internet-Seite von der Stadt.\n\nEs gibt keinen Antrag auf Papier.\n\nTipp: Leichte Sprache hat feste Regeln — kurze Sätze, ein Gedanke pro Satz, keine Fremdwörter [1]. Lassen Sie den Text am besten von Menschen aus der Zielgruppe prüfen.',
				timings: { gateMs: 210, retrievalMs: 1380, ttftMs: 2150, totalMs: 6400 },
				web: {
					query: 'Leichte Sprache Regeln',
					sources: [
						{
							engine: 'Wikipedia',
							title: 'Leichte Sprache — Wikipedia',
							url: 'https://de.wikipedia.org/wiki/Leichte_Sprache'
						}
					]
				}
			}
		]
	},
	{
		id: 'alpha-demo-conv-routing',
		title: 'How Alpha picks a model',
		ago: 1 * DAY + 1 * HOUR,
		turns: [
			{
				q: 'How does Alpha decide which model answers each message?',
				a: 'On **Auto**, Alpha chooses the model for each message, and it works the choice out on your device: nothing you type is sent anywhere to make it [1].\n\nWhile you type, it notices three things: the **language** you write in (and varieties such as Valencian or Swiss German), **how big the task is**, and **what the answer will need**, like a web search or step-by-step thinking. It then scores the models Alpha runs on how well they handle that language and how capable they are, and the best fit answers.\n\n- **It stays put unless another model is clearly better.** When one is, the model button in the message box reads *Auto · SEA-LION*, and its menu says which model the next message goes to.\n- **You can pick a model yourself** from the same button; Alpha remembers your pick on this device.\n- **Every answer names the model that wrote it**, and X-ray shows the rest.\n- **The scores are provisional**: measured on the Belebele reading test where results exist, and estimated where they don’t yet.\n\nWhere no model handles a language well, such as Quechua, a pill with its name appears beside *Private*: Alpha is still learning it, and the pill shows how you can help. Try it in a new chat: type a few words in Vietnamese, Chinese or Indonesian and watch the button change.',
				timings: { gateMs: 200, ragMs: 690, retrievalMs: 690, ttftMs: 1540, totalMs: 8900 },
				rag: {
					query: 'how Auto model routing works',
					sources: [
						{
							engine: 'Potluck',
							title: 'Settings — Model routing',
							url: `${base}/settings/routing`
						}
					]
				}
			}
		]
	},
	{
		id: 'alpha-demo-conv-spanish',
		title: 'Convocatoria de subvenciones',
		ago: 1 * DAY + 3 * HOUR,
		turns: [
			{
				q: '¿Cómo puedo explicar el impacto de nuestra ONG en una solicitud de subvención europea?',
				a: 'Los evaluadores buscan cambios medibles, no solo actividades. Una estructura que funciona:\n\n1. **El problema**, con un dato local: “el 38 % de las personas mayores del barrio vive sola”.\n2. **Lo que hacéis** — actividades concretas, con cifras del último año.\n3. **El cambio** — qué mejora para las personas y cómo lo medís (encuestas, indicadores).\n4. **La dimensión europea** — con qué socios de otros países colaboráis y qué se puede replicar.\n\nSi me pasas vuestra memoria anual, puedo proponer indicadores concretos.',
				timings: { gateMs: 240, ttftMs: 1860, totalMs: 8300 }
			}
		]
	},
	{
		id: 'alpha-demo-conv-apertus',
		title: 'Why Apertus?',
		ago: 1 * DAY + 6 * HOUR,
		turns: [
			{
				q: 'Why does Alpha use Apertus, and what makes it “open”?',
				a: `**Apertus** was built by the Swiss AI Initiative — EPFL, ETH Zurich and CSCS — and released in 2025 [1]. It is open in more than the usual sense: the weights, the training data recipe and the training code are all published, so anyone can inspect how it was made [1][2].\n\nIt was trained on openly available data in over a thousand languages, respecting website opt-outs, which matters for public bodies that have to justify the tools they use. In Alpha it runs on **${APERTUS_HOST.name}**’s servers${APERTUS_HOST.region ? ` in ${APERTUS_HOST.region}` : ''}.`,
				timings: { gateMs: 200, retrievalMs: 1520, ttftMs: 2260, totalMs: 7700 },
				web: {
					query: 'Apertus Swiss AI open model',
					sources: [
						{
							engine: 'Firecrawl',
							title: 'Apertus — Swiss AI Initiative',
							url: 'https://www.swiss-ai.org/apertus'
						},
						{
							engine: 'Hugging Face',
							title: 'swiss-ai on Hugging Face',
							url: 'https://huggingface.co/swiss-ai'
						}
					]
				}
			}
		]
	},
	{
		id: 'alpha-demo-conv-polish',
		title: 'Warsztaty cyfrowe w bibliotece',
		ago: 2 * DAY,
		turns: [
			{
				q: 'Czy możesz zaplanować cykl czterech warsztatów cyfrowych dla seniorów w naszej bibliotece?',
				model: MISTRAL,
				a: 'Propozycja cyklu „Cyfrowo bez stresu”:\n\n1. **Smartfon na co dzień** — zdjęcia, wiadomości, powiększanie tekstu.\n2. **Bezpiecznie w sieci** — jak rozpoznać oszustwo SMS-owe i fałszywe strony banku.\n3. **Sprawy urzędowe online** — Profil Zaufany i umawianie wizyt.\n4. **AI bez tajemnic** — czym jest czat z AI, do czego się przydaje i kiedy mu nie ufać.\n\nNajlepiej sprawdzają się małe grupy (do 8 osób) i jeden wolontariusz na dwie osoby.',
				timings: { gateMs: 220, ttftMs: 1410, totalMs: 6200 }
			}
		]
	},
	{
		id: 'alpha-demo-conv-partners',
		title: 'Partner models in Alpha',
		ago: 3 * DAY,
		turns: [
			{
				q: 'Which partner projects’ models can Alpha use besides Apertus?',
				a: 'Alpha picks between several open models, each built by a public or community project for particular languages [1]:\n\n- **ALIA** — Barcelona Supercomputing Center, for Spanish, Catalan, Galician and Basque [2].\n- **SEA-LION** — AI Singapore, for Southeast Asian languages.\n- **Bielik** — SpeakLeash, an open-science community in Poland, for Polish [3].\n\nOn **Auto**, Alpha picks between them for each message, from the language you write in and how much the answer needs. The line under every answer names the model that wrote it, and X-ray shows the rest.',
				timings: { gateMs: 210, ragMs: 740, retrievalMs: 1630, ttftMs: 2310, totalMs: 7400 },
				rag: {
					query: 'open language models partners',
					sources: [{ engine: 'Potluck', title: 'Gap map — Models layer', url: '/map' }]
				},
				web: {
					query: 'ALIA BSC Bielik SpeakLeash models',
					sources: [
						{
							engine: 'Hugging Face',
							title: 'BSC-LT on Hugging Face',
							url: 'https://huggingface.co/BSC-LT'
						},
						{
							engine: 'Hugging Face',
							title: 'speakleash on Hugging Face',
							url: 'https://huggingface.co/speakleash'
						}
					]
				}
			}
		]
	},
	{
		id: 'alpha-demo-conv-italian',
		title: 'Accessibilità del sito comunale',
		ago: 4 * DAY,
		turns: [
			{
				q: 'Quali regole di accessibilità deve rispettare il sito web del nostro comune?',
				a: 'I siti delle pubbliche amministrazioni europee devono rispettare la **Direttiva UE 2016/2102** sull’accessibilità web [1], che rimanda allo standard **WCAG 2.1 livello AA** [2]. In Italia le linee guida sono pubblicate da AgID.\n\nIn pratica: testi alternativi per le immagini, contrasto sufficiente, navigazione da tastiera, moduli con etichette chiare. Serve anche una **dichiarazione di accessibilità** pubblicata sul sito, con un modo per segnalare problemi.',
				timings: { gateMs: 230, retrievalMs: 1690, ttftMs: 2480, totalMs: 8600 },
				web: {
					query: 'direttiva accessibilità siti pubblica amministrazione WCAG',
					sources: [
						{
							engine: 'Wikipedia',
							title: 'Web Accessibility Directive — Wikipedia',
							url: 'https://en.wikipedia.org/wiki/Web_Accessibility_Directive'
						},
						{
							engine: 'Firecrawl',
							title: 'WCAG — W3C Web Accessibility Initiative',
							url: 'https://www.w3.org/WAI/standards-guidelines/wcag/'
						}
					]
				}
			}
		]
	},
	{
		id: 'alpha-demo-conv-contribute',
		title: 'Helping Alpha learn a language',
		ago: 5 * DAY,
		turns: [
			{
				q: 'Our association records oral histories in a regional language that AI handles badly. Can we help open models get better at it?',
				a: 'Yes, in part. Models are weaker in some languages for several reasons: how they were trained, how they were tested, and how much text in the language they had to learn from. Data is one of those reasons, and it is one you can help with.\n\n- **Share data in your language.** The **Mozilla Data Collective** lets a community publish datasets on its own terms: who can use them, and for what [1]. Transcribed oral histories could fit, as long as the people speaking have agreed.\n- **Help build a dataset on Common Voice.** On **Common Voice**, anyone can read sentences aloud or write new ones, in more than a hundred languages [2]. If your language isn’t there yet, you can ask for it to be added.\n- **Check how models do today.** In Settings → Model routing you can try messages in your language, see how each model ranks, and correct the scores you know are wrong.\n- **Tell us what is missing.** A language Alpha stumbles in, or a tool you expected, goes to the people building it.\n\nWhen you write in a language none of Alpha’s models handles well, a small pill beside *Private* says Alpha is still learning it and links to these same options.',
				timings: { gateMs: 220, retrievalMs: 1580, ttftMs: 2390, totalMs: 9800 },
				web: {
					query: 'Mozilla Data Collective share a dataset, Common Voice languages',
					sources: [
						{
							engine: 'Firecrawl',
							title: 'Mozilla Data Collective',
							url: MOZILLA_DATA_COLLECTIVE.home
						},
						{ engine: 'Firecrawl', title: 'Common Voice — languages', url: COMMON_VOICE.languages }
					]
				}
			}
		]
	},
	{
		id: 'alpha-demo-conv-2',
		title: 'Gaps in the open source AI stack',
		ago: 6 * DAY,
		turns: [
			{
				q: 'Where does the gap map say open source AI is weakest for public-sector use?',
				a: 'The gap map shows open projects are strongest in **models** and **evaluation** [1], and thinnest in what public bodies need to run AI day to day: **monitoring** a system once it’s live, **incident reporting**, and ready-made **compliance tooling** [2]. Those are the “gap” cells on the map — good places for funders and partners to bring a dish to the potluck.',
				timings: { gateMs: 250, ragMs: 810, retrievalMs: 810, ttftMs: 1740, totalMs: 6900 },
				rag: {
					query: 'gap map public sector weakest layers',
					sources: [
						{ engine: 'Potluck', title: 'Gap map — Evaluation layer', url: '/map' },
						{ engine: 'Potluck', title: 'Gap map — Governance & compliance layer', url: '/map' }
					]
				}
			}
		]
	},
	{
		id: 'alpha-demo-conv-french',
		title: 'Rapport annuel de l’association',
		ago: 9 * DAY,
		turns: [
			{
				q: 'Peux-tu proposer un plan pour le rapport annuel de notre association d’aide alimentaire ?',
				a: 'Voici un plan simple, lisible par les donateurs comme par les bénévoles :\n\n1. **Le mot de la présidente** — l’année en trois phrases.\n2. **Nos chiffres clés** — repas distribués, familles aidées, heures de bénévolat.\n3. **Une histoire** — le parcours d’une famille (avec son accord).\n4. **Nos partenaires** — collectivités, commerces, autres associations.\n5. **Les comptes** — ressources et dépenses, en un graphique.\n6. **L’année prochaine** — deux ou trois objectifs concrets.',
				timings: { gateMs: 210, ttftMs: 1330, totalMs: 6800 }
			}
		]
	},
	{
		id: 'alpha-demo-conv-name',
		title: 'Who am I talking to?',
		ago: 12 * DAY,
		turns: [
			{
				q: 'Hi! What should I call you?',
				a: 'I’m an AI system, so I don’t have a name, feelings or a personal history — “Alpha” is the name of the app, not of me. You don’t need to call me anything; just ask.\n\nRight now, the model writing this is **Mistral Medium 3.5**, made by Mistral AI. X-ray below shows the details.',
				timings: { gateMs: 170, ttftMs: 640, totalMs: 2100 }
			}
		]
	}
];

export const DEMO_ACTIVE_CONVERSATION_ID = THREADS[0].id;

/** Where a sample turn went, as X-ray records it (CUR-4580): the app server's region, and for a Mistral
 *  turn the router lane and the model host. The other sample models record
 *  no lane, so their X-ray says the model host was not recorded. */
function demoRoute(model: string): Partial<NonNullable<Message['routerMetadata']>> {
	return model === MISTRAL
		? { appRegion: 'fra1', lane: 'router.stg.aipotluck.org', backend: 'https://api.mistral.ai/v1' }
		: { appRegion: 'fra1' };
}

function toMessages(thread: DemoThread, now: number): Message[] {
	const out: Message[] = [];
	const count = thread.turns.length;
	thread.turns.forEach((turn, i) => {
		const askedAt = new Date(now - thread.ago - (count - 1 - i) * 3 * MIN);
		const answeredAt = new Date(askedAt.getTime() + (turn.timings?.totalMs ?? 4000));
		const id = `${thread.id}-${i}`;
		out.push({ id: `${id}-user`, from: 'user', content: turn.q, createdAt: askedAt });
		out.push({
			id: `${id}-assistant`,
			from: 'assistant',
			content: turn.a,
			createdAt: answeredAt,
			updates: [{ type: MessageUpdateType.FinalAnswer, text: turn.a, interrupted: false }],
			routerMetadata: {
				route: 'demo',
				model: turn.model ?? MISTRAL,
				...demoRoute(turn.model ?? MISTRAL)
			},
			moderation: { ...clear },
			timings: turn.timings,
			webSearch: turn.web && {
				query: turn.web.query,
				asOf: answeredAt.toISOString(),
				sources: turn.web.sources.map((s, n) => ({ ...s, n: n + 1, snippet: '' }))
			},
			rag: turn.rag && {
				query: turn.rag.query,
				asOf: answeredAt.toISOString(),
				sources: turn.rag.sources.map((s, n) => ({ ...s, n: n + 1, snippet: '' }))
			},
			...turn.extra
		});
	});
	return out;
}

const lastModel = (t: DemoThread) => t.turns.at(-1)?.model ?? MISTRAL;

/** The model that wrote a thread's last answer: the conversation's model, as the app tracks it. */
export function demoThreadModel(id: string | undefined): string {
	const thread = THREADS.find((t) => t.id === id);
	return thread ? lastModel(thread) : APERTUS;
}

/** Sidebar rows for the demo, newest first (same shape as the real conversation list). */
export function demoConversationList(now = Date.now()) {
	return THREADS.map((t) => ({
		id: t.id,
		title: t.title,
		model: lastModel(t),
		updatedAt: new Date(now - t.ago)
	}));
}

/** The opening conversation. */
export function createDemoMessages(): Message[] {
	return toMessages(THREADS[0], Date.now());
}

/** Every sample conversation the demo can open, by sidebar id. */
export function createDemoThreads(): Record<string, () => Message[]> {
	return Object.fromEntries(THREADS.map((t) => [t.id, () => toMessages(t, Date.now())]));
}

/**
 * The sample session's footprint — the energy the answers above would have cost and a plausible time
 * spent — so the demo's energy/time readout shows real figures instead of zero.
 */
export function demoFootprint() {
	const outputTokens = THREADS.flatMap((t) => t.turns).reduce(
		(n, turn) => n + estimateTokensFromText(turn.a),
		0
	);
	return { outputTokens, activeMs: 23 * MIN };
}

/** A sample answer (with its question) for landing-page scenes, e.g. the X-ray bento. */
export function demoAnswer(threadId = 'alpha-demo-conv-ai-act'): {
	question: string;
	answer: Message;
} {
	const thread = THREADS.find((t) => t.id === threadId) ?? THREADS[0];
	const messages = toMessages(thread, Date.now());
	return { question: messages[0].content, answer: messages[1] };
}
