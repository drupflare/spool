import { createSpool } from '../../../src/server/index';
import { routes } from './routes';
import { store } from './store';

export const spool = createSpool({ routes, store });
