import spool from '../spool';

// the pack a family route's ring and rows come from; the app publishes it at boot
export default defineNitroPlugin(async () => {
	await spool.publish(new URL('http://127.0.0.1/'));
});
