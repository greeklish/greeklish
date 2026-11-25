import type { CrawlSnapshot } from '$lib/live-feed';

export function mergeCrawlSnapshots(existing: CrawlSnapshot[], incoming: CrawlSnapshot[]) {
	const byId = new Map(existing.map((snapshot) => [snapshot.id, snapshot]));

	for (const snapshot of incoming) {
		byId.set(snapshot.id, snapshot);
	}

	return [...byId.values()].sort((left, right) => {
		const leftTime = Date.parse(left.crawled_at);
		const rightTime = Date.parse(right.crawled_at);
		return leftTime - rightTime || left.id.localeCompare(right.id);
	});
}

export function getTimeBounds(snapshots: CrawlSnapshot[]) {
	const timestamps = getCheckpointTimestamps(snapshots);

	if (!timestamps.length) {
		const now = Date.now();
		return { min: now, max: now + 1 };
	}

	const min = Math.min(...timestamps);
	const max = Math.max(...timestamps);

	return min === max ? { min, max: min + 1 } : { min, max };
}

export function getCheckpointTimestamps(snapshots: CrawlSnapshot[]) {
	return snapshots
		.map((snapshot) => Date.parse(snapshot.crawled_at))
		.filter((value) => Number.isFinite(value));
}

export function getLatestSnapshotTimestamp(snapshots: CrawlSnapshot[]) {
	if (!snapshots.length) {
		return 0;
	}

	const timestamp = Date.parse(snapshots[snapshots.length - 1].crawled_at);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

export function getSelectedCheckpointIndex(timestamps: number[], selected: number) {
	if (!timestamps.length) {
		return -1;
	}

	let nearestIndex = 0;
	let nearestDistance = Math.abs(timestamps[0] - selected);

	for (let i = 1; i < timestamps.length; i += 1) {
		const distance = Math.abs(timestamps[i] - selected);
		if (distance < nearestDistance) {
			nearestIndex = i;
			nearestDistance = distance;
		}
	}

	return nearestIndex;
}

export function getTwoDaysAgoTimestamp(now = Date.now()) {
	return now - 2 * 24 * 60 * 60 * 1_000;
}
