<script lang="ts">
	import { replyNotifications as notifications } from '$lib/reply-notifications.svelte';
</script>

<section class="notification-settings" aria-labelledby="notification-settings-title">
	<h3 id="notification-settings-title">Απαντήσεις και ειδοποιήσεις</h3>
	<p>
		Οι «Απαντήσεις μου» συγκεντρώνουν απαντήσεις στα σχόλιά σου, χωρίς εγγραφή. Η ταυτότητά σου
		αποθηκεύεται σε αυτόν τον περιηγητή· αν διαγράψεις τα δεδομένα του, δεν θα μπορείς να ανακτήσεις
		αυτή τη λίστα.
	</p>
	{#if notifications.pushEnabled}
		<p>
			Επιλέγεις ειδοποιήσεις ξεχωριστά για κάθε δικό σου σχόλιο. Δεν στέλνουμε ειδοποιήσεις για
			άσχετες συζητήσεις.
		</p>
		{#if notifications.needsHomeScreen}
			<p>
				Σε iPhone ή iPad, πρόσθεσε την εφαρμογή στην Αρχική οθόνη από το μενού κοινής χρήσης και
				σχολίασε ανοίγοντάς την από εκεί. Η ταυτότητα σχολιασμού μπορεί να διαφέρει από αυτήν του
				browser.
			</p>
		{:else if !notifications.supported}
			<p>
				Οι ειδοποιήσεις δεν υποστηρίζονται σε αυτόν τον περιηγητή. Οι «Απαντήσεις μου» παραμένουν
				διαθέσιμες.
			</p>
		{:else if notifications.permission === 'denied'}
			<p>
				Οι ειδοποιήσεις είναι αποκλεισμένες. Μπορείς να το αλλάξεις στις άδειες του ιστοτόπου στον
				περιηγητή σου.
			</p>
		{/if}
	{/if}
	{#if notifications.deviceRegistered}
		<button
			type="button"
			disabled={!!notifications.busy}
			onclick={() => notifications.disableDevice()}
		>
			{notifications.busy === 'device'
				? 'Απενεργοποίηση…'
				: 'Απενεργοποίηση ειδοποιήσεων σε αυτή τη συσκευή'}
		</button>
	{/if}
	{#if notifications.pushError && notifications.permission !== 'denied'}<p role="status">
			{notifications.pushError}
		</p>{/if}
</section>

<style>
	.notification-settings {
		margin-bottom: 24px;
		padding-bottom: 16px;
		border-bottom: 1px solid var(--color-divider);
	}
	h3 {
		margin: 0 0 6px;
		font-size: 16px;
	}
	p {
		margin: 0 0 8px;
		color: var(--color-text-muted);
		font-size: 13px;
		line-height: 1.6;
	}
	button {
		border: 1px solid var(--color-divider);
		border-radius: 6px;
		background: transparent;
		min-height: 44px;
		padding: 6px 10px;
		color: var(--color-action-text);
		font: inherit;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}
	button:focus-visible {
		outline: 2px solid var(--color-cerulean);
	}
	button:disabled {
		opacity: 0.6;
	}
</style>
