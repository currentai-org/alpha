// Stands in for the upstreams the app reads for the local sign-in leg (CUR-2451), which edits no
// content:
//
// - the model registry's catalog fetch at boot, `GET <OPENAI_BASE_URL>/models`, answered with
//   MODEL_ALLOWLIST's ids;
// - Payload CMS reads (`PUBLIC_CMS_PAYLOAD_URL/api/...`), answered empty: an empty global, a
//   collection with no documents;
// - `POST <OPENAI_BASE_URL>/chat/completions`, answered with one fixed sentence, streamed or not as
//   asked, so a guest can have a finished conversation for an OAuth sign-in to carry (CUR-1677).
//
// Anything else answers 404 and fails loud.
import { createServer } from 'node:http';

const PORT = Number(process.env.UPSTREAM_STUB_PORT || 18081);
const IDS = (process.env.MODEL_ALLOWLIST ?? '')
	.split(',')
	.map((id) => id.trim())
	.filter(Boolean);

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
	const path = new URL(req.url ?? '/', 'http://localhost').pathname;
	if (req.method !== 'GET') return null;
	if (path === '/v1/models')
		return { object: 'list', data: IDS.map((id) => ({ id, object: 'model' })) };
	if (path.startsWith('/api/globals/')) return {};
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
	const body = answer(req);
	res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
	res.end(
		JSON.stringify(body ?? { error: `upstream-stub does not serve ${req.method} ${req.url}` })
	);
}).listen(PORT, '127.0.0.1', () =>
	console.log(`upstream-stub: listening on ${PORT}, ${IDS.length} models`)
);
