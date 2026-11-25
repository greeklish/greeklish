import { SvelteSet } from 'svelte/reactivity';
import {
	CommentsApiError,
	fetchReplies,
	markRepliesRead,
	fetchPushConfiguration,
	fetchPushSubscription,
	registerPushSubscription,
	deletePushSubscription,
	setReplyWatch,
	type ReplyNotification,
	type RegisteredPushSubscription
} from '$lib/comments-api';

const SUBSCRIPTION_KEY = 'guest-reply-push-subscription';

function message(error: unknown, fallback: string) {
	return error instanceof CommentsApiError ? error.message : fallback;
}

class ReplyNotifications {
	replies = $state<ReplyNotification[]>([]);
	unread = $state(0);
	cursor = $state<string | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	newReplies = $state(false);
	pushEnabled = $state(false);
	pushReady = $state(false);
	permission = $state<NotificationPermission>('default');
	needsHomeScreen = $state(false);
	supported = $state(false);
	busy = $state<string | null>(null);
	pushError = $state<string | null>(null);
	lastAction = $state<string | null>(null);
	deviceRegistered = $state(false);
	watched = new SvelteSet<string>();
	#token: string | null = null;
	#subscriptionId: string | null = null;
	#publicKey: string | null = null;
	#registration: ServiceWorkerRegistration | null = null;
	#nativeSubscription: PushSubscription | null = null;
	#deviceVersion = 0;
	#abort: AbortController | null = null;
	#configurationAbort: AbortController | null = null;
	#mounted = false;
	#paginated = false;

	initialize() {
		this.#mounted = true;
		if (this.#token) void this.load();
		const ios =
			/iPad|iPhone|iPod/.test(navigator.userAgent) ||
			(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
		const pushAvailable =
			'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
		this.needsHomeScreen =
			ios &&
			!pushAvailable &&
			!window.matchMedia('(display-mode: standalone)').matches &&
			!(navigator as Navigator & { standalone?: boolean }).standalone;
		this.supported = window.isSecureContext && pushAvailable;
		if ('Notification' in window) this.permission = Notification.permission;
		this.#configurationAbort = new AbortController();
		void this.#configure(this.#configurationAbort.signal);
		const refresh = () => {
			if (document.visibilityState !== 'visible') return;
			if ('Notification' in window) this.permission = Notification.permission;
			void this.load(false, true);
			void this.#restoreDevice();
		};
		const interval = window.setInterval(() => {
			if (document.visibilityState === 'visible') void this.load(false, true);
		}, 60_000);
		window.addEventListener('focus', refresh);
		document.addEventListener('visibilitychange', refresh);
		return () => {
			this.#mounted = false;
			this.#abort?.abort();
			this.#configurationAbort?.abort();
			clearInterval(interval);
			window.removeEventListener('focus', refresh);
			document.removeEventListener('visibilitychange', refresh);
		};
	}

	async #configure(signal: AbortSignal) {
		try {
			const configuration = await fetchPushConfiguration(signal);
			if (signal.aborted) return;
			this.pushEnabled = configuration.enabled && !!configuration.public_key;
			this.#publicKey = configuration.public_key;
			if (!this.pushEnabled || !this.supported) return;
			const registration = await navigator.serviceWorker.register('/reply-notifications-sw.js', {
				scope: '/',
				updateViaCache: 'none'
			});
			if (signal.aborted) return;
			if (!registration.active) {
				const worker = registration.installing ?? registration.waiting;
				if (!worker) throw new Error('Service worker unavailable');
				await new Promise<void>((resolve, reject) => {
					const cleanup = () => {
						clearTimeout(timeout);
						worker.removeEventListener('statechange', changed);
					};
					const changed = () => {
						if (worker.state === 'activated') {
							cleanup();
							resolve();
						} else if (worker.state === 'redundant') {
							cleanup();
							reject(new Error('Service worker unavailable'));
						}
					};
					const timeout = setTimeout(() => {
						cleanup();
						reject(new Error('Service worker timeout'));
					}, 15_000);
					worker.addEventListener('statechange', changed);
					changed();
				});
			}
			if (signal.aborted) return;
			this.#registration = registration;
			this.#nativeSubscription = await registration.pushManager.getSubscription();
			this.pushReady = true;
			await this.#restoreDevice();
		} catch {
			// Reply inbox remains available even when push is unsupported, blocked, or offline.
			if (!signal.aborted && this.pushEnabled && this.supported)
				this.pushError =
					'Δεν ήταν δυνατή η προετοιμασία ειδοποιήσεων. Ανανέωσε τη σελίδα και δοκίμασε ξανά.';
		}
	}

	setIdentity(token: string | null) {
		if (token === this.#token) return;
		this.#abort?.abort();
		this.#token = token;
		this.#deviceVersion++;
		this.replies = [];
		this.unread = 0;
		this.cursor = null;
		this.error = null;
		this.loading = false;
		this.#paginated = false;
		this.newReplies = false;
		this.pushError = null;
		this.lastAction = null;
		this.watched.clear();
		this.deviceRegistered = false;
		this.#subscriptionId = null;
		if (token && this.#mounted) {
			void this.load();
			void this.#restoreDevice();
		}
	}

	async load(more = false, background = false) {
		const token = this.#token;
		if (!token || this.loading || !this.#mounted || (more && !this.cursor)) return;
		this.#abort?.abort();
		const controller = (this.#abort = new AbortController());
		this.loading = true;
		if (!background) this.error = null;
		try {
			const response = await fetchReplies(token, more ? this.cursor : null, controller.signal);
			if (controller.signal.aborted || token !== this.#token) return;
			this.unread = response.unread_count;
			if (background && this.#paginated) {
				this.newReplies = response.replies[0]?.id !== this.replies[0]?.id;
				return;
			}
			const old = more ? this.replies : [];
			this.replies = [
				...new Map([...old, ...response.replies].map((entry) => [entry.id, entry])).values()
			];
			this.cursor = response.next_cursor;
			this.#paginated = more;
			this.newReplies = false;
			this.error = null;
		} catch (error) {
			if (!controller.signal.aborted && token === this.#token) {
				this.error = message(error, 'Δεν ήταν δυνατή η φόρτωση των απαντήσεων.');
				if (error instanceof CommentsApiError && error.status === 401) {
					this.replies = [];
					this.unread = 0;
				}
			}
		} finally {
			if (!controller.signal.aborted && token === this.#token) this.loading = false;
		}
	}

	async markRead(id?: string) {
		const token = this.#token;
		if (!token) return;
		try {
			await markRepliesRead(token, id);
			if (token !== this.#token) return;
			const marked = this.replies.filter(
				(entry) => entry.unread && (!id || id === entry.id)
			).length;
			this.replies = this.replies.map((entry) =>
				!id || id === entry.id ? { ...entry, unread: false } : entry
			);
			this.unread = id ? Math.max(0, this.unread - marked) : 0;
		} catch (error) {
			if (token === this.#token)
				this.error = message(error, 'Δεν ήταν δυνατή η ενημέρωση των απαντήσεων.');
		}
	}

	#saveDevice(id: string | null) {
		this.#subscriptionId = id;
		this.deviceRegistered = !!id;
		try {
			if (id) localStorage.setItem(SUBSCRIPTION_KEY, id);
			else localStorage.removeItem(SUBSCRIPTION_KEY);
		} catch {
			/* Still works for this visit. */
		}
	}

	#applyDevice(subscription: RegisteredPushSubscription) {
		this.#saveDevice(subscription.id);
		this.watched.clear();
		for (const id of subscription.watched_comment_ids) this.watched.add(id);
	}

	async #restoreDevice() {
		const token = this.#token;
		const version = this.#deviceVersion;
		if (!token || !this.#registration || this.busy) return;
		try {
			const native = await this.#registration.pushManager.getSubscription();
			if (token !== this.#token || version !== this.#deviceVersion) return;
			this.#nativeSubscription = native;
			if (!native) {
				this.#saveDevice(null);
				this.watched.clear();
				return;
			}
			this.deviceRegistered = true;
			let id = this.#subscriptionId;
			try {
				id ??= localStorage.getItem(SUBSCRIPTION_KEY);
			} catch {
				/* Memory-only browser. */
			}
			if (!id) return;
			const stored = await fetchPushSubscription(token, id);
			if (token === this.#token && version === this.#deviceVersion) this.#applyDevice(stored);
		} catch (error) {
			if (
				token === this.#token &&
				version === this.#deviceVersion &&
				error instanceof CommentsApiError &&
				error.status === 404
			) {
				this.#saveDevice(null);
				this.watched.clear();
			}
		}
	}

	/** Call the native subscribe API before the first await, preserving Safari's user gesture. */
	async toggleWatch(commentId: string) {
		const token = this.#token;
		if (!token || this.busy) return false;
		this.pushError = null;
		const enabled = !this.watched.has(commentId);
		if (
			enabled &&
			(!this.pushEnabled || !this.pushReady || !this.#registration || !this.#publicKey)
		)
			return false;
		this.busy = commentId;
		this.lastAction = commentId;
		this.#deviceVersion++;
		try {
			if (enabled) {
				const registration = this.#registration!;
				const key = Uint8Array.from(
					atob(this.#publicKey!.replace(/-/g, '+').replace(/_/g, '/')),
					(character) => character.charCodeAt(0)
				);
				const native =
					this.#nativeSubscription ??
					(await registration.pushManager.subscribe({
						userVisibleOnly: true,
						applicationServerKey: key
					}));
				this.#nativeSubscription = native;
				this.permission = Notification.permission;
				if (token !== this.#token) return false;
				let stored: RegisteredPushSubscription;
				try {
					stored = await registerPushSubscription(token, native.toJSON());
				} catch (error) {
					if (!(error instanceof CommentsApiError) || error.status !== 409) throw error;
					// A cleared/replaced anonymous identity must acquire a fresh browser subscription.
					await native.unsubscribe();
					this.#nativeSubscription = null;
					this.#saveDevice(null);
					this.pushError =
						'Η ταυτότητα σε αυτόν τον περιηγητή άλλαξε. Πάτησε ξανά για ενεργοποίηση ειδοποιήσεων.';
					return false;
				}
				if (token !== this.#token) return false;
				this.#applyDevice(stored);
			}
			if (!this.#subscriptionId) return false;
			await setReplyWatch(token, this.#subscriptionId, commentId, enabled);
			if (token !== this.#token) return false;
			if (enabled) this.watched.add(commentId);
			else this.watched.delete(commentId);
			return true;
		} catch (error) {
			if ('Notification' in window) this.permission = Notification.permission;
			if (token === this.#token)
				this.pushError =
					this.permission === 'denied'
						? 'Οι ειδοποιήσεις είναι αποκλεισμένες στις ρυθμίσεις του περιηγητή. Οι απαντήσεις σου παραμένουν διαθέσιμες εδώ.'
						: message(
								error,
								'Δεν ενεργοποιήθηκαν ειδοποιήσεις. Μπορείς να δοκιμάσεις ξανά όποτε θέλεις.'
							);
			return false;
		} finally {
			this.busy = null;
		}
	}

	async disableDevice() {
		if (this.busy) return;
		this.busy = 'device';
		this.#deviceVersion++;
		this.pushError = null;
		try {
			// Remove server watches first. A network failure leaves a retryable control in the UI.
			if (this.#token && this.#subscriptionId)
				await deletePushSubscription(this.#token, this.#subscriptionId);
			const native = await this.#registration?.pushManager.getSubscription();
			if (native) await native.unsubscribe();
			this.#nativeSubscription = null;
			this.#saveDevice(null);
			this.watched.clear();
		} catch (error) {
			this.pushError = message(error, 'Δεν ήταν δυνατή η απενεργοποίηση. Δοκίμασε ξανά.');
		} finally {
			this.busy = null;
		}
	}
}

export const replyNotifications = new ReplyNotifications();
