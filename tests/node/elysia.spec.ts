import { describe, it } from 'vitest';
import { exercise, overFetch } from './exercise';
import { app } from './readme/elysia';

describe('Elysia', () => {
	it('answers spool paths from onRequest and decorates the page', async () => {
		await exercise(overFetch((request) => app.handle(request)));
	});
});
