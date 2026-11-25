import { tick } from 'svelte';

export class LocalStorage<T> {
	#key: string;
	#initial: T;
	#value: T;
	#validate: (value: unknown) => value is T;
	#version = $state(0);
	#listeners = 0;
	#memoryOnly = false;

	#handler = (event: StorageEvent) => {
		if (event.key !== this.#key && event.key !== null) {
			return;
		}

		this.#memoryOnly = false;
		this.#version += 1;
	};

	constructor(key: string, initial: T, validate: (value: unknown) => value is T) {
		this.#key = key;
		this.#initial = initial;
		this.#value = initial;
		this.#validate = validate;

		try {
			if (typeof localStorage !== 'undefined' && localStorage.getItem(key) === null) {
				this.#write(initial);
			}
		} catch {
			this.#memoryOnly = true;
		}
	}

	get current() {
		this.#trackVersion();

		if ($effect.tracking()) {
			$effect(() => {
				if (this.#listeners === 0) {
					window.addEventListener('storage', this.#handler);
				}

				this.#listeners += 1;

				return () => {
					tick().then(() => {
						this.#listeners -= 1;
						if (this.#listeners === 0) {
							window.removeEventListener('storage', this.#handler);
						}
					});
				};
			});
		}

		if (this.#memoryOnly) return this.#value;

		try {
			if (typeof localStorage === 'undefined') return this.#value;
			const stored = localStorage.getItem(this.#key);
			if (stored === null) {
				this.#value = this.#initial;
				this.#write(this.#initial);
				return this.#initial;
			}
			const parsed: unknown = JSON.parse(stored);
			if (this.#validate(parsed)) {
				this.#value = parsed;
				return parsed;
			}
		} catch (error) {
			if (!(error instanceof SyntaxError)) {
				this.#memoryOnly = true;
				return this.#value;
			}
		}

		this.#value = this.#initial;
		this.#write(this.#initial);
		return this.#initial;
	}

	set current(value: T) {
		if (Object.is(this.#value, value)) {
			return;
		}

		this.#value = value;
		this.#write(value);
		this.#version += 1;
	}

	#trackVersion() {
		return this.#version;
	}

	#write(value: T) {
		try {
			localStorage.setItem(this.#key, JSON.stringify(value));
			this.#memoryOnly = false;
		} catch {
			// Keep the user's current choice when storage is unavailable or full.
			this.#memoryOnly = true;
		}
	}
}
