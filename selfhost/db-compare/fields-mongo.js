// LibreChat's MongoDB: every collection.field path holding either canary, with how many documents hold
// each. Runs in mongosh (run.sh pipes it in) with USER and ANSWER set by --eval. Prints one
// tab-separated line per hit: collection.path, documents with the user canary, with the answer canary.
const hits = {};
function walk(value, path, found) {
	if (typeof value === "string") {
		if (value.includes(USER)) (found[path] ??= [false, false])[0] = true;
		if (value.includes(ANSWER)) (found[path] ??= [false, false])[1] = true;
	} else if (Array.isArray(value)) {
		value.forEach((v) => walk(v, path, found));
	} else if (value && typeof value === "object" && !(value instanceof ObjectId) && !(value instanceof Date)) {
		for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, found);
	}
}
for (const name of db.getCollectionNames()) {
	db.getCollection(name)
		.find()
		.forEach((doc) => {
			const found = {};
			walk(doc, "", found);
			for (const [path, [u, a]] of Object.entries(found)) {
				const h = (hits[`${name}.${path}`] ??= [0, 0]);
				if (u) h[0]++;
				if (a) h[1]++;
			}
		});
}
for (const [field, [u, a]] of Object.entries(hits)) print(`${field}\t${u}\t${a}`);
