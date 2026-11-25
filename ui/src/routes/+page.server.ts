import { loadInitialFeeds } from '$lib/server/initial-feed';
import {
	ADSLGR_TOPICS_TOPIC,
	GREECE_RISING_TOPIC,
	INSOMNIA_TOPICS_TOPIC,
	LAGONIKA_OFFERS_TOPIC,
	MYPHONE_TOPICS_TOPIC,
	PHORUM_TOPICS_TOPIC,
	X_TRENDS_TOPIC
} from '$lib/live-feed';
import type { PageServerLoad } from './$types';

export const prerender = true;

export const load: PageServerLoad = async () => {
	return loadInitialFeeds([
		{ topic: GREECE_RISING_TOPIC, displayName: 'r/greece', strategy: 'external' },
		{ topic: INSOMNIA_TOPICS_TOPIC, displayName: 'insomnia', strategy: 'hot' },
		{ topic: PHORUM_TOPICS_TOPIC, displayName: 'phorum', strategy: 'hot' },
		{ topic: LAGONIKA_OFFERS_TOPIC, displayName: 'lagonika', strategy: 'external' },
		{ topic: X_TRENDS_TOPIC, displayName: 'twitter/x', strategy: 'external' },
		{ topic: ADSLGR_TOPICS_TOPIC, displayName: 'adslgr', strategy: 'hot' },
		{ topic: MYPHONE_TOPICS_TOPIC, displayName: 'myphone', strategy: 'hot' }
	]);
};
