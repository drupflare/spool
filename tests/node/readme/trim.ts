import { spoolProxy } from '../../../src/proxy/index';
import { memoryStore } from '../../../src/stores/index';
import { buildTrimManifest } from '../../../src/trim/index';

export const manifest = await buildTrimManifest({
	pages: ['<body class="hero"><a class="button">Apply</a></body>'],
	scripts: [{ url: '/js/site.js', text: 'menu.classList.add("open")' }],
	styles: [{ url: '/css/site.css', text: '.hero{a:b}.button{c:d}.open{e:f}.print-only{g:h}' }]
});

export const proxy = spoolProxy({
	origin: 'https://origin.example.edu',
	spool: { store: memoryStore() },
	trim: manifest
});
