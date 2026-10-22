import { type ImageEncoder } from '@drupflare/spool/media';
import { spoolProxy } from '@drupflare/spool/proxy';
import { memoryStore } from '@drupflare/spool/stores';

export function rewriteProxy(encoder: ImageEncoder) {
	return spoolProxy({
		origin: 'https://origin.example.edu',
		spool: { store: memoryStore() },
		images: {
			encoder,
			png: 'auto',
			maxWidth: 1920,
			timeoutMs: 5000,
			lazy: { skip: 3 },
			responsive: { widths: [480, 960, 1440], sizes: '(min-width: 60em) 50vw, 100vw' }
		},
		embeds: { providers: ['youtube'], thumbnail: false }
	});
}
