import type { WatermarkConfig, WatermarkPosition } from '../components/admin/types';

interface Dimensions {
  width: number;
  height: number;
}

interface Placement {
  width: number;
  height: number;
  left: number;
  top: number;
}

export function drawWatermarkPreview(
  canvas: HTMLCanvasElement,
  sample: HTMLImageElement,
  watermark: HTMLImageElement | null,
  config: WatermarkConfig | null
): void {
  const pixelRatio = window.devicePixelRatio || 1;
  const containerWidth = Math.max(1, canvas.parentElement?.clientWidth || canvas.clientWidth || 720);
  const aspectRatio = sample.naturalWidth > 0 ? sample.naturalHeight / sample.naturalWidth : 0.65;
  const maxDisplayHeight = Math.max(320, Math.min(window.innerHeight * 0.72, 820));
  let displayWidth = containerWidth;
  let displayHeight = Math.round(displayWidth * aspectRatio);

  if (displayHeight > maxDisplayHeight) {
    displayHeight = Math.round(maxDisplayHeight);
    displayWidth = Math.min(containerWidth, Math.round(displayHeight / aspectRatio));
  }

  canvas.width = Math.round(displayWidth * pixelRatio);
  canvas.height = Math.round(displayHeight * pixelRatio);
  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;

  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, displayWidth, displayHeight);
  context.drawImage(sample, 0, 0, displayWidth, displayHeight);

  if (!watermark || !config || config.opacity <= 0) {
    return;
  }

  const placement = computeWatermarkPlacement(
    { width: displayWidth, height: displayHeight },
    { width: watermark.naturalWidth, height: watermark.naturalHeight },
    config
  );

  context.save();
  context.globalAlpha = config.opacity;
  context.drawImage(watermark, placement.left, placement.top, placement.width, placement.height);
  context.restore();
}

export function computeWatermarkPlacement(
  image: Dimensions,
  watermark: Dimensions,
  config: Pick<WatermarkConfig, 'position' | 'marginPct' | 'widthPct' | 'minWidthPx' | 'maxWidthPx'>
): Placement {
  const shortestSide = Math.max(1, Math.min(image.width, image.height));
  const widthBasis = Math.max(1, image.width);
  const margin = Math.max(0, Math.round((config.marginPct / 100) * shortestSide));
  const desiredWidth = Math.round((config.widthPct / 100) * widthBasis);
  const width = clamp(desiredWidth, config.minWidthPx, Math.min(config.maxWidthPx, image.width - margin * 2));
  const scale = watermark.width > 0 ? width / watermark.width : 1;
  const height = Math.max(1, Math.round(watermark.height * scale));
  const coordinates = coordinatesFor(config.position, image, { width, height }, margin);

  return {
    width,
    height,
    left: coordinates.left,
    top: coordinates.top
  };
}

function coordinatesFor(
  position: WatermarkPosition,
  image: Dimensions,
  overlay: Dimensions,
  margin: number
): { left: number; top: number } {
  const [vertical, horizontal] = position.split('-');
  let left = margin;
  let top = margin;

  if (horizontal === 'center') {
    left = Math.round((image.width - overlay.width) / 2);
  } else if (horizontal === 'right') {
    left = image.width - overlay.width - margin;
  }

  if (vertical === 'middle') {
    top = Math.round((image.height - overlay.height) / 2);
  } else if (vertical === 'bottom') {
    top = image.height - overlay.height - margin;
  }

  return {
    left: clamp(left, 0, Math.max(0, image.width - overlay.width)),
    top: clamp(top, 0, Math.max(0, image.height - overlay.height))
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
