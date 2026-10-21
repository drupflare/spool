import { type ImageEncoder } from '../../../src/media/index';
import { spoolProxy } from '../../../src/proxy/index';
import { memoryStore } from '../../../src/stores/index';

export function mediaProxy(encoder: ImageEncoder) {
	return spoolProxy({
		origin: 'https://origin.example.edu',
		spool: { store: memoryStore() },
		images: { encoder, width: { fallback: 1600 } },
		video: { preload: 'none', autoplay: 'defer', when: 'slow' }
	});
}
