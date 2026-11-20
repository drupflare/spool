import { PEOPLE } from '../../server/content.ts';

export const metadata = { title: 'People' };

export default function People() {
	return (
		<div>
			<h1>People</h1>
			<ul>
				{PEOPLE.map((row) => (
					<li key={row.id}>
						<a href={`/people/${encodeURIComponent(row.id)}`}>{row.name}</a>,{' '}
						{row.title}
					</li>
				))}
			</ul>
		</div>
	);
}
