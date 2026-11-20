import { notFound } from 'next/navigation';
import { EVENTS } from '../../../server/content.ts';

// the first two params are prerendered; the rest are rendered on request and held by the spool family
export function generateStaticParams() {
	return EVENTS.slice(0, 2).map((row) => ({ id: row.id }));
}

export default async function Event({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const row = EVENTS.find((entry) => entry.id === id);
	if (!row) notFound();
	return (
		<div>
			<h1>{row.title}</h1>
			<p>
				{row.starts}, {row.place}
			</p>
			<p>
				<a href="/events?page=1">All events</a>
			</p>
		</div>
	);
}
