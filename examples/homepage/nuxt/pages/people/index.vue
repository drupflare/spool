<script setup lang="ts">
useHead({ title: 'People' });
const { data } = await useFetch('/api/people');
</script>

<template>
	<div>
		<h1>People</h1>
		<ul>
			<li
				v-for="row in data?.items"
				:key="row.id"
			>
				<NuxtLink :to="`/people/${encodeURIComponent(row.id)}`">{{ row.name }}</NuxtLink
				>, {{ row.title }}
			</li>
		</ul>
	</div>
</template>
