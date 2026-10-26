import { createActivity } from '../../../src/client/index';

const canvas = document.querySelector('canvas') as HTMLCanvasElement;
let frame = 0;

const draw = () => {
	canvas.style.transform = `translateX(${(performance.now() / 10) % 200}px)`;
	frame = requestAnimationFrame(draw);
};

draw();

export const stop = createActivity().register(
	{ pause: () => cancelAnimationFrame(frame), resume: draw },
	{ target: canvas, hiddenAfterMs: 10_000 }
);
