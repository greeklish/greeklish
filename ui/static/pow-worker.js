/**
 * Altcha-protocol proof-of-work solver.
 *
 * Lives in `static/` as a real file rather than an inline script or a `blob:` worker because
 * `scripts/fix-csp-hashes.mjs` hashes every inline script at build time, and the CSP allows
 * `worker-src 'self' blob:`. A file keeps the build step out of the picture entirely.
 *
 * The server never sends the secret number; this recovers it by brute force, which is the "work".
 */

const PROGRESS_STRIDE = 5000;
const encoder = new TextEncoder();

/** Renders a digest as lowercase hex, to compare against the server's challenge string. */
function toHex(buffer) {
	const bytes = new Uint8Array(buffer);
	let hex = '';

	for (let index = 0; index < bytes.length; index += 1) {
		hex += bytes[index].toString(16).padStart(2, '0');
	}

	return hex;
}

async function solve({ challenge, salt, maxnumber }) {
	const startedAt = Date.now();

	for (let candidate = 0; candidate <= maxnumber; candidate += 1) {
		const digest = await crypto.subtle.digest('SHA-256', encoder.encode(salt + candidate));

		if (toHex(digest) === challenge) {
			return { number: candidate, took: Date.now() - startedAt };
		}

		// Let the host show movement on a slow device without flooding it with messages.
		if (candidate > 0 && candidate % PROGRESS_STRIDE === 0) {
			self.postMessage({ type: 'progress', checked: candidate, maxnumber });
		}
	}

	return null;
}

self.addEventListener('message', async (event) => {
	const request = event.data;

	if (!request || request.type !== 'solve') {
		return;
	}

	if (request.algorithm !== 'SHA-256') {
		self.postMessage({
			type: 'error',
			id: request.id,
			message: `unsupported algorithm: ${request.algorithm}`
		});
		return;
	}

	try {
		const solution = await solve(request);

		if (!solution) {
			self.postMessage({
				type: 'error',
				id: request.id,
				message: 'no solution below maxnumber'
			});
			return;
		}

		self.postMessage({
			type: 'solved',
			id: request.id,
			number: solution.number,
			took: solution.took
		});
	} catch (error) {
		self.postMessage({
			type: 'error',
			id: request.id,
			message: error instanceof Error ? error.message : 'proof of work failed'
		});
	}
});
