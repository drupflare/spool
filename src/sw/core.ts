import type { SwConfig } from '../protocol/config.js';
import { manifestConfig, serve } from './serve.js';

const scope = self as unknown as { __SPOOL_CONFIG__?: SwConfig; location: Location };

serve(scope.__SPOOL_CONFIG__ ?? manifestConfig(scope.location.href));
