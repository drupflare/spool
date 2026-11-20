import { spoolReactRouter } from '@drupflare/spool/react-router';
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import { spool } from './server/spool';

export default defineConfig({
	plugins: [reactRouter(), spoolReactRouter({ spool })]
});
