<script lang="ts">
	import { hyphenate } from 'grhyph-js/quickSynizesis.js';
	import { flip } from 'svelte/animate';
	import { cubicIn, cubicInOut, cubicOut } from 'svelte/easing';
	import { onMount, tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { fly } from 'svelte/transition';
	import { Button, Segmented } from '@svar-ui/svelte-core';
	import { type IMenuOption } from '@svar-ui/svelte-menu';
	import { registerMenuItem } from '@svar-ui/svelte-menu';
	import AnimatedNumber from '$lib/AnimatedNumber.svelte';
	import { tooltip } from '$lib/actions/tooltip';
	import { commentsStore } from '$lib/comments-store.svelte';
	import { feedPreferences, topicKey } from '$lib/feed-preferences.svelte';
	import FeedItemActions from '$lib/FeedItemActions.svelte';
	import {
		getCheckpointTimestamps,
		getLatestSnapshotTimestamp,
		getSelectedCheckpointIndex,
		getTimeBounds,
		getTwoDaysAgoTimestamp,
		mergeCrawlSnapshots
	} from '$lib/feed-snapshots';
	import {
		formatAbsoluteDateTime as formatAbsoluteDateTimeValue,
		formatNumber,
		formatRelativeTime as formatRelativeTimeValue
	} from '$lib/format';
	import Icon from '$lib/Icon.svelte';
	import {
		getItemCommentsUrl as buildItemCommentsUrl,
		getItemDiscussionLinks,
		getItemUrl as buildItemUrl
	} from '$lib/item-links';
	import {
		connectTopicFeed,
		LAGONIKA_OFFERS_TOPIC,
		PHORUM_TOPICS_TOPIC,
		X_TRENDS_TOPIC,
		type ConnectionState,
		type CrawlSnapshot,
		type CrawlSnapshotItem,
		type RankingStrategy
	} from '$lib/live-feed';
	import { LocalStorage } from '$lib/storage.svelte';
	import FeedMenuOption from '$lib/FeedMenuOption.svelte';
	import FeedContextMenu from '$lib/FeedContextMenu.svelte';

	registerMenuItem('feed-discussion-option', FeedMenuOption);

	type InitialFeedData = {
		displayName: string;
		strategy: RankingStrategy | null;
		snapshots: CrawlSnapshot[];
		asOf: number;
	};

	type FeedItemBounds = {
		top: number;
		left: number;
		width: number;
		height: number;
	};

	type Props = {
		topic: string;
		defaultTitle: string;
		initialData: InitialFeedData;
		fallbackStrategy?: RankingStrategy | null;
		reduceAnimations: boolean;
		useOldRedditForNsfw: boolean;
		openExternalLinksInNewTabs: boolean;
		hyphenateTitles: boolean;
		hyphenateNonGreekTitles: boolean;
		browserNow: number;
		browserLocale: string;
		browserTimeZone?: string;
		showModeSwitch?: boolean;
		showScore?: boolean;
		showItemTime?: boolean;
		layout?: 'vertical' | 'horizontal';
		initialVisibleCount?: number;
		onConnectionStateChange?: (topic: string, state: ConnectionState | null) => void;
		onOpenComments?: (topic: string, item: CrawlSnapshotItem) => void;
	};

	type FeedMode = 'hot' | 'latest';

	const DEFAULT_INITIAL_VISIBLE_COUNT = 20;
	const CHECKPOINT_REPEAT_MS = 500;
	const SOFT_HYPHEN = '\u00ad';
	const INVISIBLE_LABEL_PLACEHOLDER = '\u00a0';
	const FEED_TRANSITION_DISTANCE = 200;
	const FEED_TRANSITION_DURATION_MS = 400;
	const SNAPSHOT_HISTORY_LOAD_DELAY_MS = 250;
	const HOT_GRAVITY = 1.8;
	const NUMBER_FLOW_TIMING = {
		duration: FEED_TRANSITION_DURATION_MS,
		easing: 'ease-out'
	};
	const FEED_MODE_OPTIONS: { id: FeedMode; label: string; title: string }[] = [
		{ id: 'hot', label: 'hot', title: 'hot θέματα' },
		{ id: 'latest', label: 'νέα', title: 'νεότερες απαντήσεις' }
	];
	const isFeedMode = (value: unknown): value is FeedMode => value === 'hot' || value === 'latest';

	let {
		topic,
		defaultTitle,
		initialData,
		fallbackStrategy = null,
		reduceAnimations,
		useOldRedditForNsfw,
		openExternalLinksInNewTabs,
		hyphenateTitles,
		hyphenateNonGreekTitles,
		browserNow,
		browserLocale,
		browserTimeZone,
		showModeSwitch = false,
		showScore = true,
		showItemTime = true,
		layout = 'vertical',
		initialVisibleCount = DEFAULT_INITIAL_VISIBLE_COUNT,
		onConnectionStateChange,
		onOpenComments
	}: Props = $props();

	const initialTopic = untrack(() => topic);
	const initialDefaultTitle = untrack(() => defaultTitle);
	const initialFeedData = untrack(() => initialData);
	const initialFallbackStrategy = untrack(() => fallbackStrategy);
	const panelInitialVisibleCount = untrack(() => initialVisibleCount);
	const initialSnapshots = mergeCrawlSnapshots([], initialFeedData.snapshots);
	const panelId = `feed-${initialTopic}`;
	const feedModeStorage = new LocalStorage<FeedMode>(
		`${initialTopic}-feed-mode`,
		'hot',
		isFeedMode
	);

	let rootElement: HTMLElement;
	let crawlSnapshots = $state<CrawlSnapshot[]>(initialSnapshots);
	let topicTitle = $state(getTopicTitle(initialFeedData.displayName || initialDefaultTitle));
	let strategy = $state<RankingStrategy | null>(
		initialFeedData.strategy ?? initialFallbackStrategy
	);
	let snapshotAsOf = $state<number | null>(initialFeedData.asOf);
	let snapshotHistoryLoaded = $state(false);
	let visibleCount = $state(panelInitialVisibleCount);
	let feedMode = $state<FeedMode>(feedModeStorage.current);
	let selectedTimestamp = $state(getLatestSnapshotTimestamp(initialSnapshots));
	let checkpointRepeatTimeout: number | null = null;
	let checkpointRepeatInterval: number | null = null;
	let checkpointKeyboardRepeatTimeout: number | null = null;
	let checkpointKeyboardRepeatInterval: number | null = null;
	let checkpointKeyboardRepeatKey: 'ArrowLeft' | 'ArrowRight' | null = null;
	let checkpointKeyboardNavigationActive = false;
	let suppressCheckpointClickTimeout: number | null = null;
	let checkpointRepeatDidRun = false;
	let suppressNextCheckpointClick = false;
	let contextMenu: FeedContextMenu | undefined = $state();
	let menuOptions = $state<IMenuOption[]>([]);
	let feedEnterX = $state(-FEED_TRANSITION_DISTANCE);
	let feedExitX = $state(FEED_TRANSITION_DISTANCE);
	const feedItemBoundsBeforeSelection = new SvelteMap<string, FeedItemBounds>();
	const outgoingFeedOverlays = new SvelteMap<HTMLElement, number>();
	const incomingFeedItemTimeouts = new SvelteMap<HTMLElement, number>();

	let externalLinkTarget = $derived(openExternalLinksInNewTabs ? '_blank' : undefined);
	let externalLinkRel = $derived(openExternalLinksInNewTabs ? 'external noreferrer' : 'external');
	let checkpointTimestamps = $derived(getCheckpointTimestamps(crawlSnapshots));
	let selectedCheckpointIndex = $derived(
		getSelectedCheckpointIndex(checkpointTimestamps, selectedTimestamp)
	);
	let selectedSnapshot = $derived(crawlSnapshots[selectedCheckpointIndex] ?? null);
	let effectiveStrategy = $derived(
		showModeSwitch && feedMode === 'latest' ? null : (strategy ?? fallbackStrategy)
	);
	let displayedItems = $derived(
		selectedSnapshot
			? rankSnapshotItems(
					selectedSnapshot.items,
					selectedSnapshot.crawled_at,
					effectiveStrategy
				).filter(
					(item) =>
						// Older crawl snapshots may contain X's related-trends caption as an item.
						(topic !== X_TRENDS_TOPIC || !/^\s*trending\s+with(?:\s|$)/i.test(item.title)) &&
						!feedPreferences.hiddenKeys.has(topicKey(topic, item.external_id))
				)
			: []
	);
	let visibleItems = $derived(
		layout === 'horizontal' ? displayedItems : displayedItems.slice(0, visibleCount)
	);
	let hasMore = $derived(layout !== 'horizontal' && visibleCount < displayedItems.length);
	let hasLess = $derived(layout !== 'horizontal' && visibleCount > panelInitialVisibleCount);
	let nextVisibleCount = $derived(
		Math.min(displayedItems.length, visibleCount + panelInitialVisibleCount)
	);
	let showMoreLabel = $derived(
		nextVisibleCount >= displayedItems.length ? 'Εμφάνιση όλων' : 'Εμφάνιση περισσότερων'
	);
	let timeBounds = $derived(getTimeBounds(crawlSnapshots));
	let sliderTimeBounds = $derived(
		snapshotHistoryLoaded || !selectedTimestamp
			? timeBounds
			: { min: selectedTimestamp - 60_000, max: selectedTimestamp }
	);
	let canGoPrevious = $derived(snapshotHistoryLoaded && selectedCheckpointIndex > 0);
	let canGoNext = $derived(
		snapshotHistoryLoaded &&
			selectedCheckpointIndex >= 0 &&
			selectedCheckpointIndex < checkpointTimestamps.length - 1
	);
	let selectedTimeLabel = $derived(
		selectedTimestamp ? formatRelativeTime(selectedTimestamp) : INVISIBLE_LABEL_PLACEHOLDER
	);
	let feedTransitionDuration = $derived(reduceAnimations ? 0 : FEED_TRANSITION_DURATION_MS);

	onMount(() => {
		cleanupFeedAnimationArtifacts();

		const handlePointerActivation = (event: PointerEvent) => {
			checkpointKeyboardNavigationActive =
				event.target instanceof Element &&
				rootElement.contains(event.target) &&
				Boolean(event.target.closest('.slider-controls'));

			if (!checkpointKeyboardNavigationActive) {
				stopCheckpointKeyboardRepeat();
			}
		};
		const handleCheckpointKeyDown = (event: KeyboardEvent) => {
			if (
				!checkpointKeyboardNavigationActive ||
				(event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey
			) {
				return;
			}

			event.preventDefault();
			if (!event.repeat) {
				startCheckpointKeyboardRepeat(event.key);
			}
		};
		const handleCheckpointKeyUp = (event: KeyboardEvent) => {
			if (event.key === checkpointKeyboardRepeatKey) {
				stopCheckpointKeyboardRepeat();
			}
		};

		// Badge counts for this topic's items, loaded once per session.
		void commentsStore.loadTopicCounts(topic);

		const disconnect = connectTopicFeed(topic, {
			sinceMs: getTwoDaysAgoTimestamp(),
			requestLatestCrawlSnapshot: true,
			snapshotHistoryLoadStrategy: 'idle',
			snapshotHistoryLoadDelayMs: SNAPSHOT_HISTORY_LOAD_DELAY_MS,
			onState: (state) => {
				setConnectionState(state);
			},
			onSnapshot: (message) => {
				topicTitle = getTopicTitle(message.display_name || defaultTitle);
				strategy = message.strategy;
				snapshotAsOf = message.as_of;
			},
			onCrawlSnapshots: (message) => {
				topicTitle = getTopicTitle(message.display_name || defaultTitle);
				const wasViewingLatest = isViewingLatestSnapshot();
				crawlSnapshots = mergeCrawlSnapshots(crawlSnapshots, message.snapshots);
				moveToLatestSnapshotIfNeeded(wasViewingLatest);
				snapshotHistoryLoaded = true;
			},
			onCrawlSnapshot: (message) => {
				topicTitle = getTopicTitle(message.display_name || defaultTitle);
				const wasViewingLatest = isViewingLatestSnapshot();
				crawlSnapshots = mergeCrawlSnapshots(crawlSnapshots, [message.snapshot]);
				moveToLatestSnapshotIfNeeded(wasViewingLatest);
			},
			onError: (message) => {
				console.log(`[live-feed:${topic}] ${message}`);
			}
		});

		window.addEventListener('pointerdown', handlePointerActivation, true);
		window.addEventListener('keydown', handleCheckpointKeyDown);
		window.addEventListener('keyup', handleCheckpointKeyUp);
		window.addEventListener('blur', stopCheckpointKeyboardRepeat);
		window.addEventListener('pagehide', cleanupFeedAnimationArtifacts);

		return () => {
			stopCheckpointRepeat();
			stopCheckpointKeyboardRepeat();
			cleanupFeedAnimationArtifacts();
			window.removeEventListener('pointerdown', handlePointerActivation, true);
			window.removeEventListener('keydown', handleCheckpointKeyDown);
			window.removeEventListener('keyup', handleCheckpointKeyUp);
			window.removeEventListener('blur', stopCheckpointKeyboardRepeat);
			window.removeEventListener('pagehide', cleanupFeedAnimationArtifacts);
			disconnect();
			onConnectionStateChange?.(initialTopic, null);
		};
	});

	function seeMore() {
		visibleCount = nextVisibleCount;
	}

	function seeLess() {
		visibleCount = panelInitialVisibleCount;
	}

	function setConnectionState(state: ConnectionState) {
		onConnectionStateChange?.(initialTopic, state);
	}

	function changeFeedMode(event: { value: string | number }) {
		if (!isFeedMode(event.value)) {
			return;
		}

		feedMode = event.value;
		feedModeStorage.current = event.value;
	}

	function previousCheckpoint() {
		if (canGoPrevious) {
			setSelectedTimestamp(checkpointTimestamps[selectedCheckpointIndex - 1]);
		}
	}

	function nextCheckpoint() {
		if (canGoNext) {
			setSelectedTimestamp(checkpointTimestamps[selectedCheckpointIndex + 1]);
		}
	}

	function changeSelectedTimestamp(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const checkpointIndex = getSelectedCheckpointIndex(checkpointTimestamps, input.valueAsNumber);
		const checkpointTimestamp = checkpointTimestamps[checkpointIndex];
		if (checkpointTimestamp != null) {
			setSelectedTimestamp(checkpointTimestamp);
		}
	}

	function setSelectedTimestamp(timestamp: number) {
		if (!Number.isFinite(timestamp) || timestamp === selectedTimestamp) {
			return;
		}

		const previousTimestamp = selectedTimestamp;
		const previousIndex = getSelectedCheckpointIndex(checkpointTimestamps, previousTimestamp);
		const nextIndex = getSelectedCheckpointIndex(checkpointTimestamps, timestamp);
		if (previousTimestamp && previousIndex === nextIndex) {
			return;
		}

		if (reduceAnimations) {
			cleanupFeedAnimationArtifacts();
			selectedTimestamp = timestamp;
			return;
		}

		if (selectedTimestamp) {
			const isMovingForward = timestamp > selectedTimestamp;
			feedEnterX = isMovingForward ? -FEED_TRANSITION_DISTANCE : FEED_TRANSITION_DISTANCE;
			feedExitX = -feedEnterX;
		}

		captureFeedItemBoundsBeforeSelection();
		selectedTimestamp = timestamp;
	}

	function flipFeedItem(node: Element, animation: Parameters<typeof flip>[1]) {
		if (reduceAnimations) {
			return { duration: 0 };
		}

		return flip(node, animation, {
			duration: FEED_TRANSITION_DURATION_MS,
			easing: cubicInOut
		});
	}

	function flyFeedItemIn(node: HTMLElement, { x }: { x: number }) {
		if (reduceAnimations) {
			return { duration: 0 };
		}

		return fly(node, {
			x,
			duration: FEED_TRANSITION_DURATION_MS,
			easing: cubicOut
		});
	}

	function flyFeedItemOut(node: HTMLElement, { x }: { x: number }) {
		if (reduceAnimations) {
			return { duration: 0 };
		}

		const row = node.closest('li');
		if (!(row instanceof HTMLElement)) {
			return fly(node, {
				x,
				duration: feedTransitionDuration,
				easing: cubicIn
			});
		}

		const itemId = row.dataset.feedItemId;
		const currentBounds = row.getBoundingClientRect();
		const bounds =
			(itemId && feedItemBoundsBeforeSelection.get(itemId)) || rectToFeedItemBounds(currentBounds);

		const overlay = row.cloneNode(true) as HTMLElement;
		const rowStyles = window.getComputedStyle(row);
		overlay.classList.add('feed-item-outgoing-overlay');
		if (layout === 'horizontal') {
			overlay.classList.add('feed-item-outgoing-overlay-horizontal');
		}
		overlay.dataset.feedPanelId = panelId;
		overlay.removeAttribute('style');
		overlay.setAttribute('aria-hidden', 'true');
		overlay.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
		overlay
			.querySelectorAll<HTMLElement>('a, button, input, select, textarea')
			.forEach((element) => {
				element.tabIndex = -1;
			});
		hydrateClonedAnimatedNumbers(overlay);
		Object.assign(overlay.style, {
			position: 'fixed',
			top: `${bounds.top}px`,
			left: `${bounds.left}px`,
			width: `${bounds.width}px`,
			height: `${bounds.height}px`,
			margin: '0',
			zIndex: '1000',
			pointerEvents: 'none',
			font: rowStyles.font,
			color: rowStyles.color,
			background: 'var(--color-background)'
		});
		document.body.append(overlay);
		registerOutgoingFeedOverlay(overlay);
		row.classList.add('feed-item-outgoing-source');
		window.setTimeout(
			() => row.classList.remove('feed-item-outgoing-source'),
			FEED_TRANSITION_DURATION_MS + 250
		);

		return {
			duration: feedTransitionDuration,
			easing: cubicIn,
			css: () => 'opacity: 0;',
			tick: (t: number, u: number) => {
				overlay.style.opacity = String(t);
				overlay.style.transform = `translateX(${u * x}px)`;

				if (t <= 0.001) {
					cleanupOutgoingFeedOverlay(overlay);
					row.classList.remove('feed-item-outgoing-source');
				}
			}
		};
	}

	function hydrateClonedAnimatedNumbers(overlay: HTMLElement) {
		for (const valueElement of overlay.querySelectorAll<HTMLElement>(
			'.item-meta-value:has(number-flow-svelte)'
		)) {
			const fallbackText = getClonedAnimatedNumberText(valueElement);
			if (!fallbackText) {
				continue;
			}

			valueElement.replaceChildren(document.createTextNode(fallbackText));
		}
	}

	function getClonedAnimatedNumberText(valueElement: HTMLElement) {
		return valueElement.dataset.itemMetaFallback || null;
	}

	function registerOutgoingFeedOverlay(overlay: HTMLElement) {
		const timeoutId = window.setTimeout(
			() => cleanupOutgoingFeedOverlay(overlay),
			FEED_TRANSITION_DURATION_MS + 250
		);
		outgoingFeedOverlays.set(overlay, timeoutId);
	}

	function cleanupOutgoingFeedOverlay(overlay: HTMLElement) {
		const timeoutId = outgoingFeedOverlays.get(overlay);
		if (timeoutId != null) {
			window.clearTimeout(timeoutId);
			outgoingFeedOverlays.delete(overlay);
		}
		overlay.remove();
	}

	function cleanupFeedAnimationArtifacts() {
		for (const overlay of outgoingFeedOverlays.keys()) {
			cleanupOutgoingFeedOverlay(overlay);
		}

		for (const [row, timeoutId] of incomingFeedItemTimeouts) {
			window.clearTimeout(timeoutId);
			row.classList.remove('feed-item-incoming');
		}
		incomingFeedItemTimeouts.clear();

		document
			.querySelectorAll<HTMLElement>(`.feed-item-outgoing-overlay[data-feed-panel-id="${panelId}"]`)
			.forEach((overlay) => overlay.remove());
		rootElement
			?.querySelectorAll<HTMLElement>('.feed-item-incoming')
			.forEach((row) => row.classList.remove('feed-item-incoming'));
		rootElement
			?.querySelectorAll<HTMLElement>('.feed-item-outgoing-source')
			.forEach((row) => row.classList.remove('feed-item-outgoing-source'));
	}

	function captureFeedItemBoundsBeforeSelection() {
		feedItemBoundsBeforeSelection.clear();

		for (const row of rootElement.querySelectorAll<HTMLElement>(
			'.feed-list > li[data-feed-item-id]'
		)) {
			const itemId = row.dataset.feedItemId;
			if (itemId) {
				feedItemBoundsBeforeSelection.set(
					itemId,
					rectToFeedItemBounds(row.getBoundingClientRect())
				);
			}
		}
	}

	function rectToFeedItemBounds(rect: DOMRect): FeedItemBounds {
		return {
			top: rect.top,
			left: rect.left,
			width: rect.width,
			height: rect.height
		};
	}

	function setIncomingFeedItemLayer(event: Event, active: boolean) {
		if (reduceAnimations) {
			return;
		}

		const row = (event.currentTarget as HTMLElement).closest('li');
		if (!(row instanceof HTMLElement)) {
			return;
		}

		const existingTimeoutId = incomingFeedItemTimeouts.get(row);
		if (existingTimeoutId != null) {
			window.clearTimeout(existingTimeoutId);
			incomingFeedItemTimeouts.delete(row);
		}

		row.classList.toggle('feed-item-incoming', active);
		if (active) {
			const timeoutId = window.setTimeout(() => {
				row.classList.remove('feed-item-incoming');
				incomingFeedItemTimeouts.delete(row);
			}, FEED_TRANSITION_DURATION_MS + 250);
			incomingFeedItemTimeouts.set(row, timeoutId);
		}
	}

	function clickPreviousCheckpoint(event: MouseEvent) {
		if (shouldIgnoreCheckpointClick(event)) {
			return;
		}

		if (consumeCheckpointRepeatClick()) {
			return;
		}

		previousCheckpoint();
	}

	function clickNextCheckpoint(event: MouseEvent) {
		if (shouldIgnoreCheckpointClick(event)) {
			return;
		}

		if (consumeCheckpointRepeatClick()) {
			return;
		}

		nextCheckpoint();
	}

	function startCheckpointRepeat(
		direction: 'previous' | 'next',
		event: PointerEvent,
		disabled: boolean
	) {
		if (disabled || !event.isPrimary || event.button !== 0) {
			suppressNextCheckpointButtonClick();
			return;
		}

		stopCheckpointRepeat();
		checkpointRepeatDidRun = false;
		(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
		runCheckpointRepeat(direction);

		checkpointRepeatTimeout = window.setTimeout(() => {
			runCheckpointRepeat(direction);
			checkpointRepeatInterval = window.setInterval(() => {
				runCheckpointRepeat(direction);
			}, CHECKPOINT_REPEAT_MS);
		}, CHECKPOINT_REPEAT_MS);
	}

	function shouldIgnoreCheckpointClick(event: MouseEvent) {
		if (suppressNextCheckpointClick || event.button !== 0) {
			suppressNextCheckpointClick = false;
			clearSuppressCheckpointClickTimeout();
			event.preventDefault();
			event.stopPropagation();
			return true;
		}

		return false;
	}

	function suppressCheckpointButtonEvent(event: MouseEvent | PointerEvent) {
		suppressNextCheckpointButtonClick();
		event.preventDefault();
		event.stopPropagation();
	}

	function suppressNextCheckpointButtonClick() {
		suppressNextCheckpointClick = true;
		clearSuppressCheckpointClickTimeout();
		suppressCheckpointClickTimeout = window.setTimeout(() => {
			suppressNextCheckpointClick = false;
			suppressCheckpointClickTimeout = null;
		}, 500);
	}

	function clearSuppressCheckpointClickTimeout() {
		if (suppressCheckpointClickTimeout) {
			window.clearTimeout(suppressCheckpointClickTimeout);
			suppressCheckpointClickTimeout = null;
		}
	}

	function runCheckpointRepeat(direction: 'previous' | 'next') {
		checkpointRepeatDidRun = true;

		if (direction === 'previous') {
			previousCheckpoint();
			return;
		}

		nextCheckpoint();
	}

	function startCheckpointKeyboardRepeat(key: 'ArrowLeft' | 'ArrowRight') {
		stopCheckpointKeyboardRepeat();
		checkpointKeyboardRepeatKey = key;
		runCheckpointKeyboardNavigation(key);

		checkpointKeyboardRepeatTimeout = window.setTimeout(() => {
			runCheckpointKeyboardNavigation(key);
			checkpointKeyboardRepeatInterval = window.setInterval(() => {
				runCheckpointKeyboardNavigation(key);
			}, CHECKPOINT_REPEAT_MS);
		}, CHECKPOINT_REPEAT_MS);
	}

	function runCheckpointKeyboardNavigation(key: 'ArrowLeft' | 'ArrowRight') {
		if (key === 'ArrowLeft') {
			previousCheckpoint();
			return;
		}

		nextCheckpoint();
	}

	function stopCheckpointKeyboardRepeat() {
		if (checkpointKeyboardRepeatTimeout) {
			window.clearTimeout(checkpointKeyboardRepeatTimeout);
			checkpointKeyboardRepeatTimeout = null;
		}

		if (checkpointKeyboardRepeatInterval) {
			window.clearInterval(checkpointKeyboardRepeatInterval);
			checkpointKeyboardRepeatInterval = null;
		}

		checkpointKeyboardRepeatKey = null;
	}

	function stopCheckpointRepeat() {
		if (checkpointRepeatTimeout) {
			window.clearTimeout(checkpointRepeatTimeout);
			checkpointRepeatTimeout = null;
		}

		if (checkpointRepeatInterval) {
			window.clearInterval(checkpointRepeatInterval);
			checkpointRepeatInterval = null;
		}
	}

	function finishCheckpointRepeat(direction: 'previous' | 'next', event: PointerEvent) {
		(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
		stopCheckpointRepeat();
	}

	function consumeCheckpointRepeatClick() {
		if (!checkpointRepeatDidRun) {
			return false;
		}

		checkpointRepeatDidRun = false;
		return true;
	}

	function moveToLatestSnapshotIfNeeded(wasViewingLatest = false) {
		if (!crawlSnapshots.length) {
			return;
		}

		const latestTimestamp = Date.parse(crawlSnapshots[crawlSnapshots.length - 1].crawled_at);
		if (Number.isFinite(latestTimestamp) && (!selectedTimestamp || wasViewingLatest)) {
			setSelectedTimestamp(latestTimestamp);
		}
	}

	function isViewingLatestSnapshot() {
		return !crawlSnapshots.length || selectedCheckpointIndex === crawlSnapshots.length - 1;
	}

	function rankSnapshotItems(
		items: CrawlSnapshotItem[],
		crawledAt: string,
		rankingStrategy: RankingStrategy | null
	) {
		if (topic === LAGONIKA_OFFERS_TOPIC && showModeSwitch && feedMode === 'latest') {
			return [...items]
				.sort((left, right) => {
					const leftRank = getNumberMetadata(left, 'commented_rank');
					const rightRank = getNumberMetadata(right, 'commented_rank');

					if (leftRank != null && rightRank != null) {
						return (
							leftRank - rightRank ||
							Date.parse(right.published_at) - Date.parse(left.published_at) ||
							right.score - left.score
						);
					}

					if (leftRank != null) return -1;
					if (rightRank != null) return 1;

					return right.rank_position - left.rank_position;
				})
				.map((item, index) => ({ ...item, rank_position: index + 1 }));
		}

		if (showModeSwitch && feedMode === 'latest') {
			return [...items]
				.sort((left, right) => {
					return (
						Date.parse(getItemDisplayTimestamp(right)) -
							Date.parse(getItemDisplayTimestamp(left)) || right.rank_position - left.rank_position
					);
				})
				.map((item, index) => ({ ...item, rank_position: index + 1 }));
		}

		if (rankingStrategy !== 'hot') {
			return items;
		}

		const now = Date.parse(crawledAt);
		if (!Number.isFinite(now)) {
			return items;
		}

		return [...items]
			.sort((left, right) => {
				const rightScore = getHotScore(right, now);
				const leftScore = getHotScore(left, now);

				return (
					rightScore - leftScore ||
					Date.parse(right.published_at) - Date.parse(left.published_at) ||
					right.score - left.score
				);
			})
			.map((item, index) => ({ ...item, rank_position: index + 1 }));
	}

	function getHotScore(item: CrawlSnapshotItem, now: number) {
		const publishedAt = Date.parse(item.published_at);
		const ageHours =
			Number.isFinite(publishedAt) && now > publishedAt ? (now - publishedAt) / 3_600_000 : 0;

		return item.score / Math.pow(ageHours + 2, HOT_GRAVITY);
	}

	function getItemRankingValue(item: CrawlSnapshotItem) {
		if (effectiveStrategy !== 'hot' || !selectedSnapshot) {
			return item.score;
		}

		const crawledAt = Date.parse(selectedSnapshot.crawled_at);
		if (!Number.isFinite(crawledAt)) {
			return item.score;
		}

		return roundRankingValue(getHotScore(item, crawledAt));
	}

	function roundRankingValue(value: number) {
		if (value >= 100) return Math.round(value);
		if (value >= 10) return Math.round(value * 10) / 10;
		return Math.round(value * 100) / 100;
	}

	function getRankingTitle(item: CrawlSnapshotItem) {
		const value = getItemRankingValue(item);

		if (effectiveStrategy === 'hot') {
			return `hot score: ${formatNumber(value, browserLocale)}`;
		}

		return `Βαθμολογία: ${formatNumber(value, browserLocale)}`;
	}

	function getDiscussionMenuOptions(item: CrawlSnapshotItem): IMenuOption[] {
		return getItemDiscussionLinks(item, useOldRedditForNsfw).map(({ id, text, url }) => ({
			id,
			text,
			icon: openExternalLinksInNewTabs ? 'open-16-regular' : undefined,
			comp: 'feed-discussion-option',
			handler: () => openDiscussionUrl(url)
		}));
	}

	function showDiscussionMenu(event: MouseEvent, item: CrawlSnapshotItem) {
		// Preserve native open-in-new-tab/window gestures on the source-comments link.
		if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
			return;
		const options = getDiscussionMenuOptions(item);
		// The early return is load-bearing: `getItemDiscussionLinks` is empty for x-trends and
		// lagonika-offers, where this anchor must keep navigating to the external URL.
		if (!options.length || !contextMenu) return;

		// The menu owns preventDefault. Source-comment options never open the local discussion.
		menuOptions = options;
		void contextMenu.show(event);
	}

	function showItemActions(event: MouseEvent, item: CrawlSnapshotItem) {
		menuOptions = [
			{
				id: 'hide-topic',
				text: 'Απόκρυψη θέματος',
				comp: 'feed-discussion-option',
				handler: async () => {
					feedPreferences.hide({ topic, externalId: item.external_id, title: item.title });
					await tick();
					document
						.querySelector<HTMLButtonElement>('.feed-undo .undo-action')
						?.focus({ preventScroll: true });
				}
			}
		];
		void contextMenu?.show(event);
	}

	function openDiscussionUrl(url: string) {
		if (openExternalLinksInNewTabs) {
			window.open(url, '_blank', 'noopener,noreferrer');
			return;
		}

		window.location.assign(url);
	}

	function getItemDisplayTimestamp(item: CrawlSnapshotItem) {
		if (topic === PHORUM_TOPICS_TOPIC && showModeSwitch && feedMode === 'latest') {
			return getItemLastActivityAt(item) || item.published_at;
		}

		return item.published_at;
	}

	function getItemLastActivityAt(item: CrawlSnapshotItem) {
		if (!item.metadata || typeof item.metadata !== 'object') {
			return null;
		}

		const value = (item.metadata as Record<string, unknown>).last_activity_at;
		return typeof value === 'string' && value ? value : null;
	}

	function getNumberMetadata(item: CrawlSnapshotItem, key: string) {
		if (!item.metadata || typeof item.metadata !== 'object') {
			return null;
		}

		const value = (item.metadata as Record<string, unknown>)[key];
		return typeof value === 'number' && Number.isFinite(value) ? value : null;
	}

	function getStringMetadata(item: CrawlSnapshotItem, key: string) {
		if (!item.metadata || typeof item.metadata !== 'object') {
			return null;
		}

		const value = (item.metadata as Record<string, unknown>)[key];
		return typeof value === 'string' && value.trim() ? value.trim() : null;
	}

	function getBooleanMetadata(item: CrawlSnapshotItem, key: string) {
		if (!item.metadata || typeof item.metadata !== 'object') {
			return false;
		}

		return (item.metadata as Record<string, unknown>)[key] === true;
	}

	function isExpiredOffer(item: CrawlSnapshotItem) {
		return topic === LAGONIKA_OFFERS_TOPIC && getBooleanMetadata(item, 'expired');
	}

	function getOfferStoreName(item: CrawlSnapshotItem) {
		return topic === LAGONIKA_OFFERS_TOPIC
			? getStringMetadata(item, 'store_name')?.toLocaleLowerCase(browserLocale) || null
			: null;
	}

	function getOfferValueLabel(item: CrawlSnapshotItem) {
		if (topic !== LAGONIKA_OFFERS_TOPIC || /[€%]/u.test(item.title)) {
			return null;
		}

		const price = getNumberMetadata(item, 'price');
		if (!price) {
			return null;
		}

		const priceType = getStringMetadata(item, 'price_type');
		if (priceType === 'pososto') {
			return `${formatNumber(price, browserLocale)}%`;
		}

		return `${formatNumber(price, browserLocale)} €`;
	}

	function getTopicTitle(value: string) {
		if (topic === 'insomnia-topics' && value === 'Insomnia') {
			return 'insomnia';
		}

		return value;
	}

	function formatRelativeTime(value: string | number) {
		return formatRelativeTimeValue(value, browserNow);
	}

	function getItemUrl(item: CrawlSnapshotItem) {
		return buildItemUrl(item, useOldRedditForNsfw);
	}

	function getItemCommentsUrl(item: CrawlSnapshotItem) {
		return buildItemCommentsUrl(item, useOldRedditForNsfw);
	}

	function formatAbsoluteDateTime(value: string | number) {
		return formatAbsoluteDateTimeValue(value, browserLocale, browserTimeZone);
	}

	function formatCommentsCount(value: number) {
		return formatNumber(value, browserLocale);
	}

	function getItemTitleLinkLabel(item: CrawlSnapshotItem) {
		return `${getOpenThreadLabel()}: ${item.title}`;
	}

	function getItemCommentsLinkLabel(item: CrawlSnapshotItem) {
		const commentsCount =
			item.comments_count == null ? '0' : formatCommentsCount(item.comments_count);

		return `Σχόλια στο ${topicTitle}: ${item.title}. ${commentsCount} σχόλια`;
	}

	function getGuestCommentsLabel(item: CrawlSnapshotItem) {
		const count = commentsStore.countFor(topic, item.external_id);
		const suffix = count === 1 ? '1 σχόλιο' : `${count} σχόλια`;

		return `Συζήτηση στο Greeklish.gr: ${item.title}. ${suffix}`;
	}

	function getOpenThreadLabel() {
		return openExternalLinksInNewTabs
			? `Άνοιγμα στο ${topicTitle} σε νέα καρτέλα`
			: `Άνοιγμα στο ${topicTitle}`;
	}

	function hyphenateTitle(title: string) {
		if (!hyphenateTitles) {
			return title.replaceAll(SOFT_HYPHEN, '');
		}

		return title
			.split(/(\s+)/u)
			.map((part) => {
				if (/\s/u.test(part)) return part;
				if (!hyphenateNonGreekTitles && !/\p{Script=Greek}/u.test(part)) {
					return part.replaceAll(SOFT_HYPHEN, '');
				}

				return hyphenate(part, { quickSynizesis: true, separator: SOFT_HYPHEN });
			})
			.join('');
	}
</script>

<section
	id={panelId}
	class="feed-panel"
	class:feed-panel-horizontal={layout === 'horizontal'}
	bind:this={rootElement}
	data-topic={topic}
	aria-labelledby={`${panelId}-title`}
	tabindex="-1"
>
	<header class="page-header">
		<div class="header-main">
			<div class="title-row" class:title-row-no-mode={!showModeSwitch}>
				<div class="feed-title-group">
					<h2 id={`${panelId}-title`} class="feed-title">{topicTitle}</h2>
				</div>

				{#if showModeSwitch}
					<Segmented
						css="feed-mode-segmented"
						options={FEED_MODE_OPTIONS}
						value={feedMode}
						onchange={changeFeedMode}
					/>
				{/if}

				<div
					class="slider-controls"
					class:slider-controls-hidden={!crawlSnapshots.length}
					aria-busy={!snapshotHistoryLoaded}
				>
					<span
						class="repeat-button"
						role="presentation"
						onpointerdown={(event) => startCheckpointRepeat('previous', event, !canGoPrevious)}
						onpointerup={(event) => finishCheckpointRepeat('previous', event)}
						onpointercancel={stopCheckpointRepeat}
						onpointerleave={stopCheckpointRepeat}
						onauxclick={suppressCheckpointButtonEvent}
					>
						<Button
							type="link"
							title="Προηγούμενο checkpoint"
							disabled={!canGoPrevious}
							onclick={clickPreviousCheckpoint}
						>
							<Icon name="chevron-left" size={20} label="Προηγούμενο checkpoint" />
						</Button>
					</span>

					<div class="slider-stack">
						<label
							class="checkpoint-slider-label"
							for={`${panelId}-checkpoint-slider`}
							title={selectedTimestamp ? formatAbsoluteDateTime(selectedTimestamp) : undefined}
						>
							{selectedTimeLabel}
						</label>
						<input
							id={`${panelId}-checkpoint-slider`}
							class="checkpoint-slider"
							type="range"
							min={sliderTimeBounds.min}
							max={sliderTimeBounds.max}
							step={60000}
							value={selectedTimestamp}
							oninput={changeSelectedTimestamp}
							disabled={!snapshotHistoryLoaded || !crawlSnapshots.length}
							aria-label={`Ιστορικό ενημερώσεων: ${topicTitle}`}
						/>
					</div>

					<span
						class="repeat-button"
						role="presentation"
						onpointerdown={(event) => startCheckpointRepeat('next', event, !canGoNext)}
						onpointerup={(event) => finishCheckpointRepeat('next', event)}
						onpointercancel={stopCheckpointRepeat}
						onpointerleave={stopCheckpointRepeat}
						onauxclick={suppressCheckpointButtonEvent}
					>
						<Button
							type="link"
							title="Επόμενο checkpoint"
							disabled={!canGoNext}
							onclick={clickNextCheckpoint}
						>
							<Icon name="chevron-right" size={20} label="Επόμενο checkpoint" />
						</Button>
					</span>
				</div>
			</div>
		</div>
	</header>

	<section class="timeline" aria-label={`${topicTitle} published time checkpoints`}>
		<div class="feed-meta" aria-label={`${topicTitle} feed status`}>
			<span>{displayedItems.length} records</span>
			<span>{crawlSnapshots.length} crawl snapshots</span>
			{#if effectiveStrategy}<span>{effectiveStrategy}</span>{/if}
			{#if selectedSnapshot}
				<span title={formatAbsoluteDateTime(selectedSnapshot.crawled_at)}
					>Crawled {formatRelativeTime(selectedSnapshot.crawled_at)}</span
				>
			{/if}
			{#if snapshotAsOf}
				<span title={formatAbsoluteDateTime(snapshotAsOf)}
					>Updated {formatRelativeTime(snapshotAsOf)}</span
				>
			{/if}
		</div>
	</section>

	<FeedContextMenu bind:this={contextMenu} id={`${panelId}-context-menu`} options={menuOptions} />

	{#snippet feedItemContent(item: CrawlSnapshotItem)}
		<button
			class="item-guest-comments"
			type="button"
			data-menu-ignore="true"
			aria-controls="comments-rail"
			aria-expanded={commentsStore.isOpenFor(topic, item.external_id)}
			aria-label={getGuestCommentsLabel(item)}
			title={getGuestCommentsLabel(item)}
			onclick={() => {
				if (commentsStore.isOpenFor(topic, item.external_id)) commentsStore.close();
				else onOpenComments?.(topic, item);
			}}
		>
			<Icon name="chat-bubble" class="item-meta-icon" size={16} />
			<span class="item-meta-value"
				>{formatNumber(commentsStore.countFor(topic, item.external_id), browserLocale)}</span
			>
		</button>
		<span class="item-content">
			{#if showItemTime || (showScore && effectiveStrategy !== 'hot') || item.comments_count != null}
				<span class="item-meta">
					<span class="item-meta-main-link">
						{#if showItemTime}
							<span
								class="item-meta-cell item-meta-time"
								title={formatAbsoluteDateTime(getItemDisplayTimestamp(item))}
							>
								<Icon name="clock-16-regular" class="item-meta-icon" size={16} />
								<span class="item-meta-value" data-item-meta-value="time"
									>{formatRelativeTime(getItemDisplayTimestamp(item))}</span
								>
							</span>
						{/if}
						{#if showScore && effectiveStrategy !== 'hot'}
							<span class="item-meta-cell item-meta-score" title={getRankingTitle(item)}>
								<Icon name="thumb-like-dislike-16-regular" class="item-meta-icon" size={16} />
								<AnimatedNumber
									value={getItemRankingValue(item)}
									locale={browserLocale}
									animated={!reduceAnimations}
									timing={NUMBER_FLOW_TIMING}
									dataName="score"
									fallbackText={formatNumber(getItemRankingValue(item), browserLocale)}
								/>
							</span>
						{/if}
					</span>

					{#if item.comments_count != null}
						<!-- eslint-disable svelte/no-navigation-without-resolve -- External source URL, including source-specific comment links. -->
						<a
							class="item-meta-cell item-meta-comments item-meta-link"
							href={getItemCommentsUrl(item)}
							target={externalLinkTarget}
							rel={externalLinkRel}
							aria-label={getItemCommentsLinkLabel(item)}
							aria-haspopup={getItemDiscussionLinks(item, useOldRedditForNsfw).length
								? 'menu'
								: undefined}
							use:tooltip={{ content: `Σχόλια στο ${topicTitle}` }}
							onclick={(event) => showDiscussionMenu(event, item)}
						>
							<Icon name="comment-16-regular" class="item-meta-icon" size={16} />
							<AnimatedNumber
								value={item.comments_count}
								locale={browserLocale}
								animated={!reduceAnimations}
								timing={NUMBER_FLOW_TIMING}
								dataName="comments"
								fallbackText={formatCommentsCount(item.comments_count)}
							/>
							<Icon name="open-16-regular" class="source-comments-icon" size={12} />
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					{/if}
				</span>
			{/if}
			<!-- eslint-disable svelte/no-navigation-without-resolve -- External article URL; preserve native navigation and modifier keys. -->
			<a
				class="item-title-link"
				href={getItemUrl(item)}
				target={externalLinkTarget}
				rel={externalLinkRel}
				aria-label={getItemTitleLinkLabel(item)}
			>
				<span class="item-text">
					{#if item.nsfw}
						<span class="item-tag item-tag-nsfw italic">nsfw</span>
					{/if}
					{#if getOfferStoreName(item)}<span class="item-tag item-tag-offer"
							>{getOfferStoreName(item)}</span
						>{/if}{#if getOfferValueLabel(item)}<span class="item-tag item-tag-offer"
							>{getOfferValueLabel(item)}</span
						>{/if}<span class="item-title">{hyphenateTitle(item.title)}</span>
				</span>
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</span>
		<FeedItemActions title={item.title} onopen={(event) => showItemActions(event, item)} />
	{/snippet}

	{#if displayedItems.length}
		{#if reduceAnimations}
			<ul
				class="feed-list"
				class:feed-list-complete={!hasMore}
				class:feed-list-horizontal={layout === 'horizontal'}
			>
				{#each visibleItems as item (item.external_id)}
					<li
						data-feed-item-id={item.external_id}
						class:item-expired={isExpiredOffer(item)}
						class:item-comments-selected={commentsStore.isOpenFor(topic, item.external_id)}
					>
						<span class="item-main">
							{@render feedItemContent(item)}
						</span>
					</li>
				{/each}
			</ul>
		{:else}
			<ul
				class="feed-list"
				class:feed-list-complete={!hasMore}
				class:feed-list-horizontal={layout === 'horizontal'}
			>
				{#each visibleItems as item (item.external_id)}
					<li
						data-feed-item-id={item.external_id}
						class:item-expired={isExpiredOffer(item)}
						class:item-comments-selected={commentsStore.isOpenFor(topic, item.external_id)}
						animate:flipFeedItem
						onintrostart={(event) => setIncomingFeedItemLayer(event, true)}
						onintroend={(event) => setIncomingFeedItemLayer(event, false)}
						in:flyFeedItemIn={{ x: feedEnterX }}
						out:flyFeedItemOut={{ x: feedExitX }}
					>
						<span class="item-main">
							{@render feedItemContent(item)}
						</span>
					</li>
				{/each}
			</ul>
		{/if}

		{#if hasMore || hasLess}
			<div class="list-actions">
				{#if hasLess}
					<Button type="link" onclick={seeLess}>Εμφάνιση λιγότερων</Button>
				{/if}
				{#if hasMore}
					<Button type="link" onclick={seeMore}>{showMoreLabel}</Button>
				{/if}
			</div>
		{/if}
	{:else}
		<p class="empty-state">
			{selectedSnapshot?.items.length
				? 'Όλα τα θέματα αυτής της πηγής έχουν κρυφτεί. Μπορείς να τα επαναφέρεις από τις Ρυθμίσεις.'
				: 'Γίνεται φόρτωση…'}
		</p>
	{/if}
</section>
