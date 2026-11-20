<script setup lang="ts">
const route = useRoute();
const { data: row } = await useFetch(
	() => `/api/departments/${encodeURIComponent(String(route.params.id))}`
);
if (!row.value) throw createError({ statusCode: 404, statusMessage: 'Not found' });
useHead({ title: row.value.name });
</script>

<template>
	<div>
		<h1>{{ row?.name }}</h1>
		<p>
			<NuxtLink to="/departments">All departments</NuxtLink>
			<NuxtLink :to="`/programs?department=${encodeURIComponent(row?.id ?? '')}`"
				>Programs in {{ row?.name }}</NuxtLink
			>
		</p>
	</div>
</template>
