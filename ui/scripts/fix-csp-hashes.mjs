import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_TAG_PATTERN = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const META_TAG_PATTERN = /<meta\b[^>]*>/gi;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.resolve(__dirname, '..', 'build');

async function main() {
	for (const htmlPath of await collectHtmlFiles(BUILD_DIR)) {
		const original = await readFile(htmlPath, 'utf8');
		const updated = rewriteHtmlCsp(original);

		if (updated !== original) {
			await writeFile(htmlPath, updated);
		}
	}
}

async function collectHtmlFiles(rootDir) {
	const entries = await readdir(rootDir, { withFileTypes: true });
	const paths = await Promise.all(
		entries.map(async (entry) => {
			const entryPath = path.join(rootDir, entry.name);
			if (entry.isDirectory()) {
				return collectHtmlFiles(entryPath);
			}

			return entry.isFile() && entry.name.endsWith('.html') ? [entryPath] : [];
		})
	);

	return paths.flat();
}

function rewriteHtmlCsp(html) {
	const scriptHashes = getInlineScriptHashes(html);
	if (!scriptHashes.length) {
		return html;
	}

	return html.replace(META_TAG_PATTERN, (tag) => {
		const httpEquiv = getAttribute(tag, 'http-equiv')?.toLowerCase();
		if (httpEquiv !== 'content-security-policy') {
			return tag;
		}

		const content = getAttribute(tag, 'content');
		if (!content) {
			return tag;
		}

		const directives = parseDirectives(content);
		const existingScriptSrc = directives.get('script-src') ?? ["'self'"];
		const nextScriptSrc = mergeDirectiveValues(existingScriptSrc, scriptHashes);

		directives.set('script-src', nextScriptSrc);
		if (directives.has('script-src-elem')) {
			directives.set('script-src-elem', mergeDirectiveValues(directives.get('script-src-elem'), scriptHashes));
		}

		const nextContent = serializeDirectives(directives);
		return setAttribute(tag, 'content', nextContent);
	});
}

function getInlineScriptHashes(html) {
	const hashes = [];

	for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
		const content = match[1];
		if (!content || !content.trim()) {
			continue;
		}

		hashes.push(`'sha256-${createHash('sha256').update(content).digest('base64')}'`);
	}

	return [...new Set(hashes)];
}

function parseDirectives(content) {
	const directives = new Map();

	for (const segment of content.split(';')) {
		const trimmed = segment.trim();
		if (!trimmed) {
			continue;
		}

		const [name, ...values] = trimmed.split(/\s+/);
		directives.set(name, values);
	}

	return directives;
}

function mergeDirectiveValues(values = [], hashes) {
	const preserved = values.filter((value) => !value.startsWith("'sha256-") && !value.startsWith("'nonce-"));
	return [...preserved, ...hashes];
}

function serializeDirectives(directives) {
	return [...directives.entries()]
		.map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
		.join('; ');
}

function getAttribute(tag, name) {
	const match = tag.match(new RegExp(`\\s${name}=(["'])(.*?)\\1`, 'i'));
	return match?.[2];
}

function setAttribute(tag, name, value) {
	const pattern = new RegExp(`(\\s${name}=)(["'])(.*?)\\2`, 'i');
	return tag.replace(pattern, `$1"${
		value.replaceAll('"', '&quot;')
	}"`);
}

main().catch((error) => {
	console.error('[fix-csp-hashes]', error);
	process.exitCode = 1;
});
