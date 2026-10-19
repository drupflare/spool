import pkg from '../package.json' with { type: 'json' };

/** the package version; the service worker and page runtime compare it on the handshake */
export const VERSION: string = pkg.version;
