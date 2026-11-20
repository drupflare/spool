import type { Spool } from '../../../src/server/spool';

declare global {
	const spool: Spool;
	const headers: Headers;
	const user: string;
}
