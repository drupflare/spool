<script setup lang="ts">
const services = [
	{ name: 'Web', state: 'Operational' },
	{ name: 'Search', state: 'Degraded' },
	{ name: 'Email', state: 'Operational' }
];
</script>

<template>
	<main>
		<h1>Status</h1>
		<ul>
			<li
				v-for="service in services"
				:key="service.name"
			>
				{{ service.name }}: {{ service.state }}
			</li>
		</ul>
		<p><NuxtLink to="/about">About this page</NuxtLink></p>
	</main>
</template>
