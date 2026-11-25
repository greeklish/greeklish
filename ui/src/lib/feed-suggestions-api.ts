import { request, type CaptchaSolution } from '$lib/comments-api';
export type SuggestionStatus = 'pending' | 'added' | 'rejected' | 'spam';
export type SuggestionDraft = { url: string; name: string; explanation: string; email: string };
export type FeedSuggestion = {
	url: string;
	name: string | null;
	explanation: string | null;
	email: string | null;
	id: string;
	author_id: string;
	status: SuggestionStatus;
	created_at: string;
	updated_at: string;
};
export const SUGGESTION_STATUSES: Record<SuggestionStatus, string> = {
	pending: 'Σε αναμονή',
	added: 'Προστέθηκε',
	rejected: 'Απορρίφθηκε',
	spam: 'Spam'
};
export function submitFeedSuggestion(
	draft: SuggestionDraft,
	captcha: CaptchaSolution,
	guestToken: string | null
) {
	return request<{
		id: string;
		status: 'pending';
		author_token?: string;
		next_submission_in_secs: number;
	}>('/api/feed-suggestions', { method: 'POST', body: { ...draft, captcha }, guestToken });
}
export function fetchFeedSuggestions(status: string, cursor: string | null, signal: AbortSignal) {
	const query = new URLSearchParams({ status });
	if (cursor) query.set('cursor', cursor);
	return request<{ suggestions: FeedSuggestion[]; next_cursor: string | null; pending: number }>(
		`/api/moderation/feed-suggestions?${query}`,
		{ signal }
	);
}
export function decideFeedSuggestion(id: string, status: SuggestionStatus) {
	return request<void>(`/api/moderation/feed-suggestions/${encodeURIComponent(id)}/status`, {
		method: 'POST',
		body: { status }
	});
}
