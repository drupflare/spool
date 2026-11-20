<template>
	<div v-if="task">
		<h1>{{ task.title }}</h1>
		<p>{{ task.status }}, {{ task.priority }}, due {{ task.due }}</p>
		<p>
			<NuxtLink :to="`/board/projects/${task.project}`">Project</NuxtLink>
			<NuxtLink to="/">Board</NuxtLink>
		</p>
		<label>
			Status
			<select
				:value="task.status"
				@change="setStatus"
			>
				<option value="todo">todo</option>
				<option value="doing">doing</option>
				<option value="done">done</option>
			</select>
		</label>
		<button @click="complete">Complete</button>
		<button @click="remove">Delete</button>
		<p v-if="error">{{ error }}</p>
	</div>
	<p v-else>Not found.</p>
</template>

<script setup lang="ts">
type Task = {
	id: string;
	project: string;
	title: string;
	status: string;
	priority: string;
	due: string;
};

const route = useRoute();
const id = computed(() => String(route.params.id));
const { data: task, refresh } = await useFetch<Task>(() => `/tasks/${id.value}`);
const error = ref('');

async function act(run: () => Promise<unknown>, after?: () => void) {
	error.value = '';
	try {
		await run();
		after?.();
	} catch {
		error.value = 'The write was refused. Check the sign-in and the project.';
	}
}

const setStatus = (event: Event) =>
	act(
		() =>
			$fetch(`/tasks/${id.value}`, {
				method: 'PATCH',
				body: { status: (event.target as HTMLSelectElement).value }
			}),
		() => refresh()
	);

const complete = () =>
	act(
		() => $fetch(`/tasks/${id.value}/complete`, { method: 'POST' }),
		() => refresh()
	);

const remove = () =>
	act(
		() => $fetch(`/tasks/${id.value}`, { method: 'DELETE' }),
		() => navigateTo('/')
	);
</script>
