import { createSpool } from '../../../src/server/index';
import { memoryStore } from '../../../src/stores/index';
import { routes } from './routes';

export const shadowed = createSpool({ routes, store: memoryStore(), mode: 'shadow' });
export const canary = createSpool({ routes, store: memoryStore(), shadowSample: 0.05 });
