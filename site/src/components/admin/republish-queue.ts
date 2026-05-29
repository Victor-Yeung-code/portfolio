import { adminApi } from './api';
import type { RepublishStatus } from './types';

export async function waitForRepublishQueue(
  onStatus: (status: RepublishStatus) => void = () => undefined
): Promise<RepublishStatus> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await delay(attempt === 0 ? 1500 : 5000);

    const status = await adminApi.republishStatus();
    onStatus(status);

    if (status.queued === 0 && status.processing === 0) {
      return status;
    }
  }

  throw new Error('Republish queue did not drain before the polling timeout.');
}

export async function refreshPhotoCache(): Promise<string> {
  const invalidation = await adminApi.invalidatePhotos();
  return invalidation.invalidationId
    ? `Cache refresh ${invalidation.invalidationId} started.`
    : 'Cache refresh started.';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
