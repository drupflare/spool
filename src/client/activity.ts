/** what a site gives spool for one loop of its own */
export type ActivityControls = {
	/** stops the loop; called while the target is off screen or the page is hidden */
	pause(): void;
	/** restarts the loop once neither condition holds */
	resume(): void;
};

export type ActivityOptions = {
	/** the element the loop draws; the loop pauses while none of it is on screen */
	target?: Element;
	/** how long the page may stay hidden before the loop pauses; default 10000 ms, 0 pauses at once */
	hiddenAfterMs?: number;
};

/** everything the hook needs from the page, injected so node can drive it */
export type ActivityHost = {
	/** whether the page is hidden now */
	hidden(): boolean;
	/** calls listener on each visibility change; returns the function that stops it */
	onVisibilityChange(listener: () => void): () => void;
	/** calls listener with whether the target is on screen; returns the function that stops it */
	observe(target: Element, listener: (onScreen: boolean) => void): () => void;
	/** runs callback after ms milliseconds; returns a handle for clearTimeout */
	setTimeout(callback: () => void, ms: number): unknown;
	/** cancels a timer from setTimeout */
	clearTimeout(handle: unknown): void;
};

/**
 * Lets a site say which of its own loops spool may pause: a loop pauses while its target is off
 * screen, and while the page has been hidden for `hiddenAfterMs`. The hook never touches
 * `setInterval`, `requestAnimationFrame`, `fetch`, audio, WebRTC or any element the site did not
 * hand over.
 */
export function createActivity(host: ActivityHost = browserActivityHost()) {
	return {
		/** pauses the loop while its target is off screen or the page is hidden */
		register(controls: ActivityControls, options: ActivityOptions = {}): () => void {
			const hiddenAfterMs = options.hiddenAfterMs ?? 10_000;
			let onScreen = true;
			let hiddenFor = false;
			let paused = false;
			let done = false;
			let warned = false;
			let timer: unknown = null;

			const call = (method: 'pause' | 'resume') => {
				try {
					controls[method]();
				} catch (error) {
					if (!warned) {
						warned = true;
						console.warn('spool.activity', error);
					}
				}
			};

			const sync = () => {
				if (done) return;
				const want = !onScreen || hiddenFor;
				if (want === paused) return;
				paused = want;
				call(want ? 'pause' : 'resume');
			};

			const clear = () => {
				if (timer === null) return;
				host.clearTimeout(timer);
				timer = null;
			};

			const hiddenChanged = () => {
				if (done) return;
				if (!host.hidden()) {
					clear();
					hiddenFor = false;
					sync();
					return;
				}
				if (hiddenFor || timer !== null) return;
				if (hiddenAfterMs <= 0) {
					hiddenFor = true;
					sync();
					return;
				}
				timer = host.setTimeout(() => {
					timer = null;
					if (host.hidden()) {
						hiddenFor = true;
						sync();
					}
				}, hiddenAfterMs);
			};

			const stopVisibility = host.onVisibilityChange(hiddenChanged);
			const stopObserving = options.target
				? host.observe(options.target, (next) => {
						onScreen = next;
						sync();
					})
				: () => undefined;
			hiddenChanged();

			return () => {
				if (done) return;
				done = true;
				clear();
				stopVisibility();
				stopObserving();
				if (paused) {
					paused = false;
					call('resume');
				}
			};
		}
	};
}

export function browserActivityHost(): ActivityHost {
	return {
		hidden: () => document.hidden,
		onVisibilityChange(listener) {
			document.addEventListener('visibilitychange', listener);
			return () => document.removeEventListener('visibilitychange', listener);
		},
		observe(target, listener) {
			if (typeof IntersectionObserver === 'undefined') {
				listener(true);
				return () => undefined;
			}
			const observer = new IntersectionObserver(
				(entries) => {
					const entry = entries.at(-1);
					if (entry) listener(entry.isIntersecting || entry.intersectionRatio > 0);
				},
				{ threshold: 0 }
			);
			observer.observe(target);
			return () => observer.disconnect();
		},
		setTimeout: (callback, ms) => setTimeout(callback, ms),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
	};
}
