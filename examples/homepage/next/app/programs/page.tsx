import { notFound } from 'next/navigation';
import { paramsOf, programsList } from '../../server/content.ts';

export const metadata = { title: 'Programs' };

export default async function Programs({
	searchParams
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const data = programsList(await paramsOf(searchParams));
	if (!data) notFound();
	return (
		<div>
			<h1>Programs</h1>
			<p>
				{data.query.total} programs, page {data.query.page} of {data.query.pages}
			</p>
			<ul>
				{data.items.map((row) => (
					<li key={row.id}>
						<a href={`/programs/${encodeURIComponent(row.id)}`}>{row.name}</a> (
						{row.level})
					</li>
				))}
			</ul>
		</div>
	);
}
