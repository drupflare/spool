<script setup lang="ts">
useHead({ title: 'Departments' });
const { data } = await useFetch('/api/departments');
</script>

<template>
	<div>
		<h1>Departments</h1>
		<ul>
			<li
				v-for="row in data?.items"
				:key="row.id"
			>
				<NuxtLink :to="`/departments/${encodeURIComponent(row.id)}`">{{
					row.name
				}}</NuxtLink>
			</li>
		</ul>
	</div>
</template>
