import { rows } from '../../../server/spool.ts';

export function generateStaticParams() {
	return rows.map((row) => ({ id: row.id }));
}

export default async function Article({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const row = rows.find((article) => article.id === id);
	return (
		<main>
			<h1>{row?.title ?? 'not found'}</h1>
		</main>
	);
}
