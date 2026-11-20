export default async function Post({ params }: { params: Promise<{ slug: string }> }) {
	const { slug } = await params;
	return (
		<main>
			<h1>{slug}</h1>
		</main>
	);
}
