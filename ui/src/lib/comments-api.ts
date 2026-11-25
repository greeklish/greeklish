import { env } from '$env/dynamic/public';

/** A proof-of-work challenge, in the Altcha wire format the backend issues. */
export type CaptchaChallenge = {
	algorithm: 'SHA-256';
	challenge: string;
	salt: string;
	maxnumber: number;
	signature: string;
};

export type CaptchaSolution = CaptchaChallenge & { number: number };

export type GuestComment = {
	id: string;
	author_display_name: string;
	body: string;
	created_at: string;
	status: 'pending' | 'approved';
	auto_approved: boolean;
	own: boolean;
	reply_to_comment_id?: string | null;
};

export type ListCommentsResponse = {
	topic: string;
	external_id: string;
	guest_comment_count: number;
	comments: GuestComment[];
	item_title?: string;
	item_url?: string;
};

export type CommentCountsResponse = {
	topic: string;
	counts: Record<string, number>;
};

export type Discussion = {
	topic: string;
	topic_display_name: string;
	external_id: string;
	item_title: string;
	item_url: string;
	guest_comment_count: number;
	last_comment_at: string;
};

export type DiscussionsResponse = {
	discussions: Discussion[];
	next_cursor: string | null;
};

export type CreateCommentRequest = {
	topic: string;
	external_id: string;
	body: string;
	display_name?: string;
	captcha: CaptchaSolution;
	reply_to_comment_id?: string;
};

export type CreateCommentResponse = {
	next_comment_in_secs?: number;
	comment: GuestComment;
	guest_comment_count: number;
	author_token?: string;
};

export type ModerationStats = {
	pending_suggestions?: number;
	pending: number;
	approved: number;
	rejected: number;
	spam: number;
	hidden: number;
	auto_approved: number;
};

export type ModerationQueueItem = {
	id: string;
	body: string;
	author_id: string;
	author_display_name: string;
	author_approved_count: number;
	author_trust_state: string;
	author_fingerprint: string | null;
	status: string;
	auto_approved: boolean;
	hold_reason: string | null;
	created_at: string;
	topic: string;
	topic_display_name: string;
	external_id: string;
	item_title: string;
	item_url: string;
};

export type ModerationQueueResponse = {
	comments: ModerationQueueItem[];
	next_cursor: string | null;
};

export type ModerationLogItem = {
	id: string;
	comment_id: string | null;
	author_id: string | null;
	action: string;
	actor: 'system' | 'moderator';
	reason: string | null;
	author_approved_count: number | null;
	recorded_at: string;
	body: string | null;
	author_display_name: string | null;
	status: string | null;
	topic: string | null;
	external_id: string | null;
	item_title: string | null;
};

export type ModerationLogResponse = {
	events: ModerationLogItem[];
	next_cursor: string | null;
};

export type ModerationDecision = 'approve' | 'reject' | 'spam' | 'hide' | 'restore';
export type TrustAction = 'revoke' | 'restore' | 'ban' | 'unban';

/**
 * Error carrying the backend's machine-readable `code`.
 *
 * Callers branch on `code`, never on the message text — the message is Greek user-facing copy and
 * may change.
 */
export class CommentsApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
		readonly retryAfterSeconds?: number,
		readonly retryScope?: string
	) {
		super(message);
		this.name = 'CommentsApiError';
	}
}

/**
 * Resolves the backend's HTTP origin.
 *
 * Both Vite and the production proxy serve /api on the UI origin. An explicit override is
 * available for installations with a separate HTTP endpoint.
 */
export function resolveApiBaseUrl() {
	if (env.PUBLIC_API_URL) return env.PUBLIC_API_URL.replace(/\/$/, '');

	// Vite proxies /api in development; production serves it through Caddy on the same origin.
	return window.location.origin;
}

const GUEST_TOKEN_HEADER = 'X-Guest-Token';
const GENERIC_ERROR = 'Κάτι πήγε στραβά. Δοκίμασε ξανά.';

type RequestOptions = {
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
	body?: unknown;
	guestToken?: string | null;
	signal?: AbortSignal;
};

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const { method = 'GET', body, guestToken, signal } = options;
	const headers = new Headers();

	if (body !== undefined) headers.set('Content-Type', 'application/json');
	if (guestToken) headers.set(GUEST_TOKEN_HEADER, guestToken);

	let response: Response;

	try {
		response = await fetch(`${resolveApiBaseUrl()}${path}`, {
			method,
			headers,
			// The moderator session is an HttpOnly cookie; without this it is never sent.
			credentials: 'same-origin',
			body: body === undefined ? undefined : JSON.stringify(body),
			signal
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') throw error;

		throw new CommentsApiError('network_error', 'Δεν υπάρχει σύνδεση. Δοκίμασε ξανά.', 0);
	}

	if (response.status === 204) return undefined as T;

	const payload = await response.json().catch(() => null);

	if (!response.ok) {
		const code = typeof payload?.code === 'string' ? payload.code : 'unknown_error';
		const message = typeof payload?.message === 'string' ? payload.message : GENERIC_ERROR;
		const headerRetry = Number(response.headers.get('retry-after'));
		const retryAfter = Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : undefined;

		throw new CommentsApiError(
			code,
			message,
			response.status,
			typeof payload?.retry_after_secs === 'number' ? payload.retry_after_secs : retryAfter,
			payload?.retry_scope
		);
	}

	return payload as T;
}

export function fetchCaptchaChallenge(signal?: AbortSignal) {
	return request<CaptchaChallenge>('/api/captcha/challenge', { signal });
}

export function fetchItemComments(
	topic: string,
	externalId: string,
	guestToken?: string | null,
	signal?: AbortSignal
) {
	const path = `/api/comments/${encodeURIComponent(topic)}/${encodeURIComponent(externalId)}`;

	return request<ListCommentsResponse>(path, { guestToken, signal });
}

export function fetchTopicCommentCounts(topic: string, signal?: AbortSignal) {
	return request<CommentCountsResponse>(`/api/comments/counts/${encodeURIComponent(topic)}`, {
		signal
	});
}

export function fetchDiscussions(cursor?: string | null, signal?: AbortSignal) {
	const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
	return request<DiscussionsResponse>(`/api/comments/discussions${query}`, { signal });
}

export function createComment(input: CreateCommentRequest, guestToken?: string | null) {
	return request<CreateCommentResponse>('/api/comments', {
		method: 'POST',
		body: input,
		guestToken
	});
}

export function createModeratorSession(password: string) {
	return request<{ expires_at: string }>('/api/moderation/session', {
		method: 'POST',
		body: { password }
	});
}

export function deleteModeratorSession() {
	return request<void>('/api/moderation/session', { method: 'DELETE' });
}

export function fetchModerationStats(signal?: AbortSignal) {
	return request<ModerationStats>('/api/moderation/stats', { signal });
}

export type ModerationFilters = { topic?: string; author_id?: string; author?: string; q?: string };
export type ModerationFeed = { slug: string; display_name: string };
export function fetchModerationFeeds() {
	return request<ModerationFeed[]>('/api/moderation/feeds');
}
function filterQuery(params: ModerationFilters) {
	const query = new URLSearchParams();
	for (const key of ['topic', 'author_id', 'author', 'q'] as const) {
		const value = params[key]?.trim();
		if (value) query.set(key, value);
	}
	return query;
}

export function fetchModerationQueue(
	params: ModerationFilters & { status?: string; cursor?: string | null; limit?: number } = {},
	signal?: AbortSignal
) {
	const query = filterQuery(params);
	if (params.status) query.set('status', params.status);
	if (params.cursor) query.set('cursor', params.cursor);
	if (params.limit) query.set('limit', String(params.limit));

	const suffix = query.size ? `?${query}` : '';

	return request<ModerationQueueResponse>(`/api/moderation/queue${suffix}`, { signal });
}

export function fetchModerationLog(
	params: ModerationFilters & {
		action?: string;
		actor?: string;
		cursor?: string | null;
		limit?: number;
	} = {},
	signal?: AbortSignal
) {
	const query = filterQuery(params);
	if (params.action) query.set('action', params.action);
	if (params.actor) query.set('actor', params.actor);
	if (params.cursor) query.set('cursor', params.cursor);
	if (params.limit) query.set('limit', String(params.limit));

	const suffix = query.size ? `?${query}` : '';

	return request<ModerationLogResponse>(`/api/moderation/log${suffix}`, { signal });
}

export function decideComment(commentId: string, action: ModerationDecision, reason?: string) {
	return request<{ id: string; status: string; guest_comment_count: number }>(
		`/api/moderation/comments/${encodeURIComponent(commentId)}/decision`,
		{ method: 'POST', body: { action, reason } }
	);
}

export function setAuthorTrust(authorId: string, action: TrustAction) {
	return request<void>(`/api/moderation/authors/${encodeURIComponent(authorId)}/trust`, {
		method: 'POST',
		body: { action }
	});
}

export type ReplyNotification = {
	id: string;
	reply_id: string;
	parent_id: string;
	topic: string;
	external_id: string;
	item_title: string;
	item_url: string;
	author_display_name: string;
	body: string;
	created_at: string;
	unread: boolean;
};
export type ReplyInboxResponse = {
	replies: ReplyNotification[];
	unread_count: number;
	next_cursor: string | null;
};
export type PushConfiguration = { enabled: boolean; public_key: string | null };
export type RegisteredPushSubscription = { id: string; watched_comment_ids: string[] };

export function fetchReplies(guestToken: string, cursor?: string | null, signal?: AbortSignal) {
	const suffix = cursor ? `?${new URLSearchParams({ cursor })}` : '';
	return request<ReplyInboxResponse>(`/api/replies${suffix}`, { guestToken, signal });
}
export function markRepliesRead(guestToken: string, id?: string) {
	return request<void>(id ? `/api/replies/${encodeURIComponent(id)}/read` : '/api/replies/read', {
		method: 'POST',
		body: {},
		guestToken
	});
}
export function fetchPushConfiguration(signal?: AbortSignal) {
	return request<PushConfiguration>('/api/push/config', { signal });
}
export function registerPushSubscription(guestToken: string, subscription: PushSubscriptionJSON) {
	return request<RegisteredPushSubscription>('/api/push/subscriptions', {
		method: 'POST',
		body: subscription,
		guestToken
	});
}
export function fetchPushSubscription(guestToken: string, id: string) {
	return request<RegisteredPushSubscription>(`/api/push/subscriptions/${encodeURIComponent(id)}`, {
		guestToken
	});
}
export function deletePushSubscription(guestToken: string, id: string) {
	return request<void>(`/api/push/subscriptions/${encodeURIComponent(id)}`, {
		method: 'DELETE',
		body: {},
		guestToken
	});
}
export function setReplyWatch(
	guestToken: string,
	subscriptionId: string,
	commentId: string,
	enabled: boolean
) {
	return request<void>(
		`/api/push/subscriptions/${encodeURIComponent(subscriptionId)}/watches/${encodeURIComponent(commentId)}`,
		{
			method: enabled ? 'PUT' : 'DELETE',
			body: {},
			guestToken
		}
	);
}
