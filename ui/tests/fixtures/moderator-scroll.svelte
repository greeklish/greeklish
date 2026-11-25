<script>
	import { onMount, setContext } from 'svelte';
	import ModeratorGate from '../../src/lib/ModeratorGate.svelte';
	import CommentsRail from '../../src/lib/CommentsRail.svelte';
	import AppModalArea from '../../src/lib/AppModalArea.svelte';
	import { commentsStore } from '../../src/lib/comments-store.svelte';
	import '../../src/routes/layout.css';

	setContext('wx-theme', 'willow');
	const reduceAnimations = new URLSearchParams(location.search).has('reduce');
	let settings = $state(false);
	onMount(() => {
		document.body.dataset.ready = 'true';
	});
</script>

<div class="app-layout">
	<div class="app-main">
		<main style="min-height: 4000px; padding: 20px;">
			<div class="header-controls">
				<button
					id="settings"
					onclick={() => {
						settings = true;
					}}>Settings</button
				>
				{#if commentsStore.moderatorActive}
					<button class="moderation-button" onclick={() => commentsStore.openModeration()}
						>Moderation</button
					>
				{/if}
			</div>
			{#if settings}
				<AppModalArea
					title="Settings"
					reduceMotion={reduceAnimations}
					onClose={() => {
						settings = false;
					}}
				>
					<p>Settings fixture</p>
				</AppModalArea>
			{/if}
		</main>
	</div>
	<CommentsRail
		{reduceAnimations}
		locale="el-GR"
		externalLinkTarget={undefined}
		externalLinkRel={undefined}
	/>
</div>
<ModeratorGate reduceMotion={reduceAnimations} />
