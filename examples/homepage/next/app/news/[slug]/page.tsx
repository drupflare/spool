import { notFound } from 'next/navigation';
import { ARTICLES } from '../../../server/content.ts';

// the first two params are prerendered; the rest are rendered on request and held by the spool family
export function generateStaticParams() {
	return ARTICLES.slice(0, 2).map((row) => ({ slug: row.slug }));
}

export default async function Article({ params }: { params: Promise<{ slug: string }> }) {
	const { slug } = await params;
	const row = ARTICLES.find((entry) => entry.slug === slug);
	if (!row) notFound();
	return (
		<div>
			<h1>{row.title}</h1>
			<p>{row.published}</p>
			<p>
				<a href="/news?page=1">All news</a>
			</p>
		</div>
	);
}
