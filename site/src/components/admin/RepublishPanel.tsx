import { useState } from 'react';
import { adminApi } from './api';
import type { RepublishStatus } from './types';

interface RepublishPanelProps {
  onDone: () => void;
  onError: (message: string) => void;
}

export function RepublishPanel({ onDone, onError }: RepublishPanelProps) {
  const [running, setRunning] = useState(false);
  const [queued, setQueued] = useState(0);
  const [processing, setProcessing] = useState(0);
  const [message, setMessage] = useState('');

  const start = async () => {
    if (!window.confirm('Republish all image variants now?')) {
      return;
    }

    setRunning(true);
    setQueued(0);
    setProcessing(0);
    setMessage('');
    onError('');

    try {
      const response = await adminApi.republish();
      setQueued(response.queued);
      setMessage(`Queued ${response.queued} photos.`);

      const finalStatus = await waitForQueue((status) => {
        setQueued(status.queued);
        setProcessing(status.processing);
      });

      setQueued(finalStatus.queued);
      setProcessing(finalStatus.processing);
      const invalidation = await adminApi.invalidatePhotos();
      setMessage(invalidation.invalidationId ? `Invalidation ${invalidation.invalidationId} created.` : 'Invalidation created.');
      onDone();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Republish failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="republish-panel">
      <div className="queue-meter">
        <div>
          <span>Queued</span>
          <strong>{queued}</strong>
        </div>
        <div>
          <span>Processing</span>
          <strong>{processing}</strong>
        </div>
      </div>

      {message && <p className="republish-message">{message}</p>}

      <button disabled={running} onClick={() => void start()} type="button">
        {running ? 'Republishing' : 'Republish All'}
      </button>
    </div>
  );
}

async function waitForQueue(onStatus: (status: RepublishStatus) => void): Promise<RepublishStatus> {
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
