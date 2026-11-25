import { fetchCaptchaChallenge, type CaptchaSolution } from '$lib/comments-api';

/** Each composer owns its challenge; only the worker/protocol implementation is shared. */
export class CaptchaController {
	state = $state<'idle' | 'solving' | 'ready' | 'error'>('idle');
	progress = $state(0);
	#solved: { solution: CaptchaSolution; at: number } | null = null;
	#pending: Promise<void> | null = null;
	#controller: AbortController | null = null;
	get solution() {
		return this.#solved && Date.now() - this.#solved.at < 4 * 60_000 ? this.#solved.solution : null;
	}
	prepare(): Promise<void> {
		if (this.#pending) return this.#pending;
		if (this.solution) return Promise.resolve();
		const controller = new AbortController();
		this.#controller = controller;
		this.state = 'solving';
		this.progress = 0;
		const pending = this.#solve(controller.signal)
			.catch((error) => {
				this.#solved = null;
				this.state = controller.signal.aborted ? 'idle' : 'error';
				throw error;
			})
			.finally(() => {
				if (this.#pending === pending) this.#pending = null;
				if (this.#controller === controller) this.#controller = null;
			});
		this.#pending = pending;
		return pending;
	}
	async #solve(signal: AbortSignal) {
		const challenge = await fetchCaptchaChallenge(signal);
		signal.throwIfAborted();
		const worker = new Worker('/pow-worker.js');
		try {
			const number = await new Promise<number>((resolve, reject) => {
				const abort = () => finish(() => reject(new DOMException('Cancelled', 'AbortError')));
				const timer = setTimeout(
					() => finish(() => reject(new Error('Security check timed out'))),
					60_000
				);
				const finish = (callback: () => void) => {
					clearTimeout(timer);
					signal.removeEventListener('abort', abort);
					callback();
				};
				signal.addEventListener('abort', abort, { once: true });
				worker.onerror = () => finish(() => reject(new Error('Security check failed')));
				worker.onmessage = ({ data }) => {
					if (data?.type === 'progress')
						this.progress = Math.min(1, data.checked / Math.max(1, data.maxnumber));
					else if (data?.id === 1) {
						finish(() =>
							data.type === 'solved'
								? resolve(data.number)
								: reject(new Error('Security check failed'))
						);
					}
				};
				worker.postMessage({ type: 'solve', id: 1, ...challenge });
			});
			signal.throwIfAborted();
			this.#solved = { solution: { ...challenge, number }, at: Date.now() };
			this.state = 'ready';
		} finally {
			worker.terminate();
		}
	}
	invalidate() {
		this.#solved = null;
		this.state = 'idle';
	}
	destroy() {
		this.#controller?.abort();
		this.invalidate();
	}
}
