import { describe, expect, it } from 'vitest';
import { unwrapMarkdownFences } from './unwrapMarkdownFences';

describe('unwrapMarkdownFences', () => {
	it('unwraps a ```markdown fence so the answer renders as formatted text, not a code box', () => {
		const md = '```markdown\n# Title\n\n- **Bold** point\n```';
		expect(unwrapMarkdownFences(md)).toBe('# Title\n\n- **Bold** point');
	});

	it('unwraps an ```md fence in the middle of an answer, keeping the text around it', () => {
		const md = 'Here you go:\n\n```md\n## Heading\ntext\n```\n\nAnything else?';
		expect(unwrapMarkdownFences(md)).toBe('Here you go:\n\n## Heading\ntext\n\nAnything else?');
	});

	it('unwraps an unclosed ```markdown fence while the answer is still streaming', () => {
		expect(unwrapMarkdownFences('```markdown\n# Title\n- one')).toBe('# Title\n- one');
	});

	it('unwraps a reply that is only one unlabelled fence starting with a heading', () => {
		expect(unwrapMarkdownFences('```\n# Electric cars\n\n## Key takeaway\ntext\n```')).toBe(
			'# Electric cars\n\n## Key takeaway\ntext'
		);
	});

	it('leaves real code blocks alone (a language, or an unlabelled fence that is not a whole markdown reply)', () => {
		const py = 'Try:\n\n```python\nprint("# not a heading")\n```';
		expect(unwrapMarkdownFences(py)).toBe(py);
		const plain = 'Output:\n\n```\n# comment\nls -la\n```\nDone.';
		expect(unwrapMarkdownFences(plain)).toBe(plain);
		const bash = '```bash\n# install\nnpm i\n```';
		expect(unwrapMarkdownFences(bash)).toBe(bash);
	});

	it('returns content without fences unchanged', () => {
		expect(unwrapMarkdownFences('# Just markdown\n\n**bold**')).toBe('# Just markdown\n\n**bold**');
	});
});
