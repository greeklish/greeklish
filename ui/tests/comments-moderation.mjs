import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const browser = await chromium.launch({
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
	headless: true
});
const errors = [];
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => errors.push(e.message));
const requests = [];
let posts = 0;
let limited = true;
let retryScope;
const authorId = '00000000-0000-0000-0000-000000000001';
const comment = (id, body = 'Fixture comment') => ({
	id,
	body,
	author_id: authorId,
	author_display_name: 'Ίδιο όνομα',
	author_approved_count: 2,
	author_trust_state: 'normal',
	author_fingerprint: null,
	status: 'pending',
	auto_approved: false,
	hold_reason: 'below_threshold',
	created_at: new Date().toISOString(),
	topic: 'test',
	topic_display_name: 'Δοκιμαστική ροή',
	external_id: 'fixture',
	item_title: 'Ένας τίτλος για τις δοκιμές φίλτρων',
	item_url: 'https://example.test'
});
await page.route('**/api/**', async (route) => {
	const url = new URL(route.request().url());
	const path = url.pathname;
	const json = (data, status = 200) =>
		route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
	if (path === '/api/captcha/challenge')
		return json({
			algorithm: 'SHA-256',
			salt: 'fixture',
			challenge: createHash('sha256').update('fixture0').digest('hex'),
			maxnumber: 1,
			signature: 'fixture'
		});
	if (path === '/api/comments' && route.request().method() === 'POST') {
		posts++;
		if (limited)
			return json(
				{
					code: 'rate_limited',
					message: 'Το πρόχειρό σου διατηρείται.',
					retry_after_secs: 2220,
					retry_scope: retryScope
				},
				429
			);
		return json(
			{
				comment: { ...comment(`posted-${posts}`), own: true },
				guest_comment_count: 0,
				next_comment_in_secs: 2
			},
			201
		);
	}
	if (path.startsWith('/api/comments/') && !path.includes('/counts/'))
		return json({ comments: [], guest_comment_count: 0 });
	if (path === '/api/moderation/session')
		return json({ expires_at: new Date(Date.now() + 3600000).toISOString() }, 201);
	if (path === '/api/moderation/stats')
		return json({ pending: 3, approved: 0, rejected: 0, spam: 0, hidden: 0, auto_approved: 0 });
	if (path === '/api/moderation/feeds')
		return json([
			{ slug: 'test', display_name: 'Δοκιμαστική ροή' },
			{ slug: 'other', display_name: 'Άλλη ροή' }
		]);
	if (path === '/api/moderation/queue') {
		requests.push(Object.fromEntries(url.searchParams));
		if (url.searchParams.get('q') === 'missing') return json({ comments: [], next_cursor: null });
		return json({
			comments: [comment(url.searchParams.has('cursor') ? 'second' : 'first')],
			next_cursor: url.searchParams.has('cursor') ? null : 'fixture-cursor'
		});
	}
	if (path === '/api/moderation/log') {
		requests.push({ log: true, ...Object.fromEntries(url.searchParams) });
		return json({
			events: [
				{
					...comment('event'),
					comment_id: 'first',
					action: 'held',
					actor: 'system',
					recorded_at: new Date().toISOString()
				}
			],
			next_cursor: null
		});
	}
	if (route.request().method() !== 'GET') throw Error(`Unexpected write: ${path}`);
	return route.continue();
});
try {
	await page.clock.install();
	await page.goto(process.env.UI_REVIEW_BASE_URL ?? 'http://127.0.0.1:5173', {
		waitUntil: 'domcontentloaded'
	});
	await page.waitForTimeout(3000);
	await page.locator('.item-guest-comments').first().click();
	await page.locator('.composer-body').fill('Το πρόχειρο πρέπει να διατηρηθεί.');
	await page.locator('.composer-send').click();
	await page.locator('.composer-cooldown').waitFor();
	console.log('Reached rate limit');
	assert.equal(posts, 1);
	assert(await page.locator('.composer-send').isDisabled());
	assert.match(await page.locator('.composer-cooldown').innerText(), /37:00|36:59/);
	assert.equal(
		await page.locator('.composer-body').inputValue(),
		'Το πρόχειρο πρέπει να διατηρηθεί.'
	);
	await page.locator('.composer-body').press('Enter');
	assert.equal(posts, 1, 'Enter must not retry during cooldown');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	await page.locator('.item-guest-comments').first().click();
	assert(
		await page.locator('.composer-send').isDisabled(),
		'closing the rail must preserve the deadline'
	);
	console.log('Reopened cooldown');
	await page.clock.fastForward(2221000);
	console.log('Clock advanced');
	await page.waitForFunction(() => !document.querySelector('.composer-send').disabled);
	assert.equal(await page.locator('.composer-cooldown').count(), 0);
	limited = false;
	await page.locator('.composer-send').click();
	await page.waitForFunction(() => document.querySelector('.composer-body').value === '');
	assert.equal(posts, 2);
	assert(await page.locator('.composer-send').isDisabled());
	await page.clock.fastForward(2500);
	await page.locator('.composer-body').fill('Ένα ακόμη σχόλιο');
	await page.waitForFunction(() => !document.querySelector('.composer-send').disabled);
	limited = true;
	retryScope = 'item';
	await page.locator('.composer-send').click();
	await page.locator('.composer-cooldown').waitFor();
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	await page.locator('.item-guest-comments').nth(1).click();
	await page.locator('.composer-body').fill('Σχόλιο σε άλλο άρθρο');
	assert.equal(await page.locator('.composer-cooldown').count(), 0);
	assert(
		!(await page.locator('.composer-send').isDisabled()),
		'an article limit must leave other articles available'
	);
	console.log(
		'PASS long retry counts down, draft and deadline survive closing, Enter cannot retry, cooldown expires, proactive success cooldown'
	);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
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
	await page.locator('.moderation-card').waitFor();
	await page.getByLabel('Ροή', { exact: true }).selectOption('test');
	await page.getByLabel('Κατάσταση', { exact: true }).selectOption('all');
	await page.getByLabel('Σχολιαστής', { exact: true }).fill('Same');
	await page.getByLabel('Κείμενο', { exact: true }).fill('needle');
	await page.getByRole('button', { name: 'Αναζήτηση', exact: true }).click();
	await page.locator('.moderation-card').waitFor();
	assert.deepEqual(requests.at(-1), { topic: 'test', author: 'Same', q: 'needle', status: 'all' });
	await page.getByRole('button', { name: 'Περισσότερα', exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll('.moderation-card').length === 2);
	assert.equal(requests.at(-1).cursor, 'fixture-cursor');
	assert.equal(requests.at(-1).q, 'needle');
	await page.locator('.moderation-author').first().click();
	await page.locator('.moderation-card').waitFor();
	assert.equal(requests.at(-1).author_id, authorId);
	assert(!requests.at(-1).author);
	await page.getByText('Ιστορικό', { exact: true }).click();
	await page.locator('.moderation-log-entry').waitFor();
	assert.equal(requests.at(-1).author_id, authorId);
	assert(requests.at(-1).log);
	await page.getByRole('button', { name: 'Αυτόματα εγκεκριμένα', exact: true }).click();
	await page.locator('.moderation-log-entry').waitFor();
	assert.equal(requests.at(-1).action, 'auto_approved');
	await page.getByText('Σχόλια', { exact: true }).click();
	await page.locator('.moderation-card').waitFor();
	await page.getByLabel('Κείμενο', { exact: true }).fill('missing');
	await page.getByRole('button', { name: 'Αναζήτηση', exact: true }).click();
	await page.getByText('Δεν βρέθηκαν σχόλια με αυτά τα φίλτρα.').waitFor();
	await page.getByRole('button', { name: 'Καθαρισμός', exact: true }).click();
	await page.locator('.moderation-card').waitFor();
	assert.deepEqual(requests.at(-1), { status: 'pending' });
	console.log(
		'PASS feed, status, name, text and exact author filters; paged filters; history; empty state; reset'
	);
	for (const [width, height] of [
		[320, 740],
		[390, 844],
		[768, 1024],
		[1024, 768],
		[1600, 1000],
		[2560, 1440]
	]) {
		await page.setViewportSize({ width, height });
		await page.waitForTimeout(500);
		assert(
			!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
			`overflow ${width}`
		);
		const panel = page.locator('.moderation-panel');
		assert(
			!(await panel.evaluate((el) => el.scrollWidth > el.clientWidth)),
			`filter overflow ${width}`
		);
	}
	assert.deepEqual(errors, []);
	console.log('PASS moderation layout at six widths, no browser errors');
} catch (error) {
	console.log('Browser errors:', errors);
	throw error;
} finally {
	await browser.close();
}
