import { DEPARTMENTS } from '../../server/content.ts';

export const metadata = { title: 'Departments' };

export default function Departments() {
	return (
		<div>
			<h1>Departments</h1>
			<ul>
				{DEPARTMENTS.map((row) => (
					<li key={row.id}>
						<a href={`/departments/${encodeURIComponent(row.id)}`}>{row.name}</a>
					</li>
				))}
			</ul>
		</div>
	);
}
