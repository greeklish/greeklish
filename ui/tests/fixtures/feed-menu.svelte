<script lang="ts">
	import { setContext } from 'svelte';
	import FeedPanel from '$lib/FeedPanel.svelte';
	import CommentsRail from '$lib/CommentsRail.svelte';
	import { commentsStore } from '$lib/comments-store.svelte';
	import type { CrawlSnapshotItem } from '$lib/live-feed';
	import '../../src/routes/layout.css';

	setContext('wx-theme', 'willow');
	const now = Date.now();
	const timestamp = new Date(now).toISOString();
	const reduceAnimations = !new URLSearchParams(location.search).has('motion');
	const horizontal = new URLSearchParams(location.search).has('horizontal');
	const items: CrawlSnapshotItem[] = Array.from({ length: horizontal ? 3 : 20 }, (_, index) => ({
		external_id: `fixture-${index}`,
		title:
			index === 0
				? 'Short title'
				: horizontal
					? 'Μια δημοφιλής συζήτηση για την Ελλάδα και την καθημερινότητα'
					: `Article ${index}: ${'A deliberately long discussion title that wraps over several lines. '.repeat(4)}`,
		url: horizontal
			? `https://x.com/search?q=fixture${index}`
			: `https://www.reddit.com/r/greece/comments/fixture${index}/discussion/`,
		score: 20 - index,
		comments_count: horizontal ? null : 12,
		rank_position: index + 1,
		published_at: timestamp,
		crawled_at: timestamp
	}));

	function openComments(topic: string, item: CrawlSnapshotItem) {
		commentsStore.openThread({
			topic,
			externalId: item.external_id,
			title: item.title,
			topicDisplayName: 'Fixture feed',
			url: item.url
		});
	}
</script>

<div class="wx-theme wx-willow-theme app-theme">
	<div class="app-layout">
		<div class="app-main">
			<main style:padding-block="100vh">
				<FeedPanel
					topic={horizontal ? 'x-trends' : 'r-greece-rising'}
					defaultTitle="Fixture feed"
					layout={horizontal ? 'horizontal' : 'vertical'}
					showScore={!horizontal}
					showItemTime={!horizontal}
					initialData={{
						displayName: 'Fixture feed',
						strategy: 'external',
						snapshots: [{ id: 'fixture', crawled_at: timestamp, items }],
						asOf: now
					}}
					{reduceAnimations}
					useOldRedditForNsfw={false}
					openExternalLinksInNewTabs={true}
					hyphenateTitles={false}
					hyphenateNonGreekTitles={false}
					browserNow={now}
					browserLocale="en-US"
					onOpenComments={openComments}
				/>
			</main>
		</div>
		<CommentsRail
			{reduceAnimations}
			locale="en-US"
			externalLinkTarget="_blank"
			externalLinkRel="external noreferrer"
		/>
	</div>
</div>
