<script lang="ts">
	import { onMount } from 'svelte';
	import { Segmented } from '@svar-ui/svelte-core';
	import Icon from '$lib/Icon.svelte';
	import FeedSuggestionsPanel from '$lib/FeedSuggestionsPanel.svelte';
	import { formatAbsoluteDateTime, formatRelativeTime } from '$lib/format';
	import { commentsStore } from '$lib/comments-store.svelte';
	import {
		decideComment,
		deleteModeratorSession,
		fetchModerationLog,
		fetchModerationFeeds,
		type ModerationFeed,
		fetchModerationQueue,
		fetchModerationStats,
		setAuthorTrust,
		CommentsApiError,
		type ModerationDecision,
		type ModerationLogItem,
		type ModerationQueueItem
	} from '$lib/comments-api';

	type Props = {
		reduceAnimations: boolean;
		locale: string;
	};

	let { locale }: Props = $props();

	type Tab = 'queue' | 'log' | 'suggestions';
	let pendingSuggestions = $state(0);

	const TABS: { id: Tab; label: string }[] = $derived([
		{ id: 'queue', label: 'Σχόλια' },
		{ id: 'log', label: 'Ιστορικό' },
		{ id: 'suggestions', label: `Προτάσεις${pendingSuggestions ? ` (${pendingSuggestions})` : ''}` }
	]);

	const ACTION_LABELS: Record<string, string> = {
		submitted: 'Υποβλήθηκε',
		held: 'Σε αναμονή',
		auto_approved: 'Αυτόματη έγκριση',
		approved: 'Εγκρίθηκε',
		rejected: 'Απορρίφθηκε',
		marked_spam: 'Spam',
		hidden: 'Αποκρύφθηκε',
		restored: 'Επαναφέρθηκε',
		author_trust_revoked: 'Ανάκληση εμπιστοσύνης',
		author_trust_restored: 'Επαναφορά εμπιστοσύνης',
		author_banned: 'Αποκλεισμός',
		author_unbanned: 'Άρση αποκλεισμού',
		ip_blocked: 'Αποκλεισμός IP',
		ip_unblocked: 'Άρση αποκλεισμού IP'
	};

	const HOLD_REASON_LABELS: Record<string, string> = {
		below_threshold: 'κάτω από το όριο εμπιστοσύνης',
		trust_revoked: 'ανακληθείσα εμπιστοσύνη',
		contains_link: 'περιέχει σύνδεσμο',
		recent_rejection: 'πρόσφατη απόρριψη',
		auto_burst: 'πολλές αυτόματες εγκρίσεις'
	};

	let tab = $state<Tab>('queue');
	let queue = $state<ModerationQueueItem[]>([]);
	let log = $state<ModerationLogItem[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let selectedIndex = $state(0);
	let autoApprovedOnly = $state(false);
	let now = $state(Date.now());
	let panelElement: HTMLElement | undefined = $state();

	let feeds = $state<ModerationFeed[]>([]);
	let topic = $state('');
	let status = $state('pending');
	let author = $state('');
	let query = $state('');
	let authorId = $state('');
	let authorLabel = $state('');
	let nextCursor = $state<string | null>(null);
	let busy = $state(false);
	let requestId = 0;
	let controller: AbortController | undefined;
	let applied = { topic: '', author: '', q: '', author_id: '' };
	const STATUS_LABELS: Record<string, string> = {
		pending: 'Σε αναμονή',
		approved: 'Εγκεκριμένα',
		rejected: 'Απορριφθέντα',
		spam: 'Spam',
		hidden: 'Κρυμμένα',
		all: 'Όλα'
	};

	async function load(append = false) {
		const id = ++requestId;
		controller?.abort();
		controller = new AbortController();
		loading = true;
		error = null;
		if (!append) {
			queue = [];
			log = [];
			selectedIndex = 0;
			nextCursor = null;
		}
		try {
			const params = { ...applied, cursor: append ? nextCursor : null };
			if (tab === 'queue') {
				const response = await fetchModerationQueue({ ...params, status }, controller.signal);
				if (id !== requestId) return;
				queue = append ? [...queue, ...response.comments] : response.comments;
				nextCursor = response.next_cursor;
			} else {
				const response = await fetchModerationLog(
					{ ...params, action: autoApprovedOnly ? 'auto_approved' : undefined },
					controller.signal
				);
				if (id !== requestId) return;
				log = append ? [...log, ...response.events] : response.events;
				nextCursor = response.next_cursor;
			}
		} catch (failure) {
			if (id === requestId && !(failure instanceof DOMException && failure.name === 'AbortError'))
				error = describe(failure);
		} finally {
			if (id === requestId) loading = false;
		}
	}
	function applyFilters() {
		applied = { topic, author: author.trim(), q: query.trim(), author_id: authorId };
		void load();
	}
	function filterAuthor(id: string, name: string) {
		authorId = id;
		authorLabel = name;
		author = '';
		applyFilters();
		panelElement?.scrollTo({ top: 0, behavior: 'auto' });
	}
	function resetFilters() {
		topic = '';
		status = 'pending';
		author = '';
		query = '';
		authorId = '';
		authorLabel = '';
		autoApprovedOnly = false;
		applyFilters();
	}

	async function refreshStats() {
		try {
			const stats = await fetchModerationStats();
			commentsStore.moderationPending = stats.pending;
			pendingSuggestions = stats.pending_suggestions ?? 0;
		} catch {
			// The badge is decoration; a failure must not disturb the console.
		}
	}

	function describe(failure: unknown) {
		if (failure instanceof CommentsApiError) {
			// A 401 means the session is gone; drop back to the public rail rather than looping.
			if (failure.status === 401) {
				commentsStore.moderatorActive = false;
				commentsStore.close();
			}

			return failure.message;
		}

		return 'Κάτι πήγε στραβά. Δοκίμασε ξανά.';
	}

	async function decide(comment: ModerationQueueItem, action: ModerationDecision) {
		if (busy || loading) return;
		busy = true;
		try {
			await decideComment(comment.id, action);
			await load();
			void refreshStats();
		} catch (failure) {
			error = describe(failure);
		} finally {
			busy = false;
		}
	}
	async function trust(comment: ModerationQueueItem, action: 'revoke' | 'ban') {
		if (busy || loading) return;
		busy = true;
		try {
			await setAuthorTrust(comment.author_id, action);
			await load();
			void refreshStats();
		} catch (failure) {
			error = describe(failure);
		} finally {
			busy = false;
		}
	}

	async function logout() {
		try {
			await deleteModeratorSession();
		} finally {
			commentsStore.moderatorActive = false;
			commentsStore.close();
		}
	}

	function changeTab(event: { value: string | number }) {
		tab = event.value === 'suggestions' ? 'suggestions' : event.value === 'log' ? 'log' : 'queue';
		if (tab === 'suggestions') {
			controller?.abort();
			requestId++;
			loading = false;
			error = null;
		} else void load();
	}

	function toggleAutoApproved() {
		autoApprovedOnly = !autoApprovedOnly;
		void load();
	}

	/** j/k to move, a/r/s to decide — active only while no text field has focus. */
	function handleKeydown(event: KeyboardEvent) {
		if (
			tab !== 'queue' ||
			!queue.length ||
			loading ||
			busy ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey
		)
			return;

		const target = event.target;
		if (
			target instanceof HTMLElement &&
			(target.tagName === 'INPUT' ||
				target.tagName === 'SELECT' ||
				target.tagName === 'BUTTON' ||
				target.tagName === 'TEXTAREA' ||
				target.isContentEditable)
		) {
			return;
		}

		const selected = queue[selectedIndex];

		switch (event.key.toLowerCase()) {
			case 'j':
				selectedIndex = Math.min(selectedIndex + 1, queue.length - 1);
				break;
			case 'k':
				selectedIndex = Math.max(selectedIndex - 1, 0);
				break;
			case 'a':
				if (selected) void decide(selected, 'approve');
				break;
			case 'r':
				if (selected) void decide(selected, 'reject');
				break;
			case 's':
				if (selected) void decide(selected, 'spam');
				break;
			default:
				return;
		}

		event.preventDefault();
	}

	onMount(() => {
		void load();
		void fetchModerationFeeds()
			.then((result) => {
				feeds = result;
			})
			.catch((failure) => {
				error = describe(failure);
			});
		void refreshStats();

		window.addEventListener('keydown', handleKeydown);
		const timer = setInterval(() => {
			now = Date.now();
		}, 30_000);

		return () => {
			requestId++;
			controller?.abort();
			window.removeEventListener('keydown', handleKeydown);
			clearInterval(timer);
		};
	});
</script>

<div class="moderation-panel" bind:this={panelElement} aria-busy={loading}>
	<div class="moderation-toolbar">
		<Segmented css="theme-segmented" options={TABS} value={tab} onchange={changeTab} />
		<button
			class="moderation-logout"
			type="button"
			title="Αποσύνδεση"
			aria-label="Αποσύνδεση συντονισμού"
			onclick={logout}
		>
			Έξοδος
		</button>
	</div>

	{#if tab === 'suggestions'}
		<FeedSuggestionsPanel onPending={(count) => (pendingSuggestions = count)} />
	{:else}
		<form
			class="moderation-filter-form"
			onsubmit={(event) => {
				event.preventDefault();
				applyFilters();
			}}
		>
			<div class="moderation-filter-row">
				<label
					>Ροή<select aria-label="Ροή" bind:value={topic} onchange={applyFilters} disabled={busy}>
						<option value="">Όλες οι ροές</option>
						{#each feeds as feed (feed.slug)}<option value={feed.slug}>{feed.display_name}</option
							>{/each}
					</select></label
				>
				{#if tab === 'queue'}
					<label
						>Κατάσταση<select
							aria-label="Κατάσταση"
							bind:value={status}
							onchange={applyFilters}
							disabled={busy}
						>
							{#each Object.entries(STATUS_LABELS) as [value, label] (value)}<option {value}
									>{label}</option
								>{/each}
						</select></label
					>
				{/if}
			</div>
			{#if authorId}
				<button
					class="moderation-author-filter"
					type="button"
					title={authorId}
					disabled={busy}
					onclick={() => {
						authorId = '';
						authorLabel = '';
						applyFilters();
					}}
				>
					Σχολιαστής: {authorLabel} · {authorId.slice(0, 8)} ×
				</button>
			{:else}
				<label
					>Σχολιαστής<input
						bind:value={author}
						maxlength="100"
						placeholder="Αναζήτηση ονόματος"
						disabled={busy}
					/></label
				>
			{/if}
			<label
				>Κείμενο<input
					bind:value={query}
					maxlength="200"
					placeholder="Σχόλιο ή τίτλος άρθρου"
					disabled={busy}
				/></label
			>
			<div class="moderation-filter-actions">
				<button type="submit" disabled={busy}>Αναζήτηση</button>
				<button type="button" onclick={resetFilters} disabled={busy}>Καθαρισμός</button>
				<button
					type="button"
					onclick={() => load()}
					disabled={busy || loading}
					aria-label="Ανανέωση σχολίων">↻</button
				>
			</div>
		</form>
		{#if loading}<p class="moderation-loading" role="status">Γίνεται φόρτωση…</p>{/if}

		{#if error}
			<p class="moderation-error" aria-live="polite">{error}</p>
		{/if}

		{#if tab === 'queue'}
			{#if loading && !queue.length}
				<p class="moderation-empty">Γίνεται φόρτωση…</p>
			{:else if !queue.length}
				<p class="moderation-empty">Δεν βρέθηκαν σχόλια με αυτά τα φίλτρα.</p>
			{:else}
				<ol class="moderation-list">
					{#each queue as comment, index (comment.id)}
						<li class="moderation-card" class:moderation-card-selected={index === selectedIndex}>
							<p class="moderation-context">
								<button
									type="button"
									class="moderation-topic moderation-link"
									disabled={busy}
									onclick={() => {
										topic = comment.topic;
										applyFilters();
									}}>{comment.topic_display_name}</button
								>
								<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- Feed item URLs are external. -->
								<a class="moderation-item" href={comment.item_url} target="_blank" rel="noreferrer">
									{comment.item_title}
								</a>
							</p>

							<p class="moderation-body">{comment.body}</p>

							<p class="moderation-meta">
								<button
									type="button"
									class="moderation-author moderation-link"
									disabled={busy}
									onclick={() => filterAuthor(comment.author_id, comment.author_display_name)}
									title="Όλα τα σχόλια αυτού του σχολιαστή">{comment.author_display_name}</button
								>
								<span>{STATUS_LABELS[comment.status] ?? comment.status}</span>
								<span>{comment.author_approved_count} εγκεκριμένα</span>
								{#if comment.author_fingerprint}
									<span class="moderation-fingerprint" title="Ψευδώνυμο αναγνωριστικό σύνδεσης">
										{comment.author_fingerprint}
									</span>
								{/if}
								<time
									datetime={comment.created_at}
									title={formatAbsoluteDateTime(comment.created_at, locale)}
								>
									{formatRelativeTime(comment.created_at, now)}
								</time>
								{#if comment.hold_reason}
									<span class="moderation-reason">
										{HOLD_REASON_LABELS[comment.hold_reason] ?? comment.hold_reason}
									</span>
								{/if}
							</p>

							<div class="moderation-actions">
								<button
									type="button"
									class="moderation-approve"
									disabled={busy || loading || comment.status === 'approved'}
									onclick={() => decide(comment, 'approve')}
								>
									<Icon name="checkmark-16-regular" size={16} />
									Έγκριση
								</button>
								<button
									type="button"
									disabled={busy || loading}
									onclick={() => decide(comment, 'reject')}>Απόρριψη</button
								>
								<button
									type="button"
									disabled={busy || loading}
									onclick={() => decide(comment, 'spam')}>Spam</button
								>
								<button
									type="button"
									disabled={busy || loading}
									title="Ανάκληση αυτόματης έγκρισης του σχολιαστή"
									onclick={() => trust(comment, 'revoke')}>Ανάκληση</button
								>
								<button
									type="button"
									disabled={busy || loading}
									title="Αποκλεισμός αυτού του σχολιαστή"
									onclick={() => trust(comment, 'ban')}>Αποκλεισμός</button
								>
							</div>
						</li>
					{/each}
				</ol>
			{/if}
		{:else}
			<div class="moderation-filters">
				<button
					type="button"
					class="moderation-chip"
					class:moderation-chip-active={autoApprovedOnly}
					aria-pressed={autoApprovedOnly}
					onclick={toggleAutoApproved}
				>
					Αυτόματα εγκεκριμένα
				</button>
			</div>

			{#if loading && !log.length}
				<p class="moderation-empty">Γίνεται φόρτωση…</p>
			{:else if !log.length}
				<p class="moderation-empty">Δεν υπάρχουν καταγραφές.</p>
			{:else}
				<ol class="moderation-list">
					{#each log as entry (entry.id)}
						<li class="moderation-log-entry">
							<p class="moderation-meta">
								<span class="moderation-action">{ACTION_LABELS[entry.action] ?? entry.action}</span>
								<span>{entry.actor === 'system' ? 'σύστημα' : 'συντονιστής'}</span>
								<time
									datetime={entry.recorded_at}
									title={formatAbsoluteDateTime(entry.recorded_at, locale)}
								>
									{formatRelativeTime(entry.recorded_at, now)}
								</time>
								{#if entry.author_approved_count != null}
									<span>{entry.author_approved_count} εγκεκριμένα τότε</span>
								{/if}
							</p>

							{#if entry.body}
								<p class="moderation-excerpt">{entry.body}</p>
							{/if}

							<p class="moderation-meta">
								{#if entry.author_display_name}
									{#if entry.author_id}<button
											type="button"
											class="moderation-author moderation-link"
											onclick={() => filterAuthor(entry.author_id!, entry.author_display_name!)}
											>{entry.author_display_name}</button
										>{:else}<span>{entry.author_display_name}</span>{/if}
								{/if}
								{#if entry.item_title}
									<span class="moderation-item-title">{entry.item_title}</span>
								{/if}
								{#if entry.reason}
									<span class="moderation-reason">
										{HOLD_REASON_LABELS[entry.reason] ?? entry.reason}
									</span>
								{/if}
							</p>
						</li>
					{/each}
				</ol>
			{/if}
		{/if}
		{#if nextCursor}<button
				class="moderation-more"
				type="button"
				disabled={loading || busy}
				onclick={() => load(true)}>Περισσότερα</button
			>{/if}
	{/if}
</div>

<style>
	.moderation-filter-form {
		display: grid;
		gap: 8px;
		margin-bottom: 12px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--color-border);
	}
	.moderation-filter-form label {
		display: grid;
		gap: 4px;
		min-width: 0;
		font-size: 12px;
		color: var(--color-text-muted);
	}
	.moderation-filter-row {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}
	.moderation-filter-form input,
	.moderation-filter-form select {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		min-height: 36px;
		padding: 6px 8px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: var(--color-surface);
		color: var(--color-text);
		font: inherit;
		font-size: 13px;
	}
	.moderation-filter-actions {
		display: flex;
		gap: 8px;
	}
	.moderation-filter-actions button,
	.moderation-author-filter,
	.moderation-more {
		min-height: 36px;
		padding: 6px 10px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		color: var(--color-cerulean);
		background: transparent;
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.moderation-author-filter {
		text-align: left;
		overflow-wrap: anywhere;
	}
	.moderation-more {
		flex-shrink: 0;
		margin-top: 12px;
	}
	.moderation-loading {
		margin: 0 0 8px;
		font-size: 12px;
		color: var(--color-text-muted);
	}
	.moderation-link {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-cerulean);
		font: inherit;
		text-align: left;
		text-decoration: underline;
		text-underline-offset: 3px;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.moderation-panel {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		flex-direction: column;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 12px 16px;
	}

	.moderation-toolbar {
		flex-wrap: wrap;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 12px;
	}

	.moderation-logout {
		flex: 0 0 auto;
		min-height: 36px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: transparent;
		padding: 4px 8px;
		color: var(--color-cerulean);
		cursor: pointer;
	}

	.moderation-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.moderation-card,
	.moderation-log-entry {
		border: 1px solid var(--color-border);
		padding: 10px;
	}

	.moderation-card-selected {
		border-color: var(--color-cerulean);
		outline: 1px solid var(--color-cerulean);
	}

	.moderation-context {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0 0 6px;
		font-size: 12px;
		line-height: 16px;
	}

	.moderation-topic {
		color: var(--color-text-muted);
	}

	.moderation-item {
		color: var(--color-cerulean);
	}

	.moderation-body,
	.moderation-excerpt {
		margin: 0 0 6px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 14px;
		line-height: 20px;
	}

	.moderation-excerpt {
		color: var(--color-text-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.moderation-meta {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 8px;
		margin: 0 0 6px;
		color: var(--color-text-muted);
		font-size: 12px;
		line-height: 16px;
	}

	.moderation-author,
	.moderation-action {
		color: var(--color-cerulean);
		font-weight: 600;
	}

	.moderation-fingerprint {
		font-family: ui-monospace, monospace;
		font-variant-numeric: tabular-nums;
	}

	.moderation-reason {
		border: 1px solid var(--color-border);
		padding: 0 4px;
		font-size: 11px;
		line-height: 15px;
	}

	.moderation-item-title {
		overflow: hidden;
		max-width: 100%;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.moderation-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.moderation-actions button {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 32px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: transparent;
		padding: 4px 8px;
		color: var(--color-text);
		font-size: 12px;
		cursor: pointer;
	}

	.moderation-actions button:hover,
	.moderation-logout:hover,
	.moderation-chip:hover {
		background: var(--color-secondary-hover);
	}

	.moderation-actions .moderation-approve {
		border-color: var(--color-cerulean);
		color: var(--color-cerulean);
	}

	.moderation-filters {
		margin-bottom: 12px;
	}

	.moderation-chip {
		min-height: 32px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: transparent;
		padding: 4px 8px;
		cursor: pointer;
		font-size: 12px;
	}

	.moderation-chip-active {
		border-color: var(--color-cerulean);
		color: var(--color-cerulean);
	}

	.moderation-empty,
	.moderation-error {
		margin: 8px 0;
		color: var(--color-text-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.moderation-error {
		color: var(--color-vibrant-coral);
	}
</style>
