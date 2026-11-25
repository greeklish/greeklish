import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Build with PUBLIC_APP_VERSION=<version>, then pass that version to this test.
// Serve the final static output, including the production CSP postprocessing.
const expectedVersion = process.argv[2];
assert(
	expectedVersion && expectedVersion !== 'previous-release',
	'Pass the expected build version'
);
const buildDir = fileURLToPath(new URL('../build/', import.meta.url));
const server = createServer(async (request, response) => {
	const pathname = new URL(request.url, 'http://localhost').pathname;
	const filename = path.resolve(buildDir, `.${pathname === '/' ? '/index.html' : pathname}`);
	if (!filename.startsWith(buildDir)) {
		response.writeHead(403).end();
		return;
	}
	try {
		const body = await readFile(filename);
		const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
		response
			.writeHead(200, {
				'Content-Type': types[path.extname(filename)] || 'application/octet-stream'
			})
			.end(body);
	} catch {
		response.writeHead(404).end();
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
	browser = await chromium.launch({
		executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
		headless: true
	});
	for (const useSharedWorker of [false, true]) {
		const page = await browser.newPage();
		const errors = [];
		const helloVersions = [];
		let staleEnvLoaded = false;
		page.on('pageerror', (error) => errors.push(error.message));
		await page.route('**/_app/env.js', (route) => {
			staleEnvLoaded = true;
			return route.fulfill({
				contentType: 'application/javascript',
				body: 'export const env = { PUBLIC_APP_VERSION: "previous-release" };'
			});
		});
		await page.route('**/api/**', (route) => route.fulfill({ json: { counts: {} } }));
		await page.addInitScript((shared) => {
			window.__versionMessages = [];
			if (!shared) {
				delete window.SharedWorker;
				return;
			}
			// Capture the real page's worker URL and connect message at the transport boundary.
			window.SharedWorker = class {
				constructor(url) {
					this.port = {
						start() {},
						close() {},
						postMessage(message) {
							if (message.type === 'connect') {
								window.__versionMessages.push({ url, version: message.appVersion });
							}
						}
					};
				}
			};
		}, useSharedWorker);
		await page.routeWebSocket(/.*/, (socket) => {
			socket.onMessage((text) => {
				const message = JSON.parse(text);
				if (message.type === 'client_hello') helloVersions.push(message.app_version);
			});
		});
		await page.goto(`http://127.0.0.1:${server.address().port}/`);
		if (useSharedWorker) {
			await page.waitForFunction(() => window.__versionMessages.length > 0);
			const messages = await page.evaluate(() => window.__versionMessages);
			for (const message of messages) {
				assert.equal(message.version, expectedVersion);
				assert.equal(
					new URL(message.url, 'http://localhost').searchParams.get('v'),
					expectedVersion
				);
			}
		} else {
			await page.waitForFunction(
				() => document.querySelector('.live-connection-button')?.dataset.state === 'open'
			);
			assert(helloVersions.length > 0);
			assert(helloVersions.every((version) => version === expectedVersion));
		}
		assert(staleEnvLoaded, 'Exercise a cached configuration from a previous release');
		assert.deepEqual(errors, []);
		console.log(
			`PASS ${useSharedWorker ? 'shared worker' : 'direct WebSocket'} uses build version with stale public configuration`
		);
		await page.close();
	}
} finally {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
}
