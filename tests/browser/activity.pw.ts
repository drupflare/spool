import { expect, test, type Page } from '@playwright/test';
import { startFixture, type Fixture } from './fixture';

type SpoolWindow = {
	spool: {
		ready: Promise<unknown>;
		activity: {
			register(
				controls: { pause(): void; resume(): void },
				options?: { target?: Element; hiddenAfterMs?: number }
			): () => void;
		};
	};
	loop: { pause: number; resume: number };
	setHidden(value: boolean): void;
};

let fx: Fixture;

test.beforeAll(async () => {
	fx = await startFixture();
});

test.afterAll(() => fx.stop());

const loopCounts = (page: Page) => page.evaluate(() => (window as unknown as SpoolWindow).loop);

async function registerLoop(
	page: Page,
	options: { withTarget?: boolean; hiddenAfterMs?: number }
): Promise<void> {
	await page.evaluate(
		({ withTarget, hiddenAfterMs }) => {
			const w = window as unknown as SpoolWindow;
			w.loop = { pause: 0, resume: 0 };
			w.spool.activity.register(
				{
					pause() {
						w.loop.pause += 1;
					},
					resume() {
						w.loop.resume += 1;
					}
				},
				{
					target: withTarget ? (document.querySelector('#loop') ?? undefined) : undefined,
					hiddenAfterMs
				}
			);
		},
		{ withTarget: options.withTarget ?? false, hiddenAfterMs: options.hiddenAfterMs }
	);
}

test('a loop pauses while its target is off screen and resumes when it is back', async ({
	page
}) => {
	await page.goto(`${fx.origin}/n/1`);
	await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	await page.evaluate(() => {
		const main = document.querySelector('main');
		const target = document.createElement('div');
		target.id = 'loop';
		target.style.height = '100px';
		const spacer = document.createElement('div');
		spacer.style.height = '3000px';
		main?.prepend(target);
		main?.append(spacer);
	});
	await registerLoop(page, { withTarget: true });

	await page.evaluate(() => window.scrollTo(0, 2000));
	await expect.poll(() => loopCounts(page)).toEqual({ pause: 1, resume: 0 });

	await page.evaluate(() => window.scrollTo(0, 0));
	await expect.poll(() => loopCounts(page)).toEqual({ pause: 1, resume: 1 });

	expect(
		await page.evaluate(async () => {
			await (window as unknown as SpoolWindow).spool.ready;
			return typeof (window as unknown as SpoolWindow).spool.activity.register;
		})
	).toBe('function');
});

// bringToFront leaves the first page visible in all three engines, so the test hides it itself
// (measured 2026-10-25)
function visibilityControl() {
	let hidden = false;
	const define = (name: string, get: () => unknown) =>
		Object.defineProperty(Document.prototype, name, { configurable: true, get });
	define('hidden', () => hidden);
	define('visibilityState', () => (hidden ? 'hidden' : 'visible'));
	(window as unknown as SpoolWindow).setHidden = (value: boolean) => {
		hidden = value;
		document.dispatchEvent(new Event('visibilitychange'));
	};
}

test('a loop pauses once its page has been hidden for hiddenAfterMs, and resumes when shown again', async ({
	page
}) => {
	await page.addInitScript(visibilityControl);
	await page.goto(`${fx.origin}/n/1`);
	await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	await registerLoop(page, { hiddenAfterMs: 200 });

	await page.evaluate(() => (window as unknown as SpoolWindow).setHidden(true));
	await expect.poll(() => loopCounts(page)).toEqual({ pause: 1, resume: 0 });

	await page.evaluate(() => (window as unknown as SpoolWindow).setHidden(false));
	await expect.poll(() => loopCounts(page)).toEqual({ pause: 1, resume: 1 });
});
