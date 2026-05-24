export type PhotoVariantName = 'thumb' | 'medium' | 'full';

export type WatermarkPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'middle-center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface PhotoEntry {
  id: string;
  title: string;
  description: string;
  album: string;
  order: number;
  originalKey: string;
  variants: Record<PhotoVariantName, string>;
  width: number;
  height: number;
  takenAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
  deletedAt?: string | null;
}

export interface PhotosJson {
  version: number;
  updatedAt: string;
  photos: PhotoEntry[];
}

export interface WatermarkConfig {
  file: string;
  position: WatermarkPosition;
  marginPct: number;
  widthPct: number;
  opacity: number;
  minWidthPx: number;
  maxWidthPx: number;
}

export interface WatermarkResponse {
  config: WatermarkConfig | null;
  previewUrl?: string;
}

export interface UploadUrlResponse {
  id?: string;
  key: string;
  url: string;
  headers: Record<string, string>;
}

export interface RepublishStatus {
  queued: number;
  processing: number;
}

export const watermarkPositions: WatermarkPosition[] = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
];
