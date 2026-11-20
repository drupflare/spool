import { notFound } from 'next/navigation';
import { PAGES } from '../../../server/content.ts';

// the first two params are prerendered; the rest are rendered on request and held by the spool family
export function generateStaticParams() {
	return PAGES.slice(0, 2).map((row) => ({ slug: row.slug }));
}

export default async function About({ params }: { params: Promise<{ slug: string }> }) {
	const { slug } = await params;
	const row = PAGES.find((entry) => entry.slug === slug);
	if (!row) notFound();
	return (
		<div>
			<h1>{row.title}</h1>
			<p>{row.body}</p>
		</div>
	);
}
