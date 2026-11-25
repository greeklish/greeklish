declare module 'grhyph-js/quickSynizesis.js' {
	export function hyphenate(
		word: string,
		options?: {
			quickSynizesis?: boolean;
			separator?: string;
		}
	): string;
}
