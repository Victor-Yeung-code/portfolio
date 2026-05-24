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

export interface PhotosDocument {
  data: PhotosJson;
  etag?: string;
  exists: boolean;
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
