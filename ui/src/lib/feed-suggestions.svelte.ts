import { CaptchaController } from '$lib/captcha-controller.svelte';
import { CommentsApiError } from '$lib/comments-api';
import { commentsStore } from '$lib/comments-store.svelte';
import { submitFeedSuggestion, type SuggestionDraft } from '$lib/feed-suggestions-api';
const empty = (): SuggestionDraft => ({ url: '', name: '', explanation: '', email: '' });
class FeedSuggestions {
	draft = $state(empty());
	submitting = $state(false);
	success = $state(false);
	error = $state('');
	retryUntil = $state(0);
	captcha = new CaptchaController();
	async prepare() {
		if (Date.now() < this.retryUntil) return;
		try {
			await this.captcha.prepare();
		} catch (error) {
			this.#failure(error);
		}
	}
	#failure(error: unknown) {
		if (error instanceof DOMException && error.name === 'AbortError') return;
		this.error =
			error instanceof CommentsApiError
				? error.message
				: 'Δεν ήταν δυνατή η υποβολή. Η πρότασή σου διατηρείται. Δοκίμασε ξανά.';
		if (error instanceof CommentsApiError && error.retryAfterSeconds)
			this.retryUntil = Date.now() + error.retryAfterSeconds * 1000;
	}
	async submit() {
		if (this.submitting || Date.now() < this.retryUntil) return;
		this.submitting = true;
		this.error = '';
		try {
			await this.captcha.prepare();
			const solution = this.captcha.solution;
			if (!solution) throw new Error('No challenge');
			const response = await submitFeedSuggestion(
				{ ...this.draft },
				solution,
				commentsStore.authorToken
			);
			if (response.author_token) commentsStore.rememberAuthorToken(response.author_token);
			this.retryUntil = Date.now() + response.next_submission_in_secs * 1000;
			this.captcha.invalidate();
			this.draft = empty();
			this.success = true;
		} catch (error) {
			this.#failure(error);
			if (error instanceof CommentsApiError && error.code === 'bad_request')
				this.captcha.invalidate();
		} finally {
			this.submitting = false;
		}
	}
}
export const feedSuggestions = new FeedSuggestions();
