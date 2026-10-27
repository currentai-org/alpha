// The deployed previews' databases are Neon and refuse a plain connection; the local sign-in leg's
// Postgres runs in CI with no TLS at all (CUR-2451). Choose by host so one helper serves both.
export function sslFor(databaseUrl: string): 'require' | false {
	const host = new URL(databaseUrl).hostname;
	return host === 'localhost' || host === '127.0.0.1' ? false : 'require';
}
