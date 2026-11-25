import { replaceState } from '$app/navigation';
import { page } from '$app/state';
import { SvelteMap } from 'svelte/reactivity';
import {
	CommentsApiError,
	createComment,
	fetchItemComments,
	fetchTopicCommentCounts,
	type GuestComment
} from '$lib/comments-api';
import { CaptchaController } from '$lib/captcha-controller.svelte';
import { parseCommentHash } from '$lib/comment-links';
import { LocalStorage } from '$lib/storage.svelte';

const AUTHOR_TOKEN_KEY = 'guest-comment-author-token';
const DISPLAY_NAME_KEY = 'guest-comment-display-name';

const isString = (value: unknown): value is string => typeof value === 'string';

const authorTokenStorage = new LocalStorage<string>(AUTHOR_TOKEN_KEY, '', isString);
const displayNameStorage = new LocalStorage<string>(DISPLAY_NAME_KEY, '', isString);

export type OpenThread = {
	topic: string;
	externalId: string;
	title: string;
	topicDisplayName: string;
	url: string;
	commentId?: string;
};

export type ThreadState = {
	comments: GuestComment[];
	count: number;
	loading: boolean;
	error: string | null;
};

function threadKey(topic: string, externalId: string) {
	return `${topic}/${externalId}`;
}

/**
 * Single reactive owner of comment UI state.
 *
 * Follows the `storage.svelte.ts` precedent — a class with `$state` fields, exported as one
 * module-level instance — because this project has no store module or context for app state and
 * prop-drilling this much state through `FeedPanel` would be worse.
 */
class CommentsStore {
	/** The thread currently shown in the rail, or `null` when it is closed. */
	open = $state<OpenThread | null>(null);
	/** Per-item threads, keyed `topic/external_id`. */
	threads = new SvelteMap<string, ThreadState>();
	/** Approved counts for feed badges, keyed the same way. */
	counts = new SvelteMap<string, number>();

	submitting = $state(false);
	submitError = $state<string | null>(null);
	retryUntil = $state(0);
	itemRetryUntil = new SvelteMap<string, number>();
	retryMessage = $state('');

	retryDeadline(key: string) {
		return Math.max(this.retryUntil, this.itemRetryUntil.get(key) ?? 0);
	}

	#recordRetry(error: CommentsApiError, key?: string) {
		if (error.code !== 'rate_limited' || !error.retryAfterSeconds) return false;
		const deadline = Date.now() + error.retryAfterSeconds * 1000;
		if (error.retryScope === 'item' && key) this.itemRetryUntil.set(key, deadline);
		else this.retryUntil = deadline;
		this.retryMessage = error.message;
		this.submitError = null;
		return true;
	}
	/** Set after a comment is held, so the rail can explain it once. */
	lastHeld = $state(false);

	#captcha = new CaptchaController();
	get captchaState() {
		return this.#captcha.state;
	}
	get captchaProgress() {
		return this.#captcha.progress;
	}

	moderatorActive = $state(false);
	moderationOpen = $state(false);
	discussionsOpen = $state(false);
	repliesOpen = $state(false);
	replyTargets = new SvelteMap<string, GuestComment>();
	lastSubmitted = $state<{ threadKey: string; commentId: string } | null>(null);
	/** Keep drafts separate when switching articles or closing the rail. */
	drafts = new Map<string, string>();
	opener: HTMLElement | null = null;
	moderationPending = $state(0);

	#countedTopics = new Set<string>();

	get authorToken() {
		return authorTokenStorage.current || null;
	}

	rememberAuthorToken(token: string) {
		authorTokenStorage.current = token;
	}

	get displayName() {
		return displayNameStorage.current;
	}

	set displayName(value: string) {
		displayNameStorage.current = value;
	}

	threadFor(topic: string, externalId: string): ThreadState {
		return (
			this.threads.get(threadKey(topic, externalId)) ?? {
				comments: [],
				count: this.counts.get(threadKey(topic, externalId)) ?? 0,
				loading: false,
				error: null
			}
		);
	}

	countFor(topic: string, externalId: string) {
		return this.counts.get(threadKey(topic, externalId)) ?? 0;
	}

	isOpenFor(topic: string, externalId: string) {
		return this.open?.topic === topic && this.open?.externalId === externalId;
	}

	openThread(thread: OpenThread) {
		if (
			typeof document !== 'undefined' &&
			document.activeElement instanceof HTMLElement &&
			!document.activeElement.closest('#comments-rail')
		) {
			this.opener = document.activeElement;
		}
		this.moderationOpen = false;
		this.discussionsOpen = false;
		this.repliesOpen = false;
		this.open = thread;
		this.submitError = null;
		this.lastHeld = false;
		void this.loadThread(thread.topic, thread.externalId);
	}

	openDiscussions() {
		this.close();
		this.opener = document.querySelector<HTMLElement>('.discussions-button');
		this.discussionsOpen = true;
	}

	openReplies() {
		this.close();
		this.opener = document.querySelector<HTMLElement>('.replies-button');
		this.repliesOpen = true;
	}

	replyTo(comment: GuestComment) {
		if (!this.open || comment.status !== 'approved') return;
		this.replyTargets.set(threadKey(this.open.topic, this.open.externalId), comment);
		this.submitError = null;
	}

	openModeration() {
		this.close();
		this.opener = document.querySelector<HTMLElement>(
			'.moderation-button, .header-controls button'
		);
		this.moderationOpen = true;
	}

	close() {
		this.open = null;
		this.moderationOpen = false;
		this.discussionsOpen = false;
		this.repliesOpen = false;
		// Parsed rather than prefix-matched, so the fragment clears whether it arrived literal from a
		// shared link or percent-encoded from the URL parser.
		if (
			typeof window !== 'undefined' &&
			(parseCommentHash(window.location.hash)?.length ?? 0) > 1
		) {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- Preserve the current, already-resolved URL while clearing its fragment.
			replaceState(window.location.pathname + window.location.search, page.state);
		}
		this.submitError = null;
	}

	async loadThread(topic: string, externalId: string, force = false) {
		const key = threadKey(topic, externalId);
		const existing = this.threads.get(key);

		if (existing?.loading) return;
		if (existing && !force && existing.comments.length) {
			// Still revalidate in the background so an approved comment shows up on reopen.
			void this.#fetchThread(topic, externalId);
			return;
		}

		this.threads.set(key, {
			comments: existing?.comments ?? [],
			count: existing?.count ?? this.counts.get(key) ?? 0,
			loading: true,
			error: null
		});

		await this.#fetchThread(topic, externalId);
	}

	async #fetchThread(topic: string, externalId: string) {
		const key = threadKey(topic, externalId);

		try {
			const response = await fetchItemComments(topic, externalId, this.authorToken);

			this.threads.set(key, {
				comments: response.comments,
				count: response.guest_comment_count,
				loading: false,
				error: null
			});
			this.counts.set(key, response.guest_comment_count);
			if (this.isOpenFor(topic, externalId) && this.open) {
				this.open = {
					...this.open,
					title: response.item_title || this.open.title,
					url: response.item_url || this.open.url
				};
			}
		} catch (error) {
			const message =
				error instanceof CommentsApiError
					? error.message
					: 'Δεν ήταν δυνατή η φόρτωση των σχολίων.';

			this.threads.set(key, {
				comments: this.threads.get(key)?.comments ?? [],
				count: this.threads.get(key)?.count ?? 0,
				loading: false,
				error: message
			});
		}
	}

	/** Loads the per-item badge counts for one topic, once per session. */
	async loadTopicCounts(topic: string) {
		if (this.#countedTopics.has(topic)) return;
		this.#countedTopics.add(topic);

		try {
			const response = await fetchTopicCommentCounts(topic);

			for (const [externalId, count] of Object.entries(response.counts)) {
				this.counts.set(threadKey(topic, externalId), count);
			}
		} catch {
			// Badge counts are decoration; a failure must never break the feed.
			this.#countedTopics.delete(topic);
		}
	}

	/**
	 * Starts solving a challenge in the background.
	 *
	 * Called when the composer gains focus, not on submit, so the work is already done by the time
	 * the visitor presses send. That is what makes the check feel like nothing happened.
	 */
	async prepareCaptcha(): Promise<void> {
		if (Date.now() < this.retryUntil) return;
		try {
			await this.#captcha.prepare();
		} catch (error) {
			if (error instanceof CommentsApiError && this.#recordRetry(error)) this.#captcha.invalidate();
		}
	}

	/**
	 * Submits a comment, inserting it optimistically.
	 *
	 * On failure the caller keeps the draft: `submitError` is set and nothing is added to the
	 * thread, so the composer can restore exactly what the visitor typed.
	 */
	async submit(body: string, displayName: string): Promise<boolean> {
		const thread = this.open;
		const replyTarget = thread
			? this.replyTargets.get(threadKey(thread.topic, thread.externalId))
			: undefined;
		if (
			!thread ||
			this.submitting ||
			Date.now() < this.retryDeadline(threadKey(thread.topic, thread.externalId))
		)
			return false;

		this.submitting = true;
		this.submitError = null;
		this.lastHeld = false;

		try {
			if (!this.#captcha.solution) {
				await this.prepareCaptcha();
			}

			const solution = this.#captcha.solution;
			if (!solution) {
				if (Date.now() >= this.retryUntil)
					this.submitError = 'Ο έλεγχος ασφαλείας απέτυχε. Δοκίμασε ξανά.';
				return false;
			}

			const trimmedName = displayName.trim();
			const response = await createComment(
				{
					topic: thread.topic,
					external_id: thread.externalId,
					body,
					display_name: trimmedName || undefined,
					reply_to_comment_id: replyTarget?.id,
					captcha: solution
				},
				this.authorToken
			);

			this.retryUntil = Date.now() + (response.next_comment_in_secs ?? 0) * 1000;
			this.retryMessage = '';
			// Each successful submission consumes its challenge.
			this.#captcha.invalidate();

			if (response.author_token) {
				authorTokenStorage.current = response.author_token;
			}

			if (trimmedName) displayNameStorage.current = trimmedName;

			const key = threadKey(thread.topic, thread.externalId);
			const existing = this.threads.get(key);

			this.threads.set(key, {
				comments: [
					...(existing?.comments ?? []).filter((entry) => entry.id !== response.comment.id),
					response.comment
				],
				count: response.guest_comment_count,
				loading: false,
				error: null
			});
			this.counts.set(key, response.guest_comment_count);
			if (this.isOpenFor(thread.topic, thread.externalId)) {
				this.lastHeld = response.comment.status === 'pending';
			}
			if (this.replyTargets.get(key)?.id === replyTarget?.id) this.replyTargets.delete(key);
			this.lastSubmitted = { threadKey: key, commentId: response.comment.id };

			// Warm the next one straight away so a second comment is just as instant.
			void this.prepareCaptcha();

			return true;
		} catch (error) {
			if (error instanceof CommentsApiError) {
				if (!this.#recordRetry(error, threadKey(thread.topic, thread.externalId)))
					this.submitError = error.message;

				// A spent or expired challenge must be replaced before the next attempt.
				if (error.code === 'bad_request') {
					this.#captcha.invalidate();
					void this.prepareCaptcha();
				}
			} else {
				this.submitError = 'Κάτι πήγε στραβά. Δοκίμασε ξανά.';
			}

			return false;
		} finally {
			this.submitting = false;
		}
	}

	/** Applies a live `guest_comment_created` push. */
	applyRemoteComment(topic: string, externalId: string, comment: GuestComment, count: number) {
		const key = threadKey(topic, externalId);
		this.counts.set(key, count);

		const existing = this.threads.get(key);
		if (!existing) return;
		const previous = existing.comments.find((entry) => entry.id === comment.id);
		const updated = { ...comment, own: previous?.own || comment.own };

		this.threads.set(key, {
			...existing,
			count,
			comments: [...existing.comments.filter((entry) => entry.id !== comment.id), updated].sort(
				(left, right) => left.created_at.localeCompare(right.created_at)
			)
		});
	}

	/** Applies a live `guest_comment_removed` push. */
	removeRemoteComment(topic: string, externalId: string, commentId: string, count: number) {
		const key = threadKey(topic, externalId);
		this.counts.set(key, count);

		const existing = this.threads.get(key);
		if (!existing) return;

		this.threads.set(key, {
			...existing,
			count,
			comments: existing.comments.filter((entry) => entry.id !== commentId)
		});
	}

	setCount(topic: string, externalId: string, count: number) {
		const key = threadKey(topic, externalId);
		this.counts.set(key, count);
		const existing = this.threads.get(key);
		if (existing) this.threads.set(key, { ...existing, count });
	}

	/** Forgets the local author identity, discarding accumulated trust. */
	resetIdentity() {
		authorTokenStorage.current = '';
	}

	destroy() {
		this.#captcha.destroy();
	}
}

export const commentsStore = new CommentsStore();
