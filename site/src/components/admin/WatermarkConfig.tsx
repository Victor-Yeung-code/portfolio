import { useEffect, useMemo, useState } from 'react';
import { adminApi, putSignedObject } from './api';
import type { WatermarkConfig, WatermarkResponse } from './types';
import { watermarkPositions } from './types';
import { WatermarkPreview } from './WatermarkPreview';

interface WatermarkConfigPanelProps {
  response: WatermarkResponse;
  onChanged: (response: WatermarkResponse) => void;
  onError: (message: string) => void;
}

const defaultConfig: WatermarkConfig = {
  file: '',
  position: 'bottom-right',
  marginPct: 3,
  widthPct: 15,
  opacity: 0.7,
  minWidthPx: 40,
  maxWidthPx: 600
};

export function WatermarkConfigPanel({ response, onChanged, onError }: WatermarkConfigPanelProps) {
  const [config, setConfig] = useState<WatermarkConfig>(response.config ?? defaultConfig);
  const [previewUrl, setPreviewUrl] = useState(response.previewUrl ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setConfig(response.config ?? defaultConfig);
    setPreviewUrl(response.previewUrl ?? '');
  }, [response]);

  const canSave = Boolean(config.file);
  const selectedFileUrl = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  const effectivePreviewUrl = selectedFileUrl || previewUrl;

  useEffect(
    () => () => {
      if (selectedFileUrl) {
        URL.revokeObjectURL(selectedFileUrl);
      }
    },
    [selectedFileUrl]
  );

  const uploadWatermark = async () => {
    if (!file) {
      return;
    }

    setUploading(true);
    onError('');

    try {
      const uploadUrl = await adminApi.createUploadUrl({
        filename: file.name,
        contentType: file.type || 'image/png',
        kind: 'watermark'
      });
      await putSignedObject(uploadUrl.url, file, uploadUrl.headers);
      setConfig((current) => ({ ...current, file: uploadUrl.key }));
      setPreviewUrl(selectedFileUrl);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to upload watermark.');
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (!canSave) {
      return;
    }

    setSaving(true);
    onError('');

    try {
      const response = await adminApi.saveWatermark(config);
      onChanged({ config: response.config, previewUrl: effectivePreviewUrl });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to save watermark.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="watermark-grid">
      <div className="control-panel">
        <div className="upload-band is-compact">
          <label className="file-picker">
            <span>{file?.name || config.file || 'Select PNG'}</span>
            <input accept="image/png" onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} type="file" />
          </label>
          <button disabled={!file || uploading} onClick={() => void uploadWatermark()} type="button">
            {uploading ? 'Uploading' : 'Upload PNG'}
          </button>
        </div>

        <div className="anchor-picker" aria-label="Watermark position">
          <span>Position</span>
          <div className="anchor-grid">
            {watermarkPositions.map((position) => (
              <button
                aria-label={position}
                aria-pressed={config.position === position}
                className={config.position === position ? 'is-active' : ''}
                key={position}
                onClick={() => setConfig({ ...config, position })}
                type="button"
              >
                <span className={`anchor-dot is-${position}`} />
              </button>
            ))}
          </div>
        </div>

        <div className="slider-grid">
          <label>
            <span>Width %</span>
            <input
              max={50}
              min={1}
              onChange={(event) => setConfig({ ...config, widthPct: Number(event.currentTarget.value) })}
              type="range"
              value={config.widthPct}
            />
            <output>{config.widthPct}</output>
          </label>
          <label>
            <span>Margin %</span>
            <input
              max={20}
              min={0}
              onChange={(event) => setConfig({ ...config, marginPct: Number(event.currentTarget.value) })}
              type="range"
              value={config.marginPct}
            />
            <output>{config.marginPct}</output>
          </label>
          <label>
            <span>Opacity</span>
            <input
              max={1}
              min={0}
              onChange={(event) => setConfig({ ...config, opacity: Number(event.currentTarget.value) })}
              step={0.05}
              type="range"
              value={config.opacity}
            />
            <output>{config.opacity.toFixed(2)}</output>
          </label>
        </div>

        <div className="field-grid two-up">
          <label>
            <span>Min px</span>
            <input
              min={1}
              onChange={(event) => setConfig({ ...config, minWidthPx: Number(event.currentTarget.value) })}
              type="number"
              value={config.minWidthPx}
            />
          </label>
          <label>
            <span>Max px</span>
            <input
              min={1}
              onChange={(event) => setConfig({ ...config, maxWidthPx: Number(event.currentTarget.value) })}
              type="number"
              value={config.maxWidthPx}
            />
          </label>
        </div>

        <button disabled={!canSave || saving} onClick={() => void save()} type="button">
          {saving ? 'Saving' : 'Save Watermark'}
        </button>
      </div>

      <WatermarkPreview config={config.file ? config : null} watermarkUrl={effectivePreviewUrl} />
    </div>
  );
}
