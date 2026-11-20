<script setup lang="ts">
const props = defineProps<{ error: { statusCode: number } }>();
const title = props.error.statusCode === 404 ? 'Not found' : 'Error';
useHead({ title });
</script>

<template>
	<NuxtLayout>
		<h1>{{ title }}</h1>
	</NuxtLayout>
</template>
