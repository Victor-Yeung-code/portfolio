import { useRef, useState } from 'react';
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
  const runIdRef = useRef(0);

  const start = async () => {
    if (!window.confirm('Republish all image variants now?')) {
      return;
    }

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
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
      }, () => runIdRef.current === runId);

      if (!finalStatus) {
        return;
      }

      setQueued(finalStatus.queued);
      setProcessing(finalStatus.processing);
      setMessage('Refreshing CloudFront cache.');
      const invalidation = await adminApi.invalidatePhotos();
      setMessage(
        invalidation.invalidationId
          ? `Cache refresh ${invalidation.invalidationId} started.`
          : 'Cache refresh started.'
      );
      onDone();
    } catch (reason) {
      if (runIdRef.current === runId) {
        onError(reason instanceof Error ? reason.message : 'Republish failed.');
      }
    } finally {
      if (runIdRef.current === runId) {
        setRunning(false);
      }
    }
  };

  const cancelPolling = () => {
    runIdRef.current += 1;
    setRunning(false);
    setMessage('Stopped watching. Republish continues in the background.');
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

      <div className="republish-actions">
        <button disabled={running} onClick={() => void start()} type="button">
          {running ? 'Republishing' : 'Republish All'}
        </button>
        {running && (
          <button className="secondary" onClick={cancelPolling} type="button">
            Cancel polling
          </button>
        )}
      </div>
    </div>
  );
}

async function waitForQueue(
  onStatus: (status: RepublishStatus) => void,
  isActive: () => boolean
): Promise<RepublishStatus | null> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await delay(attempt === 0 ? 1500 : 5000);
    if (!isActive()) {
      return null;
    }

    const status = await adminApi.republishStatus();
    if (!isActive()) {
      return null;
    }

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
