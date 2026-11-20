<template>
	<div>
		<h1>Sign in</h1>
		<form
			v-for="member in members"
			:key="member.id"
			@submit.prevent="signIn(member.id)"
		>
			<button>{{ member.name }}</button>
		</form>
		<p v-if="error">{{ error }}</p>
	</div>
</template>

<script setup lang="ts">
// the ids the site accepts; the site module is not imported into the client bundle
const members = [
	{ id: 'ada', name: 'Ada Park' },
	{ id: 'bo', name: 'Bo Lin' },
	{ id: 'cy', name: 'Cy Ortiz' }
];

const error = ref('');

async function signIn(id: string) {
	error.value = '';
	try {
		await $fetch(`/login?as=${encodeURIComponent(id)}`, { method: 'POST' });
		window.location.assign('/me');
	} catch {
		error.value = 'Sign-in failed.';
	}
}
</script>
