import { notFound } from 'next/navigation';
import { DEPARTMENTS } from '../../../server/content.ts';

// the first two params are prerendered; the rest are rendered on request and held by the spool family
export function generateStaticParams() {
	return DEPARTMENTS.slice(0, 2).map((row) => ({ id: row.id }));
}

export default async function Department({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const row = DEPARTMENTS.find((entry) => entry.id === id);
	if (!row) notFound();
	return (
		<div>
			<h1>{row.name}</h1>
			<p>
				<a href="/departments">All departments</a>{' '}
				<a href={`/programs?department=${encodeURIComponent(row.id)}`}>
					Programs in {row.name}
				</a>
			</p>
		</div>
	);
}
