import { notFound } from 'next/navigation';
import { newsList, paramsOf } from '../../server/content.ts';

export const metadata = { title: 'News' };

export default async function News({
	searchParams
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const data = newsList(await paramsOf(searchParams));
	if (!data) notFound();
	return (
		<div>
			<h1>News</h1>
			<p>
				{data.query.total} stories, page {data.query.page} of {data.query.pages}
			</p>
			<ul>
				{data.items.map((row) => (
					<li key={row.slug}>
						<a href={`/news/${encodeURIComponent(row.slug)}`}>{row.title}</a>
					</li>
				))}
			</ul>
		</div>
	);
}
