// Stands in for the upstreams the app reads for the local sign-in leg, which edits no
// content:
//
// - the model registry's catalog fetch at boot, `GET <OPENAI_BASE_URL>/models`, answered with
//   MODEL_ALLOWLIST's ids;
// - Payload CMS reads (`PUBLIC_CMS_PAYLOAD_URL/api/...`), answered empty: an empty global, a
//   collection with no documents. The one exception is the published page at CMS_CHECK_PATH, whose
//   title `POST /__stub/cms-page {"title": ...}` changes, standing in for an editor's publish
//   (deploy/cms-publish-smoke.sh);
// - `POST <OPENAI_BASE_URL>/chat/completions`, answered with one fixed sentence, streamed or not as
//   asked, so a guest can have a finished conversation for an OAuth sign-in to carry.
//
// Anything else answers 404 and fails loud.
import { createServer } from 'node:http';
import { servedModels } from '../../config/picker.ts';

const PORT = Number(process.env.UPSTREAM_STUB_PORT || 18081);
const IDS = [...servedModels('production')].map((id) => id.trim()).filter(Boolean);

if (IDS.length === 0) {
	console.error(
		'upstream-stub: MODEL_ALLOWLIST is empty, so the registry would have nothing to list'
	);
	process.exit(1);
}

const EMPTY_COLLECTION = {
	docs: [],
	totalDocs: 0,
	limit: 10,
	page: 1,
	totalPages: 0,
	hasNextPage: false
};

// One published CMS page, so a check can render it, change it as an editor would, and see whether the
// app shows the change. Every other page read still finds nothing.
const CMS_CHECK_PATH = '/cms-publish-check';
let cmsCheckTitle = 'CMS publish check: first title';
function cmsCheckPage() {
	return {
		id: 1,
		title: cmsCheckTitle,
		slug: CMS_CHECK_PATH.slice(1),
		template: 'editorial',
		content: null,
		breadcrumbs: [{ url: CMS_CHECK_PATH, label: cmsCheckTitle }],
		_status: 'published'
	};
}

const STUB_ANSWER =
	'This is the local sign-in leg answering from its stub model, with no real model behind it.';

function completion(model, stream) {
	const base = { id: 'chatcmpl-stub', created: Math.floor(Date.now() / 1000), model };
	if (!stream)
		return {
			...base,
			object: 'chat.completion',
			choices: [
				{
					index: 0,
					message: { role: 'assistant', content: STUB_ANSWER },
					finish_reason: 'stop'
				}
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
		};
	const chunk = (delta, finish_reason = null) => ({
		...base,
		object: 'chat.completion.chunk',
		choices: [{ index: 0, delta, finish_reason }]
	});
	return [
		chunk({ role: 'assistant', content: '' }),
		chunk({ content: STUB_ANSWER }),
		chunk({}, 'stop')
	];
}

function answer(req) {
	const url = new URL(req.url ?? '/', 'http://localhost');
	const path = url.pathname;
	if (req.method !== 'GET') return null;
	if (path === '/v1/models')
		return { object: 'list', data: IDS.map((id) => ({ id, object: 'model' })) };
	if (path.startsWith('/api/globals/')) return {};
	if (
		path === '/api/pages' &&
		url.searchParams.get('where[breadcrumbs.url][equals]') === CMS_CHECK_PATH
	)
		return { ...EMPTY_COLLECTION, docs: [cmsCheckPage()], totalDocs: 1, totalPages: 1 };
	if (path.startsWith('/api/')) return EMPTY_COLLECTION;
	return null;
}

async function readJson(req) {
	let raw = '';
	for await (const part of req) raw += part;
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

createServer(async (req, res) => {
	const path = new URL(req.url ?? '/', 'http://localhost').pathname;
	if (req.method === 'POST' && path === '/v1/chat/completions') {
		const request = await readJson(req);
		const model = request.model ?? IDS[0];
		if (!request.stream) {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(completion(model, false)));
			return;
		}
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
		for (const chunk of completion(model, true)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
		res.end('data: [DONE]\n\n');
		return;
	}
	if (req.method === 'POST' && path === '/__stub/cms-page') {
		const { title } = await readJson(req);
		if (typeof title === 'string' && title) cmsCheckTitle = title;
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(cmsCheckPage()));
		return;
	}
	const body = answer(req);
	res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
	res.end(
		JSON.stringify(body ?? { error: `upstream-stub does not serve ${req.method} ${req.url}` })
	);
}).listen(PORT, '127.0.0.1', () =>
	console.log(`upstream-stub: listening on ${PORT}, ${IDS.length} models`)
);
