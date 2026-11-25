import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Handle } from '@sveltejs/kit';

const CLIENT_OUTPUT_DIR = path.resolve(process.cwd(), '.svelte-kit/output/client');
const sriCache = new Map<string, Promise<string | null>>();
const sriTagPattern = /<(script|link)\b[^>]*(?:\s(?:src|href)=["'][^"']+["'])[^>]*>/gi;

export const handle: Handle = async ({ event, resolve }) => {
	return resolve(event, {
		transformPageChunk: async ({ html }) => addSriToHtml(html, event.url)
	});
};

async function addSriToHtml(html: string, baseUrl: URL) {
	let output = '';
	let lastIndex = 0;

	for (const match of html.matchAll(sriTagPattern)) {
		const tag = match[0];
		const tagName = match[1].toLowerCase();
		const index = match.index ?? 0;
		const assetUrl = getAttribute(tag, tagName === 'script' ? 'src' : 'href');

		output += html.slice(lastIndex, index);

		if (!assetUrl || !shouldAddSri(tag, tagName)) {
			output += tag;
			lastIndex = index + tag.length;
			continue;
		}

		const integrity = await getIntegrity(assetUrl, baseUrl);
		output += integrity ? addIntegrityAttributes(tag, integrity) : tag;
		lastIndex = index + tag.length;
	}

	return output + html.slice(lastIndex);
}

function shouldAddSri(tag: string, tagName: string) {
	if (hasAttribute(tag, 'integrity')) return false;
	if (tagName === 'script') return hasAttribute(tag, 'src');

	const rel = getAttribute(tag, 'rel')?.toLowerCase() ?? '';
	return rel === 'stylesheet' || rel === 'modulepreload' || rel === 'preload';
}

function addIntegrityAttributes(tag: string, integrity: string) {
	const attributes = [
		`integrity="${integrity}"`,
		hasAttribute(tag, 'crossorigin') ? null : 'crossorigin="anonymous"'
	].filter(Boolean);
	const insertAt = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1;

	return `${tag.slice(0, insertAt)} ${attributes.join(' ')}${tag.slice(insertAt)}`;
}

function getAttribute(tag: string, name: string) {
	const match = tag.match(new RegExp(`\\s${name}=(["'])(.*?)\\1`, 'i'));
	return match?.[2];
}

function hasAttribute(tag: string, name: string) {
	return new RegExp(`\\s${name}(?:\\s*=|\\s|>|/)`, 'i').test(tag);
}

function getIntegrity(assetUrl: string, baseUrl: URL) {
	const assetPath = getClientAssetPath(assetUrl, baseUrl);
	if (!assetPath) return Promise.resolve(null);

	let promise = sriCache.get(assetPath);
	if (!promise) {
		promise = readFile(assetPath)
			.then((content) => `sha384-${createHash('sha384').update(content).digest('base64')}`)
			.catch(() => null);
		sriCache.set(assetPath, promise);
	}

	return promise;
}

function getClientAssetPath(assetUrl: string, baseUrl: URL) {
	if (assetUrl.startsWith('data:')) return null;

	let url: URL;
	try {
		url = new URL(assetUrl, baseUrl);
	} catch {
		return null;
	}

	if (url.origin !== baseUrl.origin) return null;

	const appDirIndex = url.pathname.indexOf('/_app/');
	if (appDirIndex === -1) return null;

	const relativePath = decodeURIComponent(url.pathname.slice(appDirIndex + 1));
	const assetPath = path.resolve(CLIENT_OUTPUT_DIR, relativePath);
	const relativeToClient = path.relative(CLIENT_OUTPUT_DIR, assetPath);

	if (relativeToClient.startsWith('..') || path.isAbsolute(relativeToClient)) return null;
	return assetPath;
}
