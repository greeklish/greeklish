import type { CrawlSnapshotItem } from '$lib/live-feed';

type LinkableItem = Pick<CrawlSnapshotItem, 'metadata' | 'nsfw' | 'url'>;

export type ItemDiscussionLink = {
	id: string;
	text: string;
	url: string;
};

export function getItemUrl(item: LinkableItem, useOldRedditForNsfw: boolean) {
	const itemUrl = getPreferredItemUrl(item, useOldRedditForNsfw);

	try {
		const url = new URL(itemUrl);
		if (isIpbTopicUrl(url)) {
			return getIpbTopicFirstUnreadUrl(url);
		}

		if (isPhorumTopicUrl(url)) {
			return getPhorumTopicFirstUnreadUrl(url);
		}

		if (isAdslgrTopicUrl(url)) {
			return getVbulletinTopicFirstUnreadUrl(url);
		}

		return url.toString();
	} catch {
		return itemUrl;
	}
}

export function getItemCommentsUrl(item: LinkableItem, useOldRedditForNsfw: boolean) {
	const itemUrl = getPreferredItemUrl(item, useOldRedditForNsfw);

	try {
		const url = new URL(itemUrl);
		if (isIpbTopicUrl(url)) {
			return getIpbTopicLastCommentUrl(url);
		}

		if (isRedditUrl(url)) {
			url.searchParams.set('sort', 'new');
			return url.toString();
		}

		if (isPhorumTopicUrl(url)) {
			return getPhorumTopicLastPostUrl(item, url);
		}

		if (isAdslgrTopicUrl(url)) {
			return getVbulletinTopicLastPostUrl(url);
		}

		return url.toString();
	} catch {
		return itemUrl;
	}
}

export function getItemDiscussionLinks(
	item: LinkableItem,
	useOldRedditForNsfw: boolean
): ItemDiscussionLink[] {
	const itemUrl = getPreferredItemUrl(item, useOldRedditForNsfw);

	try {
		const url = new URL(itemUrl);
		if (isRedditUrl(url)) {
			return [
				getRedditSortLink(url, 'confidence', 'best'),
				getRedditSortLink(url, 'top', 'top'),
				getRedditSortLink(url, 'new', 'new'),
				getRedditSortLink(url, 'controversial', 'controversial'),
				getRedditSortLink(url, 'old', 'old'),
				getRedditSortLink(url, 'qa', 'q&a')
			];
		}

		if (isIpbTopicUrl(url)) {
			return getUnreadAndLatestLinks(
				getIpbTopicFirstUnreadUrl(url),
				getIpbTopicLastCommentUrl(url)
			);
		}

		if (isPhorumTopicUrl(url)) {
			return getUnreadAndLatestLinks(
				getPhorumTopicFirstUnreadUrl(url),
				getPhorumTopicLastPostUrl(item, url)
			);
		}

		if (isAdslgrTopicUrl(url)) {
			return getUnreadAndLatestLinks(
				getVbulletinTopicFirstUnreadUrl(url),
				getVbulletinTopicLastPostUrl(url)
			);
		}

		return [];
	} catch {
		return [];
	}
}

function getUnreadAndLatestLinks(unreadUrl: string, latestUrl: string): ItemDiscussionLink[] {
	return [
		{ id: 'unread', text: 'Άνοιγμα μη αναγνωσμένων', url: unreadUrl },
		{ id: 'latest', text: 'Άνοιγμα τελευταίων', url: latestUrl }
	];
}

function getRedditSortLink(url: URL, sort: string, label: string): ItemDiscussionLink {
	const sortedUrl = new URL(url);
	sortedUrl.searchParams.set('sort', sort);
	return { id: `reddit-${sort}`, text: `Άνοιγμα ${label}`, url: sortedUrl.toString() };
}

function getPreferredItemUrl(item: LinkableItem, useOldRedditForNsfw: boolean) {
	try {
		const url = new URL(item.url);

		if (item.nsfw && useOldRedditForNsfw && url.hostname === 'www.reddit.com') {
			url.hostname = 'old.reddit.com';
		}

		return url.toString();
	} catch {
		return item.url;
	}
}

export function getIpbTopicLastCommentUrl(url: URL) {
	return getIpbTopicRedirectUrl(url, 'getLastComment');
}

export function getIpbTopicFirstUnreadUrl(url: URL) {
	return getIpbTopicRedirectUrl(url, 'getNewComment');
}

export function getPhorumTopicLastPageUrl(url: URL) {
	const lastPageUrl = new URL(url);
	lastPageUrl.hash = '';
	lastPageUrl.searchParams.set('start', '9999');
	return lastPageUrl.toString();
}

export function getPhorumTopicLastPostUrl(item: LinkableItem, url: URL) {
	const lastPostUrl = getMetadataUrl(item, 'last_post_url');
	if (lastPostUrl) {
		return lastPostUrl;
	}

	return getPhorumTopicLastPageUrl(url);
}

export function getPhorumTopicFirstUnreadUrl(url: URL) {
	const unreadUrl = new URL(url);
	unreadUrl.hash = '';
	unreadUrl.searchParams.set('view', 'unread');
	return unreadUrl.toString();
}

export function getVbulletinTopicFirstUnreadUrl(url: URL) {
	const unreadUrl = getVbulletinCanonicalTopicUrl(url);
	unreadUrl.searchParams.set('goto', 'newpost');
	return unreadUrl.toString();
}

export function getVbulletinTopicLastPostUrl(url: URL) {
	if (url.searchParams.has('p') || /^#post\d+$/i.test(url.hash)) {
		return url.toString();
	}

	const lastPostUrl = getVbulletinCanonicalTopicUrl(url);
	lastPostUrl.searchParams.set('goto', 'lastpost');
	return lastPostUrl.toString();
}

function getVbulletinCanonicalTopicUrl(url: URL) {
	const canonicalUrl = new URL(url);
	canonicalUrl.hash = '';
	canonicalUrl.searchParams.delete('p');
	canonicalUrl.searchParams.delete('s');
	canonicalUrl.searchParams.delete('goto');
	return canonicalUrl;
}

function getIpbTopicRedirectUrl(url: URL, action: 'getLastComment' | 'getNewComment') {
	const redirectUrl = new URL(url);
	redirectUrl.hash = '';
	redirectUrl.searchParams.append('do', action);
	return redirectUrl.toString();
}

function getMetadataUrl(item: LinkableItem, key: string) {
	if (!item.metadata || typeof item.metadata !== 'object') {
		return null;
	}

	const value = (item.metadata as Record<string, unknown>)[key];
	if (typeof value !== 'string' || !value.trim()) {
		return null;
	}

	try {
		return new URL(value).toString();
	} catch {
		return null;
	}
}

function isRedditUrl(url: URL) {
	return url.hostname === 'www.reddit.com' || url.hostname === 'old.reddit.com';
}

function isIpbTopicUrl(url: URL) {
	return (
		(url.hostname.endsWith('insomnia.gr') && url.pathname.includes('/forums/topic/')) ||
		(url.hostname.endsWith('myphone.gr') && url.pathname.includes('/forum/topic/'))
	);
}

function isPhorumTopicUrl(url: URL) {
	return url.hostname.endsWith('phorum.com.gr') && url.pathname.endsWith('/viewtopic.php');
}

function isAdslgrTopicUrl(url: URL) {
	return url.hostname.endsWith('adslgr.com') && url.pathname.includes('/forum/threads/');
}
