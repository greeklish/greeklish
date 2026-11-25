export type ThemePreference = 'system' | 'light' | 'dark';

// Retain existing preferences and the early theme-init.js script's storage format.
const STORAGE_KEY = 'mode-watcher-mode';
const valid = (value: unknown): value is ThemePreference =>
	value === 'system' || value === 'light' || value === 'dark';

class ThemeState {
	current = $state<ThemePreference>('system');
	#query: MediaQueryList | null = null;

	initialize() {
		this.#query = window.matchMedia('(prefers-color-scheme: dark)');
		const read = () => {
			try {
				const value = localStorage.getItem(STORAGE_KEY);
				this.current = valid(value) ? value : 'system';
			} catch {
				/* Theme selection also works without persistent storage. */
			}
			this.#apply();
		};
		const onStorage = (event: StorageEvent) => {
			if (event.key === STORAGE_KEY || event.key === null) read();
		};
		const onSystemChange = () => this.#apply();
		read();
		this.#query.addEventListener('change', onSystemChange);
		window.addEventListener('storage', onStorage);
		return () => {
			this.#query?.removeEventListener('change', onSystemChange);
			window.removeEventListener('storage', onStorage);
		};
	}

	set(value: ThemePreference) {
		this.current = value;
		try {
			localStorage.setItem(STORAGE_KEY, value);
		} catch {
			/* Retain the in-memory choice. */
		}
		this.#apply();
	}

	#apply() {
		const dark = this.current === 'dark' || (this.current === 'system' && !!this.#query?.matches);
		document.documentElement.classList.toggle('dark', dark);
		document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute('content', dark ? '#11161a' : '#ffffff');
	}
}

export const userPrefersMode = new ThemeState();
export const setMode = (value: ThemePreference) => userPrefersMode.set(value);
