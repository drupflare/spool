import { latestNews, soonestEvents } from '../server/content.ts';

export const metadata = { title: 'Larkspur College' };

export default function Home() {
	return (
		<div>
			<h1>Larkspur College</h1>
			<section>
				<h2>Latest news</h2>
				<ul>
					{latestNews().map((row) => (
						<li key={row.slug}>
							<a href={`/news/${encodeURIComponent(row.slug)}`}>{row.title}</a>
						</li>
					))}
				</ul>
			</section>
			<section>
				<h2>Next events</h2>
				<ul>
					{soonestEvents().map((row) => (
						<li key={row.id}>
							<a href={`/events/${encodeURIComponent(row.id)}`}>{row.title}</a>,{' '}
							{row.starts}
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}
