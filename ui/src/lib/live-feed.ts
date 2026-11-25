import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

export const GREECE_RISING_TOPIC = 'r-greece-rising';
export const X_TRENDS_TOPIC = 'x-trends';
export const INSOMNIA_TOPICS_TOPIC = 'insomnia-topics';
export const MYPHONE_TOPICS_TOPIC = 'myphone-topics';
export const PHORUM_TOPICS_TOPIC = 'phorum-topics';
export const ADSLGR_TOPICS_TOPIC = 'adslgr-topics';
export const LAGONIKA_OFFERS_TOPIC = 'lagonika-offers';
export const FEED_INITIAL_VISIBLE_COUNTS = {
	[GREECE_RISING_TOPIC]: 18,
	[X_TRENDS_TOPIC]: 25,
	[INSOMNIA_TOPICS_TOPIC]: 25,
	[MYPHONE_TOPICS_TOPIC]: 25,
	[PHORUM_TOPICS_TOPIC]: 25,
	[ADSLGR_TOPICS_TOPIC]: 25,
	[LAGONIKA_OFFERS_TOPIC]: 15
} as const;
// Embed the release version in the fingerprinted bundle. The unversioned public env.js
// can remain cached after a deployment and would otherwise trigger unnecessary reloads.
const APP_VERSION = __GREEKLISH_APP_VERSION__;
const RELOAD_VERSION_QUERY_PARAM = '__greeklish_v';
const SHARED_WORKER_URL = `/shared-topic-worker.js?v=${encodeURIComponent(APP_VERSION)}`;

if (browser) {
	cleanupReloadVersionQueryParam();
}

export type RankingStrategy = 'hot' | 'chronological' | 'external';

export type RankedItem = {
	id: string;
	title: string;
	url: string;
	source_slug: string;
	external_id: string;
	score: number;
	comments_count?: number | null;
	nsfw?: boolean | null;
	rank_position: number;
	published_at: string;
	crawled_at: string;
};

export type CrawlSnapshotItem = {
	external_id: string;
	title: string;
	url: string;
	score: number;
	comments_count?: number | null;
	nsfw?: boolean | null;
	rank_position: number;
	published_at: string;
	crawled_at: string;
	metadata?: unknown | null;
};

export type CrawlSnapshot = {
	id: string;
	crawled_at: string;
	items: CrawlSnapshotItem[];
};

export type TopicSnapshotMessage = {
	type: 'topic_snapshot';
	topic: string;
	display_name: string;
	strategy: RankingStrategy;
	items: RankedItem[];
	as_of: number;
};

export type CrawlSnapshotMessage = {
	type: 'crawl_snapshot';
	topic: string;
	display_name: string;
	snapshot: CrawlSnapshot;
};

export type CrawlSnapshotsMessage = {
	type: 'crawl_snapshots';
	topic: string;
	display_name: string;
	snapshots: CrawlSnapshot[];
	as_of: number;
};

export type ConnectionStatsMessage = {
	type: 'connection_stats';
	unique_client_ips: number;
	websocket_connections: number;
	as_of: number;
};

export type ClientReloadMessage = {
	type: 'client_reload';
	current_version?: string | null;
	required_version: string;
	reason: string;
};

export type GuestCommentPayload = {
	id: string;
	author_display_name: string;
	body: string;
	created_at: string;
	status: 'pending' | 'approved';
	auto_approved: boolean;
	own: boolean;
	reply_to_comment_id?: string | null;
};

export type GuestCommentCreatedMessage = {
	type: 'guest_comment_created';
	topic: string;
	external_id: string;
	guest_comment_count: number;
	comment: GuestCommentPayload;
};

export type GuestCommentRemovedMessage = {
	type: 'guest_comment_removed';
	topic: string;
	external_id: string;
	comment_id: string;
	guest_comment_count: number;
};

export type GuestCommentCountMessage = {
	type: 'guest_comment_count';
	topic: string;
	external_id: string;
	guest_comment_count: number;
};

export type ModerationQueueChangedMessage = {
	type: 'moderation_queue_changed';
	pending: number;
	as_of: number;
};

export type ErrorMessage = {
	type: 'error';
	code: string;
	message: string;
};

export type ServerMessage =
	| TopicSnapshotMessage
	| CrawlSnapshotMessage
	| CrawlSnapshotsMessage
	| ConnectionStatsMessage
	| ClientReloadMessage
	| GuestCommentCreatedMessage
	| GuestCommentRemovedMessage
	| GuestCommentCountMessage
	| ModerationQueueChangedMessage
	| ErrorMessage;

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';
type SnapshotHistoryLoadStrategy = 'immediate' | 'idle';

type TopicFeedHandlers = {
	sinceMs?: number;
	requestLatestCrawlSnapshot?: boolean;
	snapshotHistoryLoadStrategy?: SnapshotHistoryLoadStrategy;
	snapshotHistoryLoadDelayMs?: number;
	onState?: (state: ConnectionState) => void;
	onSnapshot: (message: TopicSnapshotMessage) => void;
	onCrawlSnapshot?: (message: CrawlSnapshotMessage) => void;
	onCrawlSnapshots?: (message: CrawlSnapshotsMessage) => void;
	onGuestCommentCreated?: (message: GuestCommentCreatedMessage) => void;
	onGuestCommentRemoved?: (message: GuestCommentRemovedMessage) => void;
	onGuestCommentCount?: (message: GuestCommentCountMessage) => void;
	onError?: (message: string) => void;
};

const DEFAULT_SNAPSHOT_HISTORY_LOAD_DELAY_MS = 250;

export function connectTopicFeed(topic: string, handlers: TopicFeedHandlers) {
	if (!browser) {
		return () => {};
	}

	if ('SharedWorker' in window) {
		return connectSharedTopicFeed(topic, handlers);
	}

	return connectDirectTopicFeed(topic, handlers);
}

function connectSharedTopicFeed(topic: string, handlers: TopicFeedHandlers) {
	let worker: SharedWorker;

	try {
		worker = new SharedWorker(SHARED_WORKER_URL, {
			name: 'greeklish-live-feed'
		});
	} catch {
		return connectDirectTopicFeed(topic, handlers);
	}

	const port = worker.port;
	port.start();

	port.onmessage = (event) => {
		const payload = event.data;

		if (!payload || typeof payload !== 'object') {
			return;
		}

		if (payload.type === 'state') {
			handlers.onState?.(payload.state as ConnectionState);
			return;
		}

		if (payload.type === 'server') {
			handleServerMessage(payload.message as ServerMessage, topic, handlers);
			return;
		}

		if (payload.type === 'client_reload') {
			reloadPageForVersion(payload.message as ClientReloadMessage);
			return;
		}

		if (payload.type === 'error') {
			handlers.onError?.(payload.message);
		}
	};

	port.postMessage({
		type: 'connect',
		wsUrl: resolveWsUrl(),
		appVersion: APP_VERSION
	});
	port.postMessage({
		type: 'subscribe',
		topic
	});
	if (handlers.requestLatestCrawlSnapshot) {
		port.postMessage({
			type: 'latest_crawl_snapshot',
			topic
		});
	}
	const cancelHistoryLoad = scheduleSnapshotHistoryLoad(() => {
		if (handlers.sinceMs === undefined) {
			return;
		}

		port.postMessage({
			type: 'crawl_snapshots',
			topic,
			since_ms: handlers.sinceMs
		});
	}, handlers);

	return () => {
		cancelHistoryLoad();
		port.postMessage({
			type: 'unsubscribe',
			topic
		});
		port.postMessage({
			type: 'disconnect'
		});
		port.close();
		handlers.onState?.('closed');
	};
}

function connectDirectTopicFeed(topic: string, handlers: TopicFeedHandlers) {
	let socket: WebSocket | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let cancelHistoryLoad = () => {};
	let manuallyClosed = false;
	let retryAttempt = 0;

	const open = () => {
		handlers.onState?.('connecting');
		socket = new WebSocket(resolveWsUrl());

		socket.addEventListener('open', () => {
			retryAttempt = 0;
			handlers.onState?.('open');
			socket?.send(
				JSON.stringify({
					type: 'client_hello',
					app_version: APP_VERSION
				})
			);
			socket?.send(
				JSON.stringify({
					type: 'subscribe',
					topics: [topic]
				})
			);
			if (handlers.requestLatestCrawlSnapshot) {
				socket?.send(
					JSON.stringify({
						type: 'latest_crawl_snapshot',
						topic
					})
				);
			}
			cancelHistoryLoad();
			cancelHistoryLoad = scheduleSnapshotHistoryLoad(() => {
				if (handlers.sinceMs === undefined) {
					return;
				}

				socket?.send(
					JSON.stringify({
						type: 'crawl_snapshots',
						topic,
						since_ms: handlers.sinceMs
					})
				);
			}, handlers);
		});

		socket.addEventListener('message', (event) => {
			try {
				handleServerMessage(JSON.parse(event.data) as ServerMessage, topic, handlers);
			} catch {
				handlers.onError?.('Received an invalid WebSocket message.');
			}
		});

		socket.addEventListener('close', () => {
			socket = null;
			handlers.onState?.('closed');

			if (!manuallyClosed) {
				const delay = Math.min(1000 * 2 ** retryAttempt, 10000);
				retryAttempt += 1;
				retryTimer = setTimeout(open, delay);
			}
		});

		socket.addEventListener('error', () => {
			handlers.onState?.('error');
			handlers.onError?.('WebSocket connection failed.');
		});
	};

	open();

	return () => {
		manuallyClosed = true;
		cancelHistoryLoad();

		if (retryTimer) {
			clearTimeout(retryTimer);
		}

		if (socket && socket.readyState === WebSocket.OPEN) {
			socket.send(
				JSON.stringify({
					type: 'unsubscribe',
					topics: [topic]
				})
			);
		}

		socket?.close();
		socket = null;
		handlers.onState?.('closed');
	};
}

function scheduleSnapshotHistoryLoad(send: () => void, handlers: TopicFeedHandlers) {
	if (handlers.sinceMs === undefined) {
		return () => {};
	}

	if (handlers.snapshotHistoryLoadStrategy !== 'idle') {
		send();
		return () => {};
	}

	let cancelled = false;
	let timeoutId: number | null = null;
	let idleId: number | null = null;

	const run = () => {
		if (cancelled) {
			return;
		}

		send();
	};

	const scheduleIdleCallback = () => {
		if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
			idleId = window.requestIdleCallback(run, { timeout: 1_000 });
			return;
		}

		run();
	};

	timeoutId = window.setTimeout(
		scheduleIdleCallback,
		handlers.snapshotHistoryLoadDelayMs ?? DEFAULT_SNAPSHOT_HISTORY_LOAD_DELAY_MS
	);

	return () => {
		cancelled = true;

		if (timeoutId !== null) {
			window.clearTimeout(timeoutId);
		}

		if (idleId !== null && typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
			window.cancelIdleCallback(idleId);
		}
	};
}

function handleServerMessage(message: ServerMessage, topic: string, handlers: TopicFeedHandlers) {
	if (message.type === 'client_reload') {
		reloadPageForVersion(message);
		return;
	}

	if (message.type === 'topic_snapshot' && message.topic === topic) {
		handlers.onSnapshot(message);
		return;
	}

	if (message.type === 'crawl_snapshot' && message.topic === topic) {
		handlers.onCrawlSnapshot?.(message);
		return;
	}

	if (message.type === 'crawl_snapshots' && message.topic === topic) {
		handlers.onCrawlSnapshots?.(message);
		return;
	}

	if (message.type === 'guest_comment_created' && message.topic === topic) {
		handlers.onGuestCommentCreated?.(message);
		return;
	}

	if (message.type === 'guest_comment_removed' && message.topic === topic) {
		handlers.onGuestCommentRemoved?.(message);
		return;
	}

	if (message.type === 'guest_comment_count' && message.topic === topic) {
		handlers.onGuestCommentCount?.(message);
		return;
	}

	if (message.type === 'error') {
		handlers.onError?.(message.message);
	}
}

function reloadPageForVersion(message: ClientReloadMessage) {
	if (!browser) {
		return;
	}

	const requiredVersion = message.required_version || 'latest';
	const storageKey = `greeklish-client-reload:${requiredVersion}`;

	try {
		if (window.sessionStorage.getItem(storageKey) === '1') {
			return;
		}

		window.sessionStorage.setItem(storageKey, '1');
	} catch {
		// If storage is unavailable, still try the cache-busted reload.
	}

	const nextUrl = new URL(window.location.href);
	nextUrl.searchParams.set(RELOAD_VERSION_QUERY_PARAM, requiredVersion);
	window.location.replace(nextUrl.toString());
}

function cleanupReloadVersionQueryParam() {
	const currentUrl = new URL(window.location.href);

	if (!currentUrl.searchParams.has(RELOAD_VERSION_QUERY_PARAM)) {
		return;
	}

	currentUrl.searchParams.delete(RELOAD_VERSION_QUERY_PARAM);
	window.history.replaceState(window.history.state, '', currentUrl.toString());
}

function resolveWsUrl() {
	if (env.PUBLIC_WS_URL) {
		return env.PUBLIC_WS_URL;
	}

	const { protocol, hostname, port } = window.location;
	const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';

	if (hostname === 'localhost' || hostname === '127.0.0.1') {
		return `${wsProtocol}//${hostname}:3000/ws`;
	}

	const host = port ? `${hostname}:${port}` : hostname;
	return `${wsProtocol}//${host}/ws`;
}
