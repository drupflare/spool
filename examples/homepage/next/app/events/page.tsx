import { notFound } from 'next/navigation';
import { eventsList, paramsOf } from '../../server/content.ts';

export const metadata = { title: 'Events' };

export default async function Events({
	searchParams
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const data = eventsList(await paramsOf(searchParams));
	if (!data) notFound();
	return (
		<div>
			<h1>Events</h1>
			<p>
				{data.query.total} events, page {data.query.page} of {data.query.pages}
			</p>
			<ul>
				{data.items.map((row) => (
					<li key={row.id}>
						<a href={`/events/${encodeURIComponent(row.id)}`}>{row.title}</a>,{' '}
						{row.starts}, {row.place}
					</li>
				))}
			</ul>
		</div>
	);
}
