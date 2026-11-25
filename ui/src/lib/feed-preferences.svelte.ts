import { SvelteSet } from 'svelte/reactivity';

export type FeedSource = { topic: string; label: string };
export type HiddenTopic = { topic: string; externalId: string; title: string };
type Preferences = {
	version: 1;
	order: string[];
	hiddenSources: string[];
	hiddenTopics: HiddenTopic[];
};

const STORAGE_KEY = 'greeklish-feed-preferences';
const empty = (): Preferences => ({ version: 1, order: [], hiddenSources: [], hiddenTopics: [] });
export const topicKey = (topic: string, externalId: string) => JSON.stringify([topic, externalId]);

class FeedPreferences {
	value = $state<Preferences>(empty());
	lastHidden = $state<HiddenTopic | null>(null);
	savingAvailable = $state(true);
	#sources: FeedSource[] = [];
	hiddenKeys = $derived(
		new SvelteSet(this.value.hiddenTopics.map((item) => topicKey(item.topic, item.externalId)))
	);

	initialize(sources: FeedSource[]) {
		this.#sources = sources;
		this.value = this.#normalize(this.value);
		this.#read();
		const onStorage = (event: StorageEvent) => {
			if (event.key === STORAGE_KEY || event.key === null) this.#read();
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	}

	#read() {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			this.value = this.#normalize(stored ? JSON.parse(stored) : empty());
		} catch (error) {
			if (error instanceof SyntaxError) this.value = this.#normalize(empty());
			else this.savingAvailable = false;
		}
	}

	#normalize(raw: unknown): Preferences {
		const defaults = this.#sources.map((source) => source.topic);
		if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1) {
			return { ...empty(), order: defaults };
		}
		const value = raw as Partial<Preferences>;
		const valid = (values: unknown) =>
			Array.isArray(values)
				? values.filter(
						(value): value is string => typeof value === 'string' && defaults.includes(value)
					)
				: [];
		const topics = Array.isArray(value.hiddenTopics)
			? value.hiddenTopics.filter(
					(item): item is HiddenTopic =>
						!!item &&
						typeof item === 'object' &&
						defaults.includes(item.topic) &&
						typeof item.externalId === 'string' &&
						!!item.externalId &&
						typeof item.title === 'string'
				)
			: [];
		return {
			version: 1,
			order: [...new Set([...valid(value.order), ...defaults])],
			hiddenSources: [...new Set(valid(value.hiddenSources))],
			hiddenTopics: [
				...new Map(topics.map((item) => [topicKey(item.topic, item.externalId), item])).values()
			]
		};
	}

	#save(value: Preferences) {
		this.value = this.#normalize(value);
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.value));
			this.savingAvailable = true;
		} catch {
			this.savingAvailable = false;
		}
	}

	ordered(sources: FeedSource[]) {
		const topics = [...new Set([...this.value.order, ...sources.map((source) => source.topic)])];
		return topics.flatMap((topic) => sources.filter((source) => source.topic === topic));
	}

	move(topic: string, target: string) {
		const order = [...this.value.order];
		const from = order.indexOf(topic),
			to = order.indexOf(target);
		if (from < 0 || to < 0 || from === to) return;
		order.splice(from, 1);
		order.splice(to, 0, topic);
		this.#save({ ...this.value, order });
	}

	toggleSource(topic: string) {
		const hidden = this.value.hiddenSources;
		this.#save({
			...this.value,
			hiddenSources: hidden.includes(topic)
				? hidden.filter((value) => value !== topic)
				: [...hidden, topic]
		});
	}

	hide(item: HiddenTopic) {
		if (this.hiddenKeys.has(topicKey(item.topic, item.externalId))) return;
		this.#save({ ...this.value, hiddenTopics: [...this.value.hiddenTopics, item] });
		this.lastHidden = item;
	}

	restore(item: HiddenTopic) {
		const key = topicKey(item.topic, item.externalId);
		this.#save({
			...this.value,
			hiddenTopics: this.value.hiddenTopics.filter(
				(value) => topicKey(value.topic, value.externalId) !== key
			)
		});
		if (this.lastHidden && topicKey(this.lastHidden.topic, this.lastHidden.externalId) === key)
			this.lastHidden = null;
	}

	resetSources() {
		this.#save({
			...this.value,
			order: this.#sources.map((source) => source.topic),
			hiddenSources: []
		});
	}

	restoreAll() {
		this.#save({ ...this.value, hiddenTopics: [] });
		this.lastHidden = null;
	}
}

export const feedPreferences = new FeedPreferences();
