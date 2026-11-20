import { notFound } from 'next/navigation';
import { PROGRAMS } from '../../../server/content.ts';

// the first two params are prerendered; the rest are rendered on request and held by the spool family
export function generateStaticParams() {
	return PROGRAMS.slice(0, 2).map((row) => ({ id: row.id }));
}

export default async function Program({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const row = PROGRAMS.find((entry) => entry.id === id);
	if (!row) notFound();
	return (
		<div>
			<h1>{row.name}</h1>
			<p>{row.level}</p>
			<p>
				<a href="/programs?page=1">All programs</a>{' '}
				<a href={`/departments/${encodeURIComponent(row.department)}`}>Department</a>
			</p>
		</div>
	);
}
