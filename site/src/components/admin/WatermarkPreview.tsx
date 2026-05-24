import { useEffect, useRef, useState } from 'react';
import { drawWatermarkPreview } from '../../lib/watermark-preview';
import type { WatermarkConfig } from './types';

interface WatermarkPreviewProps {
  config: WatermarkConfig | null;
  watermarkUrl: string;
}

const samples = [
  { id: 'landscape', label: 'Landscape', src: '/admin/samples/landscape.jpg' },
  { id: 'portrait', label: 'Portrait', src: '/admin/samples/portrait.jpg' },
  { id: 'square', label: 'Square', src: '/admin/samples/square.jpg' }
];

export function WatermarkPreview({ config, watermarkUrl }: WatermarkPreviewProps) {
  const [sampleId, setSampleId] = useState(samples[0].id);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sampleImageRef = useRef<HTMLImageElement | null>(null);
  const watermarkImageRef = useRef<HTMLImageElement | null>(null);
  const sample = samples.find((item) => item.id === sampleId) ?? samples[0];

  useEffect(() => {
    let active = true;
    const sampleImage = new Image();
    sampleImage.crossOrigin = 'anonymous';
    sampleImage.src = sample.src;

    sampleImage.onload = () => {
      if (!active) {
        return;
      }
      sampleImageRef.current = sampleImage;
      redraw();
    };

    return () => {
      active = false;
    };
  }, [sample.src]);

  useEffect(() => {
    let active = true;

    if (!watermarkUrl) {
      watermarkImageRef.current = null;
      redraw();
      return () => {
        active = false;
      };
    }

    const watermarkImage = new Image();
    watermarkImage.src = watermarkUrl;
    watermarkImage.onload = () => {
      if (!active) {
        return;
      }
      watermarkImageRef.current = watermarkImage;
      redraw();
    };

    return () => {
      active = false;
    };
  }, [watermarkUrl]);

  useEffect(() => {
    redraw();
  }, [config, sampleId]);

  useEffect(() => {
    window.addEventListener('resize', redraw);
    return () => window.removeEventListener('resize', redraw);
  }, []);

  const redraw = () => {
    if (!canvasRef.current || !sampleImageRef.current) {
      return;
    }

    drawWatermarkPreview(canvasRef.current, sampleImageRef.current, watermarkImageRef.current, config);
  };

  return (
    <div className="preview-panel">
      <div className="sample-tabs" aria-label="Preview sample">
        {samples.map((item) => (
          <button
            className={sampleId === item.id ? 'is-active' : ''}
            key={item.id}
            onClick={() => setSampleId(item.id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      <canvas aria-label="Watermark preview" ref={canvasRef} />
    </div>
  );
}
