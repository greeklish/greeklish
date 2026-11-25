import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import {
	type CrawlSnapshot,
	type RankingStrategy,
	type ServerMessage
} from '$lib/live-feed';

const DEFAULT_BACKEND_WS_URL = 'ws://127.0.0.1:3000/ws';
const INITIAL_FEED_TIMEOUT_MS = 10_000;

export type InitialFeedData = {
	displayName: string;
	strategy: RankingStrategy | null;
	snapshots: CrawlSnapshot[];
	asOf: number;
};

export type InitialFeedsData = {
	feeds: Record<string, InitialFeedData>;
};

export type InitialFeedTopic = {
	topic: string;
	displayName: string;
	strategy?: RankingStrategy | null;
};

export async function loadInitialFeeds(topics: InitialFeedTopic[]): Promise<InitialFeedsData> {
	const entries = await Promise.all(
		topics.map(async (topic) => [
			topic.topic,
			await loadInitialFeed(topic.topic, topic.displayName, topic.strategy ?? null)
		])
	);

	return {
		feeds: Object.fromEntries(entries)
	};
}

function loadInitialFeed(
	topic: string,
	displayName: string,
	strategy: RankingStrategy | null
): Promise<InitialFeedData> {
	const wsUrl = env.PRERENDER_WS_URL || publicEnv.PUBLIC_WS_URL || DEFAULT_BACKEND_WS_URL;

	return new Promise((resolve, reject) => {
		const socket = new WebSocket(wsUrl);
		let settled = false;

		const timeout = setTimeout(() => {
			finish(
				new Error(
					`Timed out after ${INITIAL_FEED_TIMEOUT_MS}ms while loading initial feed data from ${wsUrl}`
				)
			);
		}, INITIAL_FEED_TIMEOUT_MS);

		const fallback = (): InitialFeedData => ({
			displayName,
			strategy,
			snapshots: [],
			asOf: Date.now()
		});

		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.close();

			if (error) {
				reject(error);
				return;
			}

			resolve(fallback());
		};

		socket.addEventListener('open', () => {
			socket.send(
				JSON.stringify({
					type: 'latest_crawl_snapshot',
					topic
				})
			);
		});

		socket.addEventListener('message', (event) => {
			try {
				const message = JSON.parse(String(event.data)) as ServerMessage;

				if (message.type === 'crawl_snapshot' && message.topic === topic) {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					socket.close();
					resolve({
						displayName: message.display_name,
						strategy: null,
						snapshots: [message.snapshot],
						asOf: Date.now()
					});
					return;
				}

				if (message.type === 'error') {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					socket.close();
					resolve(fallback());
				}
			} catch {
				finish(new Error('Backend returned invalid JSON while loading initial feed data.'));
			}
		});

		socket.addEventListener('error', () => {
			finish(new Error(`Could not connect to the initial feed backend at ${wsUrl}`));
		});

		socket.addEventListener('close', () => {
			finish();
		});
	});
}
