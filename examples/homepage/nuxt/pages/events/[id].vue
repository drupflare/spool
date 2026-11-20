<script setup lang="ts">
const route = useRoute();
const { data: row } = await useFetch(
	() => `/api/events/${encodeURIComponent(String(route.params.id))}`
);
if (!row.value) throw createError({ statusCode: 404, statusMessage: 'Not found' });
useHead({ title: row.value.title });
</script>

<template>
	<div>
		<h1>{{ row?.title }}</h1>
		<p>{{ row?.starts }}, {{ row?.place }}</p>
		<p><NuxtLink to="/events?page=1">All events</NuxtLink></p>
	</div>
</template>
