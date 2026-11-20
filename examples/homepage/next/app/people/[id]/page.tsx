import { notFound } from 'next/navigation';
import { PEOPLE } from '../../../server/content.ts';

// the first two params are prerendered; the rest are rendered on request and held by the spool family
export function generateStaticParams() {
	return PEOPLE.slice(0, 2).map((row) => ({ id: row.id }));
}

export default async function Person({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const row = PEOPLE.find((entry) => entry.id === id);
	if (!row) notFound();
	return (
		<div>
			<h1>{row.name}</h1>
			<p>{row.title}</p>
			<p>
				<a href="/people">All people</a>{' '}
				<a href={`/departments/${encodeURIComponent(row.department)}`}>Department</a>
			</p>
		</div>
	);
}
