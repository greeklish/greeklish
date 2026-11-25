<script lang="ts">
	import { onMount } from 'svelte';
	import { feedSuggestions as form } from '$lib/feed-suggestions.svelte';
	let { onClose }: { onClose: () => void } = $props();
	let now = $state(Date.now());
	let seconds = $derived(Math.max(0, Math.ceil((form.retryUntil - now) / 1000)));
	onMount(() => {
		const timer = setInterval(() => {
			now = Date.now();
		}, 250);
		return () => {
			clearInterval(timer);
			if (!form.submitting) form.captcha.destroy();
		};
	});
</script>

{#if form.success}
	<div role="status" class="suggestion-success">
		<p>Ευχαριστούμε! Η πρότασή σου στάλθηκε στους συντονιστές για έλεγχο.</p>
		<p>Αν έδωσες email, μπορούν να σε ενημερώσουν όταν προστεθεί η πηγή.</p>
	</div>
	<button class="suggestion-submit" type="button" onclick={onClose}>Κλείσιμο</button>
{:else}
	<p>Ποια πηγή θα ήθελες να βλέπεις στο Greeklish.gr; Δεν χρειάζεται εγγραφή.</p>
	<form
		class="suggestion-form"
		onfocusin={() => void form.prepare()}
		onsubmit={(event) => {
			event.preventDefault();
			void form.submit();
		}}
	>
		<label
			>Σύνδεσμος πηγής<input
				type="url"
				name="url"
				required
				maxlength="2048"
				placeholder="https://…"
				bind:value={form.draft.url}
				disabled={form.submitting}
			/></label
		>
		<label
			>Όνομα πηγής <span>(προαιρετικό)</span><input
				name="source-name"
				maxlength="100"
				bind:value={form.draft.name}
				disabled={form.submitting}
			/></label
		>
		<label
			>Γιατί την προτείνεις; <span>(προαιρετικό)</span><textarea
				name="explanation"
				rows="3"
				maxlength="1000"
				bind:value={form.draft.explanation}
				disabled={form.submitting}
			></textarea></label
		>
		<label
			>Email <span>(προαιρετικό)</span><input
				type="email"
				name="email"
				autocomplete="email"
				maxlength="254"
				aria-describedby="suggestion-email-help"
				bind:value={form.draft.email}
				disabled={form.submitting}
			/></label
		>
		<p id="suggestion-email-help" class="suggestion-help">
			Η πρόταση και το email είναι ορατά μόνο στους συντονιστές. Το email χρησιμοποιείται μόνο για
			ενημέρωση αν προστεθεί η πηγή και διαγράφεται 90 ημέρες μετά την ολοκλήρωση του ελέγχου.
		</p>
		{#if form.error}<p role="alert" class="suggestion-error">{form.error}</p>{/if}
		{#if seconds > 0}<p role="status">Δοκίμασε ξανά σε {seconds} δευτερόλεπτα.</p>{/if}
		<button class="suggestion-submit" type="submit" disabled={form.submitting || seconds > 0}>
			{form.submitting ? 'Αποστολή…' : 'Υποβολή πρότασης'}
		</button>
	</form>
{/if}

<style>
	.suggestion-form {
		display: grid;
		gap: 14px;
	}
	label {
		display: grid;
		gap: 5px;
		font-size: 14px;
	}
	label span,
	.suggestion-help {
		color: var(--color-text-muted);
		font-size: 12px;
	}
	input,
	textarea {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		padding: 10px;
		border: 1px solid var(--color-divider);
		border-radius: 6px;
		background: var(--color-background);
		color: var(--color-text);
		font: inherit;
	}
	input {
		min-height: 44px;
	}
	textarea {
		resize: vertical;
	}
	input:focus-visible,
	textarea:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--color-cerulean);
		outline-offset: 2px;
	}
	.suggestion-help {
		margin: 0;
		line-height: 1.5;
	}
	.suggestion-error {
		color: var(--color-text);
	}
	.suggestion-submit {
		min-height: 44px;
		padding: 8px 14px;
		border: 1px solid var(--color-cerulean);
		border-radius: 6px;
		background: var(--color-secondary-hover);
		color: var(--color-action-text);
		cursor: pointer;
		font: inherit;
	}
	.suggestion-submit:disabled {
		opacity: 0.55;
		cursor: wait;
	}
</style>
