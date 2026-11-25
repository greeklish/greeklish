<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import CommentComposer from '$lib/CommentComposer.svelte';
	import CommentsThread from '$lib/CommentsThread.svelte';
	import DiscussionsList from '$lib/DiscussionsList.svelte';
	import ReplyInbox from '$lib/ReplyInbox.svelte';
	import { replyNotifications } from '$lib/reply-notifications.svelte';
	import Icon from '$lib/Icon.svelte';
	import ModerationPanel from '$lib/ModerationPanel.svelte';
	import { focusTrap } from '$lib/actions/focus-trap';
	import { commentsStore, type OpenThread } from '$lib/comments-store.svelte';

	type Props = {
		reduceAnimations: boolean;
		locale: string;
		externalLinkTarget: string | undefined;
		externalLinkRel: string | undefined;
		onOpenDiscussion?: (thread: OpenThread) => void;
	};

	let {
		reduceAnimations,
		locale,
		externalLinkTarget,
		externalLinkRel,
		onOpenDiscussion = (thread) => commentsStore.openThread(thread)
	}: Props = $props();

	const RAIL_TRANSITION_DURATION_MS = 320;
	type RailMode = 'push' | 'overlay' | 'sheet';

	let viewportWidth = $state(0);
	let dragY = $state(0);
	let dragging = $state(false);
	let dragStartY = 0;
	let suppressGripClick = false;
	let background: HTMLElement | null = $state(null);
	let thread: CommentsThread | undefined = $state();
	let composer: CommentComposer | undefined = $state();
	let headingElement: HTMLElement | undefined = $state();

	// Reserve space only when the feed can retain its existing column count throughout the
	// animation. In particular, a 1920px three-column feed must not remount as two columns.
	let mode = $derived<RailMode>(
		viewportWidth >= 2060 || (viewportWidth >= 1540 && viewportWidth < 1680)
			? 'push'
			: viewportWidth >= 768
				? 'overlay'
				: 'sheet'
	);
	let isModal = $derived(mode !== 'push');
	let open = $derived(commentsStore.open);
	let moderation = $derived(commentsStore.moderationOpen && commentsStore.moderatorActive);
	let discussions = $derived(commentsStore.discussionsOpen);
	let replies = $derived(commentsStore.repliesOpen);
	let visible = $derived(Boolean(open) || moderation || discussions || replies);
	const focusKey = $derived(
		open
			? `${open.topic}/${open.externalId}`
			: discussions
				? 'discussions'
				: replies
					? 'replies'
					: moderation
						? 'moderation'
						: ''
	);
	let threadState = $derived(open ? commentsStore.threadFor(open.topic, open.externalId) : null);

	function revealRail(node: HTMLElement) {
		if (reduceAnimations) return { duration: 0 };
		const { width, height } = node.getBoundingClientRect();
		const timing = { duration: RAIL_TRANSITION_DURATION_MS, easing: cubicOut };

		if (mode === 'push') {
			// The slot and the feed resize in the same animation, including the closing outro.
			// Its fixed-width child slides with the slot instead of squeezing its text every frame.
			return { ...timing, css: (t: number) => `width: ${t * width}px;` };
		}

		return fly(node, {
			...timing,
			x: mode === 'overlay' ? width : 0,
			y: mode === 'sheet' ? height : 0,
			opacity: 1
		});
	}

	function fadeScrim(node: HTMLElement) {
		return fade(node, { duration: reduceAnimations ? 0 : RAIL_TRANSITION_DURATION_MS });
	}

	function startDrag(event: PointerEvent) {
		if (!event.isPrimary || event.button !== 0) return;
		dragStartY = event.clientY;
		dragging = true;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function moveDrag(event: PointerEvent) {
		if (dragging) dragY = Math.max(0, event.clientY - dragStartY);
	}

	function endDrag() {
		if (!dragging) return;
		dragging = false;
		suppressGripClick = dragY > 5;
		if (dragY >= 80) close();
		else dragY = 0;
	}

	function close() {
		commentsStore.close();
	}

	function handleSubmitted(threadKey: string) {
		if (!open || threadKey !== `${open.topic}/${open.externalId}`) return;
		void tick().then(() => thread?.scrollToBottom(true));
	}

	onMount(() => {
		background = document.querySelector<HTMLElement>('.app-main');
		const measure = () => {
			viewportWidth =
				background?.parentElement?.clientWidth ?? document.documentElement.clientWidth;
		};

		measure();
		window.addEventListener('resize', measure);

		return () => window.removeEventListener('resize', measure);
	});

	// Move focus to the rail heading when it opens, without trapping it in push mode.
	$effect(() => {
		// Keep focus on the heading when navigating between the list and a thread in the same rail.
		void focusKey;
		if (visible && headingElement) headingElement.focus({ preventScroll: true });
	});
</script>

{#if visible}
	{#if isModal}
		<div class="comments-scrim" role="presentation" onclick={close} transition:fadeScrim></div>
	{/if}

	<div
		class="comments-rail-slot comments-rail-slot-{mode}"
		class:comments-rail-dragging={dragging}
		style:translate={mode === 'sheet' ? `0 ${dragY}px` : undefined}
		style:transition-duration={reduceAnimations ? '0ms' : undefined}
		transition:revealRail
		onintrostart={() => {
			dragY = 0;
		}}
		onoutroend={() => {
			dragY = 0;
		}}
	>
		<aside
			id="comments-rail"
			class="comments-rail comments-rail-{mode}"
			role={isModal ? 'dialog' : 'complementary'}
			aria-modal={isModal ? 'true' : undefined}
			aria-labelledby="comments-rail-title"
			use:focusTrap={{
				active: isModal,
				lockScroll: isModal,
				onEscape: close,
				background,
				returnFocus: () => commentsStore.opener
			}}
		>
			<header class="comments-rail-header">
				{#if mode === 'sheet'}
					<button
						class="comments-rail-grip"
						type="button"
						aria-label="Κλείσιμο σχολίων με σύρσιμο προς τα κάτω ή πάτημα"
						onpointerdown={startDrag}
						onpointermove={moveDrag}
						onpointerup={endDrag}
						onpointercancel={() => {
							dragging = false;
							dragY = 0;
						}}
						onclick={() => {
							if (!suppressGripClick) close();
							suppressGripClick = false;
						}}
					></button>
				{/if}

				<div class="comments-rail-heading">
					{#if open && !moderation}
						<div class="thread-navigation">
							<button
								class="discussions-back"
								type="button"
								aria-label="Όλες οι συζητήσεις"
								onclick={() => commentsStore.openDiscussions()}
							>
								<Icon name="chevron-left" size={14} /> Συζητήσεις
							</button>
							{#if commentsStore.authorToken}
								<button
									class="discussions-back"
									type="button"
									onclick={() => commentsStore.openReplies()}>Απαντήσεις μου</button
								>
							{/if}
						</div>
					{/if}
					<h2
						id="comments-rail-title"
						bind:this={headingElement}
						class="comments-rail-title"
						tabindex="-1"
					>
						{moderation
							? 'Διαχείριση σχολίων'
							: discussions
								? 'Συζητήσεις'
								: replies
									? 'Απαντήσεις μου'
									: open?.title}
					</h2>
					<p class="comments-rail-meta">
						<span
							>{moderation
								? 'Σχόλια στο greeklish'
								: discussions
									? 'Πρώτα οι πιο πρόσφατες'
									: replies
										? 'Σχόλια που απαντούν σε εσένα'
										: open?.topicDisplayName}</span
						>
						{#if !moderation && !discussions && !replies}
							<span class="comments-rail-count">
								{threadState?.count ?? 0}
								{(threadState?.count ?? 0) === 1 ? 'σχόλιο' : 'σχόλια'}
							</span>
							{#if open?.url}
								<!-- eslint-disable svelte/no-navigation-without-resolve -- Feed sources are external URLs. -->
								<a
									class="comments-rail-source"
									href={open.url}
									target={externalLinkTarget}
									rel={externalLinkRel}
								>
									<Icon name="open-16-regular" size={16} label="Άνοιγμα πηγής" />
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{/if}
						{/if}
					</p>
				</div>

				<button
					class="comments-rail-close"
					type="button"
					title="Κλείσιμο σχολίων"
					aria-label="Κλείσιμο σχολίων"
					onclick={close}
				>
					<Icon name="dismiss-16-regular" size={16} />
				</button>
			</header>
			{#if discussions || replies}
				<nav class="discussion-tabs" aria-label="Προβολή συζητήσεων">
					<button
						type="button"
						aria-pressed={discussions}
						onclick={() => commentsStore.openDiscussions()}>Συζητήσεις</button
					>
					<button type="button" aria-pressed={replies} onclick={() => commentsStore.openReplies()}
						>Απαντήσεις μου{#if replyNotifications.unread > 0}<span class="reply-count"
								>{replyNotifications.unread}</span
							>{/if}</button
					>
				</nav>
			{/if}

			{#if moderation}
				<ModerationPanel {reduceAnimations} {locale} />
			{:else if replies}
				<ReplyInbox {locale} onSelect={onOpenDiscussion} />
			{:else if discussions}
				<DiscussionsList
					{locale}
					onSelect={(discussion) =>
						onOpenDiscussion({
							topic: discussion.topic,
							externalId: discussion.external_id,
							title: discussion.item_title,
							topicDisplayName: discussion.topic_display_name,
							url: discussion.item_url
						})}
				/>
			{:else if open}
				{#key `${open.topic}/${open.externalId}`}
					<CommentsThread
						bind:this={thread}
						comments={threadState?.comments ?? []}
						loading={threadState?.loading ?? false}
						error={threadState?.error ?? null}
						{reduceAnimations}
						{locale}
						topic={open.topic}
						externalId={open.externalId}
						focusId={open.commentId}
						onReply={(comment) => {
							commentsStore.replyTo(comment);
							composer?.focus();
						}}
					/>
					<CommentComposer
						bind:this={composer}
						threadKey={`${open.topic}/${open.externalId}`}
						onSubmitted={handleSubmitted}
					/>
				{/key}
			{/if}
		</aside>
	</div>
{/if}

<style>
	.thread-navigation {
		display: flex;
		flex-wrap: wrap;
		gap: 0 8px;
	}
	.discussion-tabs {
		display: flex;
		gap: 6px;
		padding: 8px 16px;
		border-bottom: 1px solid var(--color-divider);
	}
	.discussion-tabs button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 0;
		border-radius: 6px;
		min-height: 44px;
		padding: 6px 10px;
		background: transparent;
		color: var(--color-action-text);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.discussion-tabs button[aria-pressed='true'] {
		background: var(--color-secondary-hover);
		font-weight: 600;
	}
	.discussion-tabs button:focus-visible {
		outline: 2px solid var(--color-cerulean);
	}
	.reply-count {
		border-radius: 10px;
		min-width: 18px;
		padding: 1px 5px;
		color: var(--color-background);
		background: var(--color-action-text);
		font-size: 11px;
	}
	.discussions-back {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin: 0 0 8px;
		border: 0;
		background: transparent;
		padding: 0;
		color: var(--color-cerulean);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.comments-scrim {
		position: fixed;
		z-index: var(--comments-rail-scrim-z);
		inset: 0;
		background: var(--color-modal-backdrop);
	}

	.comments-rail {
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		border-left: 1px solid var(--color-border);
		background: var(--color-surface);
		color: var(--color-text);
	}

	.comments-rail-slot {
		z-index: var(--comments-rail-z);
		flex: 0 0 auto;
		width: var(--comments-rail-width);
		height: 100dvh;
		overflow: clip;
	}

	.comments-rail-slot-push {
		position: sticky;
		top: 0;
	}

	.comments-rail-slot-overlay {
		position: fixed;
		inset: 0 0 0 auto;
		box-shadow: 0 8px 32px var(--color-modal-shadow);
	}

	.comments-rail-slot-sheet {
		position: fixed;
		inset: auto 0 0;
		width: 100%;
		height: min(86dvh, calc(100dvh - 24px));
		border-radius: 12px 12px 0 0;
		transition: translate 200ms ease;
		box-shadow: 0 8px 32px var(--color-modal-shadow);
	}

	.comments-rail {
		width: var(--comments-rail-width);
		height: 100%;
		min-height: 0;
	}

	.comments-rail-sheet {
		width: 100%;
		border-top: 1px solid var(--color-border);
		border-left: 0;
	}

	.comments-rail-header {
		flex: 0 0 auto;
		display: flex;
		align-items: flex-start;
		gap: 8px;
		border-bottom: 1px solid var(--color-border);
		padding: 12px 16px;
	}

	.comments-rail-dragging {
		transition: none;
	}

	.comments-rail-grip {
		position: absolute;
		top: 0;
		left: 50%;
		display: grid;
		place-items: center;
		border: 0;
		background: transparent;
		width: 72px;
		height: 24px;
		padding: 0;
		transform: translateX(-50%);
		touch-action: none;
		cursor: grab;
	}

	.comments-rail-grip::before {
		content: '';
		border-radius: 999px;
		background: var(--color-text-muted);
		width: 36px;
		height: 4px;
	}

	.comments-rail-heading {
		flex: 1 1 auto;
		min-width: 0;
	}

	.comments-rail-title {
		display: -webkit-box;
		overflow: hidden;
		margin: 0;
		font-size: 14px;
		line-height: 1.35;
		font-weight: 600;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		line-clamp: 3;
	}

	.comments-rail-title:focus-visible {
		outline-offset: 2px;
	}

	.comments-rail-meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		margin: 4px 0 0;
		color: var(--color-text-muted);
		font-size: 12px;
		line-height: 16px;
	}

	.comments-rail-count {
		font-variant-numeric: tabular-nums;
	}

	.comments-rail-source {
		display: inline-flex;
		color: var(--color-cerulean);
	}

	.comments-rail-source:hover {
		color: var(--color-tropical-teal);
	}

	.comments-rail-close {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		margin: -6px -8px 0 0;
		border-radius: 6px;
		flex: 0 0 auto;
		border: 0;
		background: transparent;
		padding: 0;
		color: var(--color-cerulean);
		cursor: pointer;
	}

	.comments-rail-close:hover {
		background: var(--color-secondary-hover);
		color: var(--color-tropical-teal);
	}

	.comments-rail-sheet .comments-rail-header {
		padding-top: 28px;
	}
</style>
