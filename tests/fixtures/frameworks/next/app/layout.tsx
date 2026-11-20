import { spoolTag } from '@drupflare/spool/next';
import type { ReactNode } from 'react';
import { spool } from '../server/spool.ts';

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<title>spool next fixture</title>
			</head>
			<body>
				<div
					hidden
					dangerouslySetInnerHTML={{ __html: spoolTag(spool) }}
				/>
				{children}
			</body>
		</html>
	);
}
