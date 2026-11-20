import { spoolTag } from '@drupflare/spool/next';
import type { ReactNode } from 'react';
import { PAGES } from '../../shared/site.ts';
import { spool } from '../server/spool.ts';

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>
				<div
					hidden
					dangerouslySetInnerHTML={{ __html: spoolTag(spool) }}
				/>
				<nav>
					<a href="/">Home</a> <a href="/news?page=1">News</a>{' '}
					<a href="/events?page=1">Events</a> <a href="/programs?page=1">Programs</a>{' '}
					<a href="/departments">Departments</a> <a href="/people">People</a>
				</nav>
				<main data-spool-swap>{children}</main>
				<footer>
					<nav>
						{PAGES.map((page) => (
							<a
								key={page.slug}
								href={`/about/${encodeURIComponent(page.slug)}`}
							>
								{page.title}
							</a>
						))}
					</nav>
				</footer>
			</body>
		</html>
	);
}
