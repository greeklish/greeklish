import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
	plugins: [
		{
			name: 'suggestion-fixtures',
			enforce: 'pre',
			load(id) {
				if (!id.endsWith('/src/lib/server/initial-feed.ts')) return;
				return `export async function loadInitialFeeds(topics) {
   const now = Date.now(), timestamp = new Date(now).toISOString();
   return { feeds: Object.fromEntries(topics.map(topic => [topic.topic, {
    displayName: topic.displayName, strategy: topic.strategy, asOf: now,
    snapshots: [{ id: topic.topic, crawled_at: timestamp, items: Array.from({length: 20}, (_, i) => ({
     external_id: 'item-' + i, title: 'Θέμα ' + i + ' από ' + topic.displayName,
     url: 'https://example.test/item/' + i, score: 100-i, comments_count: 10,
     rank_position: i+1, published_at: timestamp, crawled_at: timestamp
    })) }]
   }])) };
  }`;
			}
		}
	],
	server: { host: '127.0.0.1', hmr: false }
});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
	headless: true
});
const errors = [];
try {
	await mkdir('/tmp/greeklish-suggestions-review', { recursive: true });
	for (const [width, dark] of [
		[320, false],
		[390, true],
		[1440, false],
		[2160, true]
	]) {
		const context = await browser.newContext({
			viewport: { width, height: 900 },
			colorScheme: dark ? 'dark' : 'light',
			isMobile: width < 768,
			hasTouch: width < 768,
			reducedMotion: 'reduce'
		});
		await context.addInitScript(() => {
			delete window.SharedWorker;
		});
		await context.routeWebSocket(/.*/, () => {});
		const submissions = [],
			decisions = [];
		let limited = true,
			authenticated = false,
			statsRequests = 0,
			commentToken;
		const item = (id, status = 'pending') => ({
			id,
			author_id: 'guest',
			url: 'https://example.test/' + id,
			name: 'Δοκιμαστική πηγή ' + id,
			explanation: 'Μια ενδιαφέρουσα κοινότητα',
			email: 'guest+news@example.test',
			status,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString()
		});
		const items = [item('one'), item('two')];
		await context.route('**/api/**', async (route) => {
			const req = route.request(),
				url = new URL(req.url()),
				path = url.pathname;
			const json = (data, status = 200) => route.fulfill({ status, json: data });
			if (path === '/api/captcha/challenge')
				return json({
					algorithm: 'SHA-256',
					salt: 'fixture',
					challenge: createHash('sha256').update('fixture0').digest('hex'),
					maxnumber: 1,
					signature: 'fixture'
				});
			if (path === '/api/feed-suggestions') {
				submissions.push({ body: req.postDataJSON(), token: req.headers()['x-guest-token'] });
				if (limited)
					return json(
						{ code: 'rate_limited', message: 'Η πρότασή σου διατηρείται.', retry_after_secs: 2 },
						429
					);
				return json(
					{
						id: 'created',
						status: 'pending',
						author_token: 'fixture-guest-token',
						next_submission_in_secs: 2
					},
					201
				);
			}
			if (path === '/api/moderation/session') {
				if (req.method() === 'POST') {
					authenticated = true;
					return json({ expires_at: new Date(Date.now() + 3600000).toISOString() }, 201);
				}
				if (req.method() === 'DELETE') {
					authenticated = false;
					return route.fulfill({ status: 204 });
				}
				return json({}, 401);
			}
			if (path === '/api/moderation/connection-stats') {
				statsRequests++;
				assert(authenticated, 'Guest must never request connection statistics');
				return json({
					type: 'connection_stats',
					unique_client_ips: 7,
					websocket_connections: 9,
					as_of: Date.now()
				});
			}
			if (path === '/api/moderation/stats')
				return json({
					pending: 0,
					approved: 0,
					rejected: 0,
					spam: 0,
					hidden: 0,
					auto_approved: 0,
					pending_suggestions: items.filter((i) => i.status === 'pending').length
				});
			if (path === '/api/moderation/feeds') return json([]);
			if (path === '/api/moderation/feed-suggestions') {
				assert(authenticated);
				const filtered = items.filter(
					(i) =>
						url.searchParams.get('status') === 'all' || i.status === url.searchParams.get('status')
				);
				const page = filtered.slice(
					url.searchParams.has('cursor') ? 1 : 0,
					url.searchParams.has('cursor') ? 2 : 1
				);
				return json({
					suggestions: page,
					next_cursor: !url.searchParams.has('cursor') && filtered.length > 1 ? 'next' : null,
					pending: items.filter((i) => i.status === 'pending').length
				});
			}
			if (path.startsWith('/api/moderation/feed-suggestions/') && path.endsWith('/status')) {
				assert(authenticated);
				decisions.push(req.postDataJSON());
				items.find((i) => path.includes('/' + i.id + '/')).status = req.postDataJSON().status;
				return route.fulfill({ status: 204 });
			}
			if (path === '/api/comments' && req.method() === 'POST') {
				commentToken = req.headers()['x-guest-token'];
				return json({ code: 'rate_limited', message: 'Comment fixture', retry_after_secs: 2 }, 429);
			}
			if (req.method() !== 'GET') throw new Error(`Unexpected write: ${path}`);
			return json({
				counts: {},
				comments: [],
				guest_comment_count: 0,
				discussions: [],
				notifications: [],
				unread: 0,
				next_cursor: null
			});
		});
		const page = await context.newPage();
		page.setDefaultTimeout(10000);
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto(base);
		await page.waitForFunction(() =>
			['open', 'problem'].includes(document.querySelector('.live-connection-button')?.dataset.state)
		);
		const controls = await page.locator('.header-controls button').allTextContents();
		assert.equal(
			await page.locator('.site-intro p .info-text-link').innerText(),
			'Περισσότερες πληροφορίες…'
		);
		assert.equal(await page.locator('.header-controls .live-connection-button').count(), 0);
		assert.equal(
			controls.findIndex((s) => s.includes('Πρότεινε πηγή')),
			controls.findIndex((s) => s.includes('Ρυθμίσεις')) + 1
		);
		await page.locator('.live-connection-button').click();
		assert.equal(await page.locator('.info-modal-stats').count(), 0);
		assert.equal(statsRequests, 0);
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: 'Πρότεινε πηγή', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Πρότεινε πηγή', exact: true });
		await dialog.waitFor();
		await page.getByLabel('Σύνδεσμος πηγής').fill('https://example.test/feed');
		await page.getByLabel('Όνομα πηγής').fill('Πηγή δοκιμής');
		await page.getByLabel('Γιατί την προτείνεις;').fill('Χρήσιμα θέματα');
		await page.getByLabel('Email', { exact: false }).fill('guest+news@example.test');
		await page.keyboard.press('Escape');
		await dialog.waitFor({ state: 'detached' });
		await page.getByRole('button', { name: 'Πρότεινε πηγή', exact: true }).click();
		assert.equal(
			await page.getByLabel('Σύνδεσμος πηγής').inputValue(),
			'https://example.test/feed'
		);
		await page.getByRole('button', { name: 'Υποβολή πρότασης', exact: true }).click();
		await page.getByRole('alert').filter({ hasText: 'Η πρότασή σου διατηρείται.' }).waitFor();
		assert.equal(submissions.length, 1);
		assert.equal(submissions[0].body.captcha.number, 0, 'Real proof-of-work worker completed');
		assert(await page.getByRole('button', { name: 'Υποβολή πρότασης', exact: true }).isDisabled());
		assert.equal(
			await page.getByLabel('Email', { exact: false }).inputValue(),
			'guest+news@example.test'
		);
		assert.equal(
			await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
			false
		);
		await page.screenshot({
			path: `/tmp/greeklish-suggestions-review/form-${width}.png`,
			fullPage: false
		});
		limited = false;
		await page.waitForFunction(() => !document.querySelector('.suggestion-submit').disabled);
		await page.getByRole('button', { name: 'Υποβολή πρότασης', exact: true }).click();
		await page
			.getByText('Ευχαριστούμε! Η πρότασή σου στάλθηκε στους συντονιστές για έλεγχο.')
			.waitFor();
		assert.equal(submissions.length, 2);
		await dialog.getByRole('button', { name: 'Κλείσιμο', exact: true }).click();
		await page.getByRole('button', { name: 'Πρότεινε πηγή', exact: true }).click();
		assert.equal(await page.getByLabel('Σύνδεσμος πηγής').inputValue(), '');
		await page.keyboard.press('Escape');
		await page.locator('.item-guest-comments').first().click();
		await page.locator('.composer-body').fill('Ένα σχόλιο με την ίδια ανώνυμη ταυτότητα');
		await page.locator('.composer-send').click();
		await page.locator('.composer-cooldown').waitFor();
		assert.equal(commentToken, 'fixture-guest-token');
		await page.keyboard.press('Escape');
		await page.locator('body').click({ position: { x: 5, y: 5 } });
		for (const key of [
			'ArrowUp',
			'ArrowUp',
			'ArrowDown',
			'ArrowDown',
			'ArrowLeft',
			'ArrowRight',
			'ArrowLeft',
			'ArrowRight',
			'b',
			'a'
		])
			await page.keyboard.press(key);
		await page.locator('input[type=password]').fill('fixture-password');
		await page.locator('input[type=password]').press('Enter');
		await page.getByText('Προτάσεις (2)', { exact: true }).click();
		await page.locator('.suggestion-list li').waitFor();
		await page.getByRole('button', { name: 'Περισσότερες προτάσεις', exact: true }).click();
		await page.waitForFunction(() => document.querySelectorAll('.suggestion-list li').length === 2);
		await page
			.locator('.suggestion-list li')
			.first()
			.getByRole('button', { name: 'Προστέθηκε', exact: true })
			.click();
		await page.waitForFunction(() => document.querySelectorAll('.suggestion-list li').length === 1);
		assert.deepEqual(decisions, [{ status: 'added' }]);
		await page.getByLabel('Κατάσταση', { exact: true }).selectOption('added');
		const email = page.getByRole('link', { name: 'Σύνταξη email', exact: true });
		await email.waitFor();
		assert.match(
			decodeURIComponent(await email.getAttribute('href')),
			/^mailto:guest\+news@example.test\?subject=Η πηγή/
		);
		assert.equal(
			await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
			false,
			`page overflow ${width}`
		);
		assert.equal(
			await page.locator('.moderation-panel').evaluate((el) => el.scrollWidth > el.clientWidth),
			false,
			`moderation overflow ${width}`
		);
		await page.screenshot({
			path: `/tmp/greeklish-suggestions-review/moderation-${width}.png`,
			fullPage: false
		});
		await page.keyboard.press('Escape');
		await page.locator('.live-connection-button').click();
		await page.locator('.info-modal-stats').filter({ hasText: '7' }).waitFor();
		assert.equal(statsRequests, 1);
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: 'Διαχείριση σχολίων', exact: true }).click();
		await page.getByRole('button', { name: 'Αποσύνδεση συντονισμού', exact: true }).click();
		await page.locator('.live-connection-button').click();
		assert.equal(await page.locator('.info-modal-stats').count(), 0);
		assert.equal(statsRequests, 1);
		await page.keyboard.press('Escape');
		await page.mouse.wheel(0, 500);
		await page.waitForFunction(() => window.scrollY > 0);
		await context.close();
		console.log(
			`PASS suggestions, retry, shared author, private stats, review and mailto at ${width}px ${dark ? 'dark' : 'light'}`
		);
	}
	assert.deepEqual(errors, []);
	if (process.env.CHECK_COMMENT_REGRESSIONS === '1') {
		const code = await new Promise((resolve) =>
			spawn(process.execPath, ['tests/comments-moderation.mjs'], {
				env: { ...process.env, UI_REVIEW_BASE_URL: base },
				stdio: 'inherit'
			}).on('exit', resolve)
		);
		assert.equal(code, 0, 'Existing comment and moderation browser regressions');
	}
} finally {
	await browser.close();
	await server.close();
}
