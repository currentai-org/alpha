// On-demand audit for the async bug class `tsc` cannot see. NOT part of any gate.
//
//   pnpm audit:async
//
// WHY IT IS MANUAL AND NOT A GATE. These rules need type information, which means eslint builds a
// full TypeScript program: minutes and over 1 GB across src/lib/chat/server. The main
// eslint config already pays a version of this cost for .svelte files (138s, 1.72 GB against 52s,
// 629 MB without it) and `pnpm lint` runs on every push via the pre-push hook, on machines with
// little free memory. ci.yml's minute budget cannot absorb it either (see the DUPLICATE_PR note at the top
// of ci.yml). So this is a tool you point at the code when you want the
// number, not a tax on every commit.
//
// WHY IT STAYS AVAILABLE. It catches floating promises `tsc` cannot see, because none of them is a
// type error: a Proxy `set` trap that cannot await and still return a boolean, or a try/catch that
// can never catch the rejection it was written for (textGeneration/generate.ts), which leaves a
// failing generator silent. `tsc` at `strict: true` reports 0 errors on code like that.
//
// Scope is src/lib/chat/server/** on purpose: streaming, aborts and DB calls are where an unawaited
// promise actually drops an error rather than merely looking untidy. Widen it if that stops being
// true, and re-measure the cost when you do.
import ts from 'typescript-eslint';
import { noChatPathLiteral } from './eslint-rules/no-chat-path-literal.js';

export default [
	{
		files: ['src/lib/chat/server/**/*.ts'],
		plugins: {
			'@typescript-eslint': ts.plugin,
			// Registered, not enabled: server code carries `eslint-disable` comments for this rule
			// (eslint.config.js), and a disable naming an unknown rule is an error.
			'chat-paths': { rules: { 'no-chat-path-literal': noChatPathLiteral } }
		},
		languageOptions: {
			parser: ts.parser,
			parserOptions: { projectService: true }
		},
		rules: {
			// A promise nobody awaits and nobody catches. The rejection goes nowhere.
			'@typescript-eslint/no-floating-promises': 'error',
			// An async function passed where a void-returning one is expected — e.g. an async callback
			// to something that will not await it, which is the same drop wearing a different hat.
			'@typescript-eslint/no-misused-promises': 'error',
			// `await` on a non-thenable: harmless at runtime, but it means someone believed a value was
			// async when it is not, and that belief is usually load-bearing somewhere else.
			'@typescript-eslint/await-thenable': 'error'
		}
	}
];
