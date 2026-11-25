export const COMMENTS_HASH_PREFIX = 'σχόλια';

// Letters, marks and digits stay literal, so a copied link reads as Greek — or Cyrillic, or any
// other script — instead of a wall of escapes. Everything else falls through to
// `encodeURIComponent`, which keeps ASCII byte-identical to the old behaviour and still escapes the
// `/` separator along with the invisible characters this class deliberately excludes: bidi
// overrides (Cf), zero-width joiners, non-breaking and ideographic spaces (Zs), C1 controls (Cc)
// and lone surrogates (Cs). Those are the ones that would make a fragment ambiguous or let it
// misrepresent where it points.
const LITERAL_IN_FRAGMENT = /^[\p{L}\p{M}\p{N}]$/u;

function encodeSegment(segment: string) {
	return Array.from(segment, (char) => {
		if (LITERAL_IN_FRAGMENT.test(char)) return char;
		try {
			return encodeURIComponent(char);
		} catch {
			// Only a lone surrogate throws, and no topic, external id or UUID carries one.
			return encodeURIComponent('�');
		}
	}).join('');
}

export function commentHash(topic: string, externalId: string, commentId?: string) {
	return (
		'#' +
		[COMMENTS_HASH_PREFIX, topic, externalId, ...(commentId ? [commentId] : [])]
			.map(encodeSegment)
			.join('/')
	);
}

export function commentUrl(topic: string, externalId: string, commentId: string) {
	return `${window.location.origin}${window.location.pathname}${commentHash(topic, externalId, commentId)}`;
}

/**
 * Splits a `#σχόλια/…` fragment into its decoded segments, or returns `null` for any other
 * fragment. Decoding first is what lets one reader handle both forms a fragment arrives in: the
 * literal text a shared link carries, and the percent-encoded text the URL parser hands back from
 * `location.hash`.
 */
export function parseCommentHash(hash: string): string[] | null {
	const segments = hash.replace(/^#/, '').split('/');

	let decoded: string[];
	try {
		decoded = segments.map((segment) => decodeURIComponent(segment));
	} catch {
		return null;
	}

	return decoded[0] === COMMENTS_HASH_PREFIX ? decoded : null;
}

/** True when `hash` already addresses exactly this comment, in either form. */
export function commentHashMatches(
	hash: string,
	topic: string,
	externalId: string,
	commentId?: string
) {
	const decoded = parseCommentHash(hash);
	if (!decoded) return false;

	const expected = [COMMENTS_HASH_PREFIX, topic, externalId, ...(commentId ? [commentId] : [])];
	return (
		decoded.length === expected.length && decoded.every((segment, i) => segment === expected[i])
	);
}
