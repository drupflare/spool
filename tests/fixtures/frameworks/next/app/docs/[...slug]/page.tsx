export default async function Docs({ params }: { params: Promise<{ slug: string[] }> }) {
	const { slug } = await params;
	return (
		<main>
			<h1>{slug.join('/')}</h1>
		</main>
	);
}
