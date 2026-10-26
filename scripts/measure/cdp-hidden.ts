import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

/** a browser driven over raw CDP, which sets no focus emulation, so a tab behind another reports `hidden` */
export type HiddenBrowser = {
	/** the first tab's `document.visibilityState` */
	visibility(): Promise<string>;
	/** evaluates `expression` in the first tab and returns its value */
	evaluate<T>(expression: string): Promise<T>;
	/** opens a second tab in the same window and brings it to the front */
	hideFirstTab(): Promise<void>;
	close(): Promise<void>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts `executable` headed (it needs a display, such as Xvfb), opens `url` in its first tab and
 * returns a handle on it. Playwright is not used because it turns on focus emulation, which makes
 * every tab report `visible` whether or not it is in front.
 */
export async function openHiddenBrowser(executable: string, url: string): Promise<HiddenBrowser> {
	const dir = mkdtempSync(join(tmpdir(), 'spool-cdp-'));
	const child: ChildProcess = spawn(
		executable,
		[
			'--remote-debugging-port=0',
			`--user-data-dir=${dir}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--no-sandbox',
			'--disable-gpu',
			'--disable-dev-shm-usage',
			'about:blank'
		],
		{ stdio: 'ignore' }
	);
	let exited = false;
	child.on('exit', () => (exited = true));
	let endpoint = '';
	for (let i = 0; i < 100 && !endpoint; i++) {
		if (exited) throw new Error('the browser exited before it opened a debugging port');
		try {
			const [port, path] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n');
			if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
		} catch {
			await sleep(100);
		}
	}
	if (!endpoint) {
		child.kill();
		throw new Error('the browser did not report a debugging port in 10 s');
	}
	const socket = new WebSocket(endpoint);
	await new Promise<void>((resolve, reject) => {
		socket.onopen = () => resolve();
		socket.onerror = () => reject(new Error('the debugging socket did not open'));
	});
	let id = 0;
	const pending = new Map<number, Pending>();
	socket.onmessage = (event) => {
		const message = JSON.parse(String(event.data)) as {
			id?: number;
			result?: unknown;
			error?: { message: string };
		};
		if (message.id === undefined) return;
		const waiting = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) waiting?.reject(new Error(message.error.message));
		else waiting?.resolve(message.result);
	};
	const send = <T>(method: string, params: object = {}, sessionId?: string) =>
		new Promise<T>((resolve, reject) => {
			const call = ++id;
			pending.set(call, { resolve: resolve as (value: unknown) => void, reject });
			socket.send(
				JSON.stringify({ id: call, method, params, ...(sessionId ? { sessionId } : {}) })
			);
		});

	const { targetInfos } = await send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
		'Target.getTargets'
	);
	const first = targetInfos.find((t) => t.type === 'page');
	if (!first) throw new Error('the browser has no first tab');
	const { sessionId } = await send<{ sessionId: string }>('Target.attachToTarget', {
		targetId: first.targetId,
		flatten: true
	});
	await send('Page.enable', {}, sessionId);
	await send('Page.navigate', { url }, sessionId);
	await sleep(500);

	const evaluate = async <T>(expression: string): Promise<T> => {
		const out = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
			'Runtime.evaluate',
			{ expression, returnByValue: true },
			sessionId
		);
		if (out.exceptionDetails) throw new Error(`evaluating ${expression} threw`);
		return out.result.value;
	};

	return {
		visibility: () => evaluate<string>('document.visibilityState'),
		evaluate,
		async hideFirstTab() {
			const { targetId } = await send<{ targetId: string }>('Target.createTarget', {
				url: 'about:blank',
				newWindow: false
			});
			await send('Target.activateTarget', { targetId });
			await sleep(500);
		},
		async close() {
			try {
				await send('Browser.close');
			} catch {
				// the socket closes with the browser
			}
			socket.close();
			child.kill();
		}
	};
}
