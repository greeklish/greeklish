<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { MediaQuery, SvelteMap, SvelteURL } from 'svelte/reactivity';
	import { Segmented, Switch } from '@svar-ui/svelte-core';
	import { setMode, userPrefersMode } from '$lib/theme.svelte';
	import AppModalArea from '$lib/AppModalArea.svelte';
	import CommentsRail from '$lib/CommentsRail.svelte';
	import FeedPanel from '$lib/FeedPanel.svelte';
	import ModeratorGate from '$lib/ModeratorGate.svelte';
	import Icon from '$lib/Icon.svelte';
	import SourceNavigation from '$lib/SourceNavigation.svelte';
	import FeedPreferences from '$lib/FeedPreferences.svelte';
	import FeedUndo from '$lib/FeedUndo.svelte';
	import FeedSuggestionForm from '$lib/FeedSuggestionForm.svelte';
	import { feedSuggestions } from '$lib/feed-suggestions.svelte';
	import { request, CommentsApiError } from '$lib/comments-api';
	import NotificationSettings from '$lib/NotificationSettings.svelte';
	import { replyNotifications } from '$lib/reply-notifications.svelte';
	import { commentHash, commentHashMatches, parseCommentHash } from '$lib/comment-links';
	import { feedPreferences } from '$lib/feed-preferences.svelte';
	import {
		ADSLGR_TOPICS_TOPIC,
		FEED_INITIAL_VISIBLE_COUNTS,
		GREECE_RISING_TOPIC,
		INSOMNIA_TOPICS_TOPIC,
		LAGONIKA_OFFERS_TOPIC,
		MYPHONE_TOPICS_TOPIC,
		PHORUM_TOPICS_TOPIC,
		X_TRENDS_TOPIC,
		type ConnectionState,
		type ConnectionStatsMessage,
		type CrawlSnapshot,
		type CrawlSnapshotItem,
		type RankingStrategy
	} from '$lib/live-feed';
	import { commentsStore, type OpenThread } from '$lib/comments-store.svelte';
	import { LocalStorage } from '$lib/storage.svelte';

	type ThemePreference = 'system' | 'light' | 'dark';
	type InitialFeedData = {
		displayName: string;
		strategy: RankingStrategy | null;
		snapshots: CrawlSnapshot[];
		asOf: number;
	};
	type ConnectionStatusDisplay = 'pending' | 'open' | 'problem';
	type FeedPanelConfig = {
		topic: string;
		defaultTitle: string;
		initialData: InitialFeedData;
		fallbackStrategy: RankingStrategy | null;
		showModeSwitch?: boolean;
		showScore?: boolean;
		showItemTime?: boolean;
		layout?: 'vertical' | 'horizontal';
		initialVisibleCount: number;
	};

	const DEFAULT_LOCALE = 'el-GR';
	const SITE_URL = 'https://greeklish.gr/';
	const PAGE_TITLE = 'Greeklish.gr — Δημοφιλή θέματα από ελληνικές κοινότητες';
	const PAGE_DESCRIPTION =
		'Δείτε τι συζητούν οι ελληνικές online κοινότητες: δημοφιλή θέματα, τεχνολογία, επικαιρότητα και προσφορές, με συνεχή ενημέρωση στο Greeklish.gr.';
	const WEBSITE_STRUCTURED_DATA = `<script type="application/ld+json">${JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'WebSite',
		name: 'Greeklish.gr',
		url: SITE_URL,
		description: PAGE_DESCRIPTION,
		inLanguage: 'el'
	})}\u003c/script>`;
	const CONNECTION_PROBLEM_DELAY_MS = 4000;
	const THEME_OPTIONS: { id: ThemePreference; label: string }[] = [
		{ id: 'system', label: 'Συστήματος' },
		{ id: 'light', label: 'Φωτεινό' },
		{ id: 'dark', label: 'Σκούρο' }
	];
	const SETTINGS_HASH = 'ρυθμίσεις';
	const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
	const reduceAnimationsStorage = new LocalStorage('reduce-animations-switch', false, isBoolean);
	const oldRedditNsfwStorage = new LocalStorage('old-reddit-nsfw-switch', true, isBoolean);
	const externalLinksInNewTabsStorage = new LocalStorage(
		'external-links-new-tabs-switch',
		true,
		isBoolean
	);
	const titleHyphenationStorage = new LocalStorage('title-hyphenation-switch', true, isBoolean);
	const nonGreekTitleHyphenationStorage = new LocalStorage(
		'non-greek-title-hyphenation-switch',
		false,
		isBoolean
	);

	let { data } = $props();
	const initialData = untrack(() => data);
	const greekFeedInitial = getInitialFeed(GREECE_RISING_TOPIC, 'r/greece', 'external');
	const xTrendsInitial = getInitialFeed(X_TRENDS_TOPIC, 'twitter/x', 'external');
	const insomniaFeedInitial = getInitialFeed(INSOMNIA_TOPICS_TOPIC, 'insomnia', 'hot');
	const myphoneFeedInitial = getInitialFeed(MYPHONE_TOPICS_TOPIC, 'myphone', 'hot');
	const phorumFeedInitial = getInitialFeed(PHORUM_TOPICS_TOPIC, 'phorum', 'hot');
	const adslgrFeedInitial = getInitialFeed(ADSLGR_TOPICS_TOPIC, 'adslgr', 'hot');
	const lagonikaFeedInitial = getInitialFeed(LAGONIKA_OFFERS_TOPIC, 'lagonika', 'external');
	const feedPanelConfigs: FeedPanelConfig[] = [
		{
			topic: GREECE_RISING_TOPIC,
			defaultTitle: 'r/greece',
			initialData: greekFeedInitial,
			fallbackStrategy: 'external',
			showScore: true,
			initialVisibleCount: FEED_INITIAL_VISIBLE_COUNTS[GREECE_RISING_TOPIC]
		},
		{
			topic: INSOMNIA_TOPICS_TOPIC,
			defaultTitle: 'insomnia',
			initialData: insomniaFeedInitial,
			fallbackStrategy: 'hot',
			showModeSwitch: true,
			showScore: false,
			initialVisibleCount: FEED_INITIAL_VISIBLE_COUNTS[INSOMNIA_TOPICS_TOPIC]
		},
		{
			topic: PHORUM_TOPICS_TOPIC,
			defaultTitle: 'phorum',
			initialData: phorumFeedInitial,
			fallbackStrategy: 'hot',
			showModeSwitch: true,
			showScore: false,
			initialVisibleCount: FEED_INITIAL_VISIBLE_COUNTS[PHORUM_TOPICS_TOPIC]
		},
		{
			topic: X_TRENDS_TOPIC,
			defaultTitle: 'twitter/x',
			initialData: xTrendsInitial,
			fallbackStrategy: 'external',
			showScore: false,
			showItemTime: false,
			layout: 'horizontal',
			initialVisibleCount: FEED_INITIAL_VISIBLE_COUNTS[X_TRENDS_TOPIC]
		},
		{
			topic: ADSLGR_TOPICS_TOPIC,
			defaultTitle: 'adslgr',
			initialData: adslgrFeedInitial,
			fallbackStrategy: 'hot',
			showModeSwitch: true,
			showScore: false,
			initialVisibleCount: FEED_INITIAL_VISIBLE_COUNTS[ADSLGR_TOPICS_TOPIC]
		},
		{
			topic: MYPHONE_TOPICS_TOPIC,
			defaultTitle: 'myphone',
			initialData: myphoneFeedInitial,
			fallbackStrategy: 'hot',
			showModeSwitch: true,
			showScore: false,
			initialVisibleCount: FEED_INITIAL_VISIBLE_COUNTS[MYPHONE_TOPICS_TOPIC]
		},
		{
			topic: LAGONIKA_OFFERS_TOPIC,
			defaultTitle: 'lagonika',
			initialData: lagonikaFeedInitial,
			fallbackStrategy: 'external',
			showModeSwitch: true,
			showScore: true,
			initialVisibleCount: FEED_INITIAL_VISIBLE_COUNTS[LAGONIKA_OFFERS_TOPIC]
		}
	];
	const sources = feedPanelConfigs.map((config) => ({
		topic: config.topic,
		label: config.defaultTitle
	}));
	const visibleFeedConfigs = $derived(
		feedPreferences
			.ordered(sources)
			.filter((source) => !feedPreferences.value.hiddenSources.includes(source.topic))
			.flatMap((source) => feedPanelConfigs.filter((config) => config.topic === source.topic))
	);

	let settingsModalOpen = $state(false);
	let infoModalOpen = $state(false);
	let suggestionModalOpen = $state(false);
	let connectionStats = $state<ConnectionStatsMessage | null>(null);
	let connectionStatsLoading = $state(false);
	let connectionStatsError = $state(false);
	let liveConnectionProblem = $state(false);
	let browserNow = $state(Date.now());
	let browserTimeZone = $state<string | undefined>(undefined);
	let restoreReduceAnimationsSwitchTransition = $state(false);
	let restoreReduceAnimationsSwitchTransitionTimer: number | undefined;
	let liveConnectionProblemTimeout: number | undefined;
	const feedConnectionStates = new SvelteMap<string, ConnectionState>();
	const systemReducedMotion = new MediaQuery('(prefers-reduced-motion: reduce)');
	let reduceAnimations = $derived(reduceAnimationsStorage.current || systemReducedMotion.current);
	let useOldRedditForNsfw = $derived(oldRedditNsfwStorage.current);
	let openExternalLinksInNewTabs = $derived(externalLinksInNewTabsStorage.current);
	let externalLinkTarget = $derived(openExternalLinksInNewTabs ? '_blank' : undefined);
	let externalLinkRel = $derived(openExternalLinksInNewTabs ? 'external noreferrer' : 'external');
	let hyphenateTitles = $derived(titleHyphenationStorage.current);
	let hyphenateNonGreekTitles = $derived(nonGreekTitleHyphenationStorage.current);
	let liveConnectionState = $derived(
		getAggregateConnectionState([...feedConnectionStates.values()])
	);
	let liveConnectionDisplayState = $derived(
		getConnectionDisplayState(liveConnectionState, liveConnectionProblem)
	);
	let liveConnectionStatusLabel = $derived(getConnectionStatusLabel(liveConnectionDisplayState));

	onMount(() => {
		browserNow = Date.now();
		browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		settingsModalOpen = isSettingsHash();
		startLiveConnectionProblemTimer();
		const cleanupPreferences = feedPreferences.initialize(sources);
		// Keep the initial layout until the saved order is reflected in the DOM.
		void tick().then(() => document.getElementById('feed-preferences-initial')?.remove());
		const cleanupNotifications = replyNotifications.initialize();

		openCommentsFromHash();
		window.addEventListener('hashchange', openCommentsFromHash);

		const clockTimer = window.setInterval(() => {
			browserNow = Date.now();
		}, 30_000);

		return () => {
			window.clearInterval(clockTimer);
			window.clearTimeout(restoreReduceAnimationsSwitchTransitionTimer);
			clearLiveConnectionProblemTimer();
			cleanupPreferences();
			cleanupNotifications();
			window.removeEventListener('hashchange', openCommentsFromHash);
		};
	});

	$effect(() => {
		const token = commentsStore.authorToken;
		untrack(() => replyNotifications.setIdentity(token));
	});

	/**
	 * Opens the comments rail for one feed item.
	 *
	 * Called both from the dedicated comment button and, for the feeds that have a discussion
	 * menu, from the item click that also opens that menu.
	 */
	function openComments(topic: string, item: CrawlSnapshotItem) {
		const config = feedPanelConfigs.find((entry) => entry.topic === topic);
		openDiscussion({
			topic,
			externalId: item.external_id,
			title: item.title,
			topicDisplayName: config?.initialData.displayName ?? config?.defaultTitle ?? topic,
			url: item.url
		});
	}

	function openDiscussion(thread: OpenThread) {
		settingsModalOpen = false;
		infoModalOpen = false;
		commentsStore.openThread(thread);
		replaceCommentsHash(thread.topic, thread.externalId, thread.commentId);
	}

	function toggleDiscussions() {
		if (commentsStore.discussionsOpen) {
			commentsStore.close();
			return;
		}
		closeInfoModal();
		closeSettingsModal();
		commentsStore.openDiscussions();
	}

	function replaceCommentsHash(topic: string, externalId: string, commentId?: string) {
		// Built as a string rather than through `URL` so each segment is encoded independently; an
		// external id containing a slash would otherwise be indistinguishable from a separator.
		const hash = commentHash(topic, externalId, commentId);

		// Compared through the parser, not as strings: the fragment this builds keeps its letters
		// literal while `location.hash` reports them percent-encoded, so `!==` would be true every
		// time and replace the history entry on every call.
		if (!commentHashMatches(window.location.hash, topic, externalId, commentId)) {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- Fragment-only update of the current route.
			replaceState(hash, page.state);
		}
	}

	/** Opens a thread named in the URL hash, so a shared link lands directly on it. */
	function openCommentsFromHash() {
		const decoded = parseCommentHash(window.location.hash);
		if (!decoded) return;
		if (decoded.length !== 3 && decoded.length !== 4) return;

		const [, rawTopic, rawExternalId, commentId] = decoded;
		if (commentId && !/^[0-9a-f-]{36}$/i.test(commentId)) return;

		const topic = rawTopic;
		const externalId = rawExternalId;
		if (!topic || !externalId) return;

		const config = feedPanelConfigs.find((entry) => entry.topic === topic);
		if (!config) return;

		const item = config.initialData.snapshots
			.flatMap((snapshot) => snapshot.items)
			.find((item) => item.external_id === externalId);
		commentsStore.openThread({
			topic,
			externalId,
			commentId,
			title: item?.title ?? 'Σχόλια',
			topicDisplayName: config.initialData.displayName ?? config.defaultTitle,
			url: item?.url ?? ''
		});
	}

	function getInitialFeed(
		topic: string,
		displayName: string,
		strategy: RankingStrategy | null
	): InitialFeedData {
		return (
			initialData.feeds?.[topic] ?? {
				displayName,
				strategy,
				snapshots: [],
				asOf: Date.now()
			}
		);
	}

	function changeReduceAnimations(event: { value: boolean }) {
		if (!event.value) {
			allowReduceAnimationsSwitchTransition();
		}

		reduceAnimationsStorage.current = event.value;

		if (event.value) {
			window.clearTimeout(restoreReduceAnimationsSwitchTransitionTimer);
			restoreReduceAnimationsSwitchTransition = false;
			stopActiveMotion();
		}
	}

	function prepareReduceAnimationsSwitchTransition(event: KeyboardEvent | PointerEvent) {
		if (event instanceof KeyboardEvent && event.key !== ' ' && event.key !== 'Enter') {
			return;
		}

		if (reduceAnimations) {
			allowReduceAnimationsSwitchTransition();
		}
	}

	function allowReduceAnimationsSwitchTransition() {
		window.clearTimeout(restoreReduceAnimationsSwitchTransitionTimer);
		restoreReduceAnimationsSwitchTransition = true;
		restoreReduceAnimationsSwitchTransitionTimer = window.setTimeout(() => {
			restoreReduceAnimationsSwitchTransition = false;
		}, 450);
	}

	function changeUseOldRedditForNsfw(event: { value: boolean }) {
		oldRedditNsfwStorage.current = event.value;
	}

	function changeExternalLinksInNewTabs(event: { value: boolean }) {
		externalLinksInNewTabsStorage.current = event.value;
	}

	function changeTitleHyphenation(event: { value: boolean }) {
		titleHyphenationStorage.current = event.value;
	}

	function changeNonGreekTitleHyphenation(event: { value: boolean }) {
		nonGreekTitleHyphenationStorage.current = event.value;
	}

	function changeTheme(event: { value: string | number }) {
		setMode(event.value as ThemePreference);
	}

	function openSettingsModal() {
		settingsModalOpen = true;
		suggestionModalOpen = false;
		infoModalOpen = false;
		replaceSettingsHash(true);
	}

	function closeSettingsModal() {
		settingsModalOpen = false;
		replaceSettingsHash(false);
	}

	function openInfoModal() {
		infoModalOpen = true;
		suggestionModalOpen = false;
		settingsModalOpen = false;
		replaceSettingsHash(false);
	}

	function closeInfoModal() {
		infoModalOpen = false;
	}

	$effect(() => {
		const active = commentsStore.moderatorActive;
		connectionStats = null;
		connectionStatsError = false;
		connectionStatsLoading = active;
		if (!active) return;
		const controller = new AbortController();
		let fetching = false;
		async function refresh() {
			if (fetching || document.hidden || controller.signal.aborted) return;
			fetching = true;
			try {
				const stats = await request<ConnectionStatsMessage>('/api/moderation/connection-stats', {
					signal: controller.signal
				});
				if (!controller.signal.aborted) {
					connectionStats = stats;
					connectionStatsError = false;
				}
			} catch (error) {
				if (controller.signal.aborted) return;
				if (error instanceof CommentsApiError && error.status === 401) {
					commentsStore.moderatorActive = false;
					connectionStats = null;
				} else {
					connectionStats = null;
					connectionStatsError = true;
				}
			} finally {
				fetching = false;
				if (!controller.signal.aborted) connectionStatsLoading = false;
			}
		}
		void refresh();
		const timer = setInterval(() => void refresh(), 30_000);
		document.addEventListener('visibilitychange', refresh);
		return () => {
			controller.abort();
			clearInterval(timer);
			document.removeEventListener('visibilitychange', refresh);
		};
	});

	function openSuggestionModal() {
		closeInfoModal();
		closeSettingsModal();
		feedSuggestions.success = false;
		suggestionModalOpen = true;
	}

	function updateFeedConnectionState(topic: string, state: ConnectionState | null) {
		if (state == null) {
			feedConnectionStates.delete(topic);
		} else {
			feedConnectionStates.set(topic, state);
		}

		updateLiveConnectionProblem(getAggregateConnectionState([...feedConnectionStates.values()]));
	}

	function getAggregateConnectionState(states: ConnectionState[]): ConnectionState {
		if (!states.length) {
			return 'idle';
		}

		if (states.some((state) => state === 'closed' || state === 'error')) {
			return 'error';
		}

		if (states.every((state) => state === 'open')) {
			return 'open';
		}

		if (states.some((state) => state === 'connecting')) {
			return 'connecting';
		}

		return 'idle';
	}

	function updateLiveConnectionProblem(state: ConnectionState) {
		if (state === 'open') {
			liveConnectionProblem = false;
			clearLiveConnectionProblemTimer();
			return;
		}

		if (state === 'closed' || state === 'error') {
			liveConnectionProblem = true;
			clearLiveConnectionProblemTimer();
			return;
		}

		if (!liveConnectionProblem) {
			startLiveConnectionProblemTimer();
		}
	}

	function startLiveConnectionProblemTimer() {
		if (liveConnectionProblemTimeout !== undefined) {
			return;
		}

		liveConnectionProblemTimeout = window.setTimeout(() => {
			liveConnectionProblem = true;
			liveConnectionProblemTimeout = undefined;
		}, CONNECTION_PROBLEM_DELAY_MS);
	}

	function clearLiveConnectionProblemTimer() {
		if (liveConnectionProblemTimeout === undefined) {
			return;
		}

		window.clearTimeout(liveConnectionProblemTimeout);
		liveConnectionProblemTimeout = undefined;
	}

	function getConnectionDisplayState(
		state: ConnectionState,
		problem: boolean
	): ConnectionStatusDisplay {
		if (state === 'open') {
			return 'open';
		}

		return problem ? 'problem' : 'pending';
	}

	function getConnectionStatusLabel(state: ConnectionStatusDisplay) {
		if (state === 'open') {
			return 'Live σύνδεση ενεργή';
		}

		if (state === 'problem') {
			return 'Live σύνδεση εκτός';
		}

		return 'Σύνδεση live feed';
	}

	function getConnectionStatsSummary(stats: ConnectionStatsMessage) {
		const uniqueIps = formatConnectionStatNumber(stats.unique_client_ips);
		const websocketConnections = formatConnectionStatNumber(stats.websocket_connections);
		const connectionVerb =
			stats.unique_client_ips === 1 ? 'είναι συνδεδεμένη' : 'είναι συνδεδεμένες';
		const ipNoun =
			stats.unique_client_ips === 1 ? 'μοναδική διεύθυνση IP' : 'μοναδικές διευθύνσεις IP';
		const connectionNoun =
			stats.websocket_connections === 1 ? 'websocket σύνδεση' : 'websocket συνδέσεις';

		return `Αυτή τη στιγμή ${connectionVerb} ${uniqueIps} ${ipNoun}, με ${websocketConnections} ${connectionNoun}.`;
	}

	function formatConnectionStatNumber(value: number) {
		return new Intl.NumberFormat(DEFAULT_LOCALE).format(value);
	}

	function replaceSettingsHash(open: boolean) {
		const nextUrl = getSettingsUrl(open);
		if (nextUrl.href !== window.location.href) {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- This URL already includes the app base path.
			replaceState(nextUrl, page.state);
		}
	}

	function getSettingsUrl(open: boolean) {
		const url = new SvelteURL(window.location.href);

		if (open) {
			url.hash = SETTINGS_HASH;
		} else if (
			url.hash.slice(1).toLowerCase() === encodeURIComponent(SETTINGS_HASH).toLowerCase()
		) {
			url.hash = '';
		}

		return url;
	}

	function isSettingsHash() {
		return (
			window.location.hash.slice(1).toLowerCase() ===
			encodeURIComponent(SETTINGS_HASH).toLowerCase()
		);
	}

	function stopActiveMotion() {
		document.getAnimations().forEach((animation) => animation.cancel());
		document
			.querySelectorAll<HTMLElement>('.feed-item-outgoing-overlay')
			.forEach((overlay) => overlay.remove());
		document
			.querySelectorAll<HTMLElement>('.feed-item-incoming')
			.forEach((row) => row.classList.remove('feed-item-incoming'));
	}
</script>

<svelte:head>
	<meta name="feed-sources" content={JSON.stringify(sources.map((source) => source.topic))} />
	<title>{PAGE_TITLE}</title>
	<meta name="description" content={PAGE_DESCRIPTION} />
	<link rel="canonical" href={SITE_URL} />
	<meta property="og:type" content="website" />
	<meta property="og:locale" content="el_GR" />
	<meta property="og:site_name" content="Greeklish.gr" />
	<meta property="og:url" content={SITE_URL} />
	<meta property="og:title" content={PAGE_TITLE} />
	<meta property="og:description" content={PAGE_DESCRIPTION} />
	<meta property="og:image" content={`${SITE_URL}social-preview.png`} />
	<meta property="og:image:type" content="image/png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content="Greeklish.gr — Ο παλμός των ελληνικών κοινοτήτων" />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={PAGE_TITLE} />
	<meta name="twitter:description" content={PAGE_DESCRIPTION} />
	<meta name="twitter:image" content={`${SITE_URL}social-preview.png`} />
	<meta name="twitter:image:alt" content="Greeklish.gr — Ο παλμός των ελληνικών κοινοτήτων" />
	<!-- Only static site metadata is serialized here; no feed or user content. -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	{@html WEBSITE_STRUCTURED_DATA}
</svelte:head>

<div class="app-layout">
	<div class="app-main">
		<main
			class="page-shell"
			class:reduce-animations={reduceAnimations}
			class:reduce-animations-switch-restoring={restoreReduceAnimationsSwitchTransition}
		>
			<header class="site-header">
				<div class="site-intro">
					<div class="site-title-row">
						<h1>Greeklish.gr — Ο παλμός των ελληνικών κοινοτήτων</h1>
						{#if commentsStore.moderatorActive}
							<span
								class="moderator-connections"
								title={connectionStats ? getConnectionStatsSummary(connectionStats) : undefined}
							>
								{#if connectionStats}
									{formatConnectionStatNumber(connectionStats.unique_client_ips)} συνδεδεμέν{connectionStats.unique_client_ips ===
									1
										? 'η IP'
										: 'ες IP'}
								{:else if connectionStatsError}
									Συνδέσεις μη διαθέσιμες
								{:else if connectionStatsLoading}
									Έλεγχος συνδέσεων…
								{/if}
							</span>
						{/if}
					</div>
					<p>
						Δημοφιλή θέματα, συζητήσεις και προσφορές από επιλεγμένες ελληνικές online κοινότητες,
						σε μία σελίδα.
						<button
							class="info-text-link live-connection-button"
							data-state={liveConnectionDisplayState}
							type="button"
							title={`Περισσότερες πληροφορίες - ${liveConnectionStatusLabel}`}
							aria-haspopup="dialog"
							aria-expanded={infoModalOpen}
							onclick={openInfoModal}>Περισσότερες πληροφορίες…</button
						>
					</p>
				</div>
				<div class="header-controls" role="group" aria-label="Εργαλεία σελίδας">
					<button
						class="settings-button discussions-button"
						type="button"
						title="Όλες οι συζητήσεις"
						aria-controls="comments-rail"
						aria-expanded={commentsStore.discussionsOpen}
						onclick={toggleDiscussions}
					>
						<Icon name="chat-bubble" size={16} />
						<span>Συζητήσεις</span>
					</button>
					{#if commentsStore.authorToken}
						<button
							class="settings-button replies-button"
							type="button"
							aria-controls="comments-rail"
							aria-expanded={commentsStore.repliesOpen}
							onclick={() => {
								closeInfoModal();
								closeSettingsModal();
								if (commentsStore.repliesOpen) commentsStore.close();
								else commentsStore.openReplies();
							}}
						>
							<Icon name="alert-16-regular" size={16} /><span>Απαντήσεις μου</span>
							{#if replyNotifications.unread > 0}<span
									class="replies-unread"
									aria-label={`${replyNotifications.unread} αδιάβαστες απαντήσεις`}
									>{replyNotifications.unread > 99 ? '99+' : replyNotifications.unread}</span
								>{/if}
						</button>
					{/if}
					{#if commentsStore.moderatorActive}
						<button
							class="settings-button moderation-button"
							type="button"
							title="Διαχείριση σχολίων"
							aria-label="Διαχείριση σχολίων"
							aria-controls="comments-rail"
							aria-expanded={commentsStore.moderationOpen}
							onclick={() => commentsStore.openModeration()}
						>
							<Icon name="chat-bubble" size={16} />
							<span class="moderator-dot" aria-hidden="true"></span>
						</button>
					{/if}
					<button
						class="settings-button"
						type="button"
						title="Ρυθμίσεις"
						aria-label="Ρυθμίσεις"
						aria-haspopup="dialog"
						aria-expanded={settingsModalOpen}
						onclick={openSettingsModal}
					>
						<Icon name="settings-16-regular" size={16} />
						<span>Ρυθμίσεις</span>
					</button>
					<button
						class="settings-button"
						type="button"
						aria-haspopup="dialog"
						aria-expanded={suggestionModalOpen}
						onclick={openSuggestionModal}
					>
						<Icon name="send-16-regular" size={16} /><span>Πρότεινε πηγή</span>
					</button>
				</div>
			</header>

			{#if suggestionModalOpen}
				<AppModalArea
					title="Πρότεινε πηγή"
					reduceMotion={reduceAnimations}
					onClose={() => (suggestionModalOpen = false)}
				>
					<FeedSuggestionForm onClose={() => (suggestionModalOpen = false)} />
				</AppModalArea>
			{/if}

			{#if infoModalOpen}
				<AppModalArea
					title="Τι είναι το Greeklish.gr"
					reduceMotion={reduceAnimations}
					onClose={closeInfoModal}
				>
					<p class="info-modal-copy">
						<a href="https://github.com/greeklish/greeklish" target="_blank" rel="noopener noreferrer"
							>Πηγαίος κώδικας — AGPL-3.0-or-later</a
						>
					</p>
					<p class="info-modal-copy">
						Το Greeklish.gr δείχνει τον ζωντανό παλμό επιλεγμένων ελληνικών online κοινοτήτων,
						συλλέγοντας ενεργά θέματα και παρουσιάζοντάς τα σε μια γρήγορη, ευανάγνωστη σελίδα.
					</p>
					<p class="info-modal-copy">
						Κράτησε ό,τι σε ενδιαφέρει: από τις Ρυθμίσεις αλλάζεις τη σειρά των πηγών ή κρύβεις
						κάποιες από αυτές. Το μενού κάθε θέματος σου επιτρέπει να το κρύψεις με δυνατότητα
						αναίρεσης. Οι επιλογές αποθηκεύονται μόνο σε αυτόν τον περιηγητή.
					</p>
					<p class="info-modal-copy">
						Στις Συζητήσεις γράφεις σχόλια και απαντήσεις χωρίς εγγραφή· το όνομα είναι προαιρετικό.
						Οι «Απαντήσεις μου» κρατούν τις απαντήσεις στα σχόλιά σου για 90 ημέρες. Αν θέλεις,
						ενεργοποιείς ειδοποιήσεις ξεχωριστά για κάθε δικό σου σχόλιο.
					</p>
				</AppModalArea>
			{/if}

			{#if settingsModalOpen}
				<AppModalArea
					title="Ρυθμίσεις"
					reduceMotion={reduceAnimations}
					onClose={closeSettingsModal}
				>
					<FeedPreferences {sources} />
					<NotificationSettings />
					<fieldset class="theme-setting">
						<legend>Θέμα</legend>
						<Segmented
							css="theme-segmented"
							options={THEME_OPTIONS}
							value={userPrefersMode.current}
							onchange={changeTheme}
						/>
					</fieldset>
					<div class="settings-row">
						<label for="external-links-new-tabs-switch"
							>Άνοιγμα εξωτερικών συνδέσμων σε νέα καρτέλα</label
						>
						<Switch
							id="external-links-new-tabs-switch"
							value={openExternalLinksInNewTabs}
							onchange={changeExternalLinksInNewTabs}
						/>
					</div>
					<div class="settings-row">
						<label for="title-hyphenation-switch">Συλλαβισμός τίτλων</label>
						<Switch
							id="title-hyphenation-switch"
							value={hyphenateTitles}
							onchange={changeTitleHyphenation}
						/>
					</div>
					<div class="settings-row settings-subrow" class:settings-row-disabled={!hyphenateTitles}>
						<label for="non-greek-title-hyphenation-switch">Συλλαβισμός greeklish χαρακτήρων</label>
						<Switch
							id="non-greek-title-hyphenation-switch"
							value={hyphenateNonGreekTitles}
							disabled={!hyphenateTitles}
							onchange={changeNonGreekTitleHyphenation}
						/>
					</div>
					<div class="settings-row">
						<label for="reduce-animations-switch">Μείωση εφέ κίνησης</label>
						<div
							class="reduce-animations-switch-control"
							role="presentation"
							onpointerdown={prepareReduceAnimationsSwitchTransition}
							onkeydown={prepareReduceAnimationsSwitchTransition}
						>
							<Switch
								id="reduce-animations-switch"
								value={reduceAnimations}
								onchange={changeReduceAnimations}
							/>
						</div>
					</div>
					<fieldset class="settings-source-group">
						<legend>r/greece</legend>
						<div class="settings-row">
							<label class="settings-nsfw-label" for="old-reddit-nsfw-switch">
								<span>Άνοιγμα</span>
								<span class="item-tag item-tag-nsfw settings-nsfw-tag italic">nsfw</span>
								<span>στο old.reddit.com</span>
							</label>
							<Switch
								id="old-reddit-nsfw-switch"
								value={useOldRedditForNsfw}
								onchange={changeUseOldRedditForNsfw}
							/>
						</div>
					</fieldset>
				</AppModalArea>
			{/if}

			{#snippet feedPanel(config: FeedPanelConfig)}
				<FeedPanel
					topic={config.topic}
					defaultTitle={config.defaultTitle}
					initialData={config.initialData}
					fallbackStrategy={config.fallbackStrategy}
					{reduceAnimations}
					{useOldRedditForNsfw}
					{openExternalLinksInNewTabs}
					{hyphenateTitles}
					{hyphenateNonGreekTitles}
					{browserNow}
					browserLocale={DEFAULT_LOCALE}
					{browserTimeZone}
					showModeSwitch={config.showModeSwitch ?? false}
					showScore={config.showScore ?? true}
					showItemTime={config.showItemTime ?? true}
					layout={config.layout ?? 'vertical'}
					initialVisibleCount={config.initialVisibleCount}
					onConnectionStateChange={updateFeedConnectionState}
					onOpenComments={openComments}
				/>
			{/snippet}

			<SourceNavigation
				sources={visibleFeedConfigs.map((config) => ({
					topic: config.topic,
					label: config.defaultTitle
				}))}
				onCustomize={openSettingsModal}
			/>

			<div class="feed-stack">
				{#each visibleFeedConfigs as config (config.topic)}
					{@render feedPanel(config)}
				{:else}
					<div class="feed-empty-preferences">
						<p>Έχεις κρύψει όλες τις πηγές.</p>
						<button class="settings-button" type="button" onclick={openSettingsModal}
							>Επιλογή πηγών</button
						>
					</div>
				{/each}
			</div>
		</main>
	</div>

	<CommentsRail
		{reduceAnimations}
		locale={DEFAULT_LOCALE}
		{externalLinkTarget}
		{externalLinkRel}
		onOpenDiscussion={openDiscussion}
	/>
</div>

<ModeratorGate reduceMotion={reduceAnimations} />
<FeedUndo />
