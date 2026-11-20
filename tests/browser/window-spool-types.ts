import type { SpoolClient } from '../../src/client/index';

// compiled by `bun run typecheck`, never run: it checks the page API types `window.spool` carries
export function pageApi(): void {
	const ready: Promise<SpoolClient | null> | undefined = window.spool?.ready;
	const off: (() => void) | undefined = window.spool?.activity.register(
		{ pause() {}, resume() {} },
		{ target: document.body, hiddenAfterMs: 0 }
	);
	const response: Promise<Response> | undefined = window.spool?.fetch('/courses/101', {
		method: 'PATCH',
		body: '{}'
	});
	const queued = window.spool?.write('course', '101', { title: 'Biology 101' }, 'v1');
	const flushed = window.spool?.flush();
	const listed = window.spool?.writes();
	const settled = window.spool?.resolve('course', '101', 'server');
	// @ts-expect-error liveState is internal to the client handle, not a page member
	void window.spool?.liveState;
	// @ts-expect-error status is a client method, not a page member
	void window.spool?.status;
	void [ready, off, response, queued, flushed, listed, settled];
}
