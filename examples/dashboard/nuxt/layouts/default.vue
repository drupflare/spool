<template>
	<div>
		<nav>
			<NuxtLink to="/">Board</NuxtLink> <NuxtLink to="/login">Sign in</NuxtLink>
			<a href="/logout">Sign out</a> <a href="/me">Me</a>
		</nav>
		<main data-spool-swap>
			<slot />
		</main>
		<footer>Team task board</footer>
	</div>
</template>
