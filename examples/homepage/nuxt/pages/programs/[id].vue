<script setup lang="ts">
const route = useRoute();
const { data: row } = await useFetch(
	() => `/api/programs/${encodeURIComponent(String(route.params.id))}`
);
if (!row.value) throw createError({ statusCode: 404, statusMessage: 'Not found' });
useHead({ title: row.value.name });
</script>

<template>
	<div>
		<h1>{{ row?.name }}</h1>
		<p>{{ row?.level }}</p>
		<p>
			<NuxtLink to="/programs?page=1">All programs</NuxtLink>
			<NuxtLink :to="`/departments/${encodeURIComponent(row?.department ?? '')}`"
				>Department</NuxtLink
			>
		</p>
	</div>
</template>
