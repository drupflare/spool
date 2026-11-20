/** asks the storage manager for persistent storage; a refusal or a throw is `false` */
export async function askPersistence(
	manager: Pick<StorageManager, 'persist' | 'persisted'> | undefined
): Promise<boolean> {
	try {
		return (await manager?.persisted?.()) === true || (await manager?.persist?.()) === true;
	} catch {
		return false;
	}
}
