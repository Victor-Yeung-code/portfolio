import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { hasErrorName, stripBom } from './photos-json.js';
import type { WatermarkConfig, WatermarkPosition, WatermarkProfile, WatermarkSettings } from './types.js';
import { watermarkPositions } from './types.js';

export const watermarkJsonKey = 'data/watermark.json';

const watermarkPositionSet = new Set<string>(watermarkPositions);
const defaultProfileSettings: Omit<WatermarkProfile, 'id' | 'name'> = {
  position: 'bottom-right',
  marginPct: 3,
  widthPct: 15,
  opacity: 0.7,
  minWidthPx: 40,
  maxWidthPx: 600
};

interface WatermarkDocument {
  data: WatermarkSettings;
  etag?: string;
  exists: boolean;
}

export async function readWatermarkSettings(s3: S3Client, bucketName: string): Promise<WatermarkSettings> {
  return (await readWatermarkDocument(s3, bucketName, true)).data;
}

export async function updateWatermarkSettings(
  s3: S3Client,
  bucketName: string,
  mutator: (current: WatermarkSettings) => WatermarkSettings
): Promise<WatermarkSettings> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const document = await readWatermarkDocument(s3, bucketName, true);
    const next = normalizeWatermarkSettings(mutator(document.data));

    try {
      await putWatermarkSettings(s3, bucketName, next, document);
      return next;
    } catch (error) {
      if (isConditionalWriteFailure(error) && attempt < 5) {
        await sleep(100 * attempt);
        continue;
      }

      throw error;
    }
  }

  throw new Error('Unable to update watermark settings.');
}

export function createEmptyWatermarkSettings(): WatermarkSettings {
  return {
    file: '',
    defaultProfileForUploads: null,
    profiles: []
  };
}

export function createWatermarkProfile(
  id: unknown,
  input: Partial<WatermarkProfile>,
  fallback: Partial<WatermarkProfile> = defaultProfileSettings
): WatermarkProfile | null {
  const safeId = normalizeProfileId(id);
  const name = stringValue(input.name) || stringValue(fallback.name);

  if (!safeId || !name) {
    return null;
  }

  const minWidthPx = positiveNumber(input.minWidthPx, fallback.minWidthPx ?? defaultProfileSettings.minWidthPx);
  const maxWidthPx = Math.max(
    minWidthPx,
    positiveNumber(input.maxWidthPx, fallback.maxWidthPx ?? defaultProfileSettings.maxWidthPx)
  );

  return {
    id: safeId,
    name: name.slice(0, 80),
    position: normalizePosition(input.position, fallback.position),
    marginPct: clamp(nonNegativeNumber(input.marginPct, fallback.marginPct ?? defaultProfileSettings.marginPct), 0, 20),
    widthPct: clamp(positiveNumber(input.widthPct, fallback.widthPct ?? defaultProfileSettings.widthPct), 1, 50),
    opacity: clamp(nonNegativeNumber(input.opacity, fallback.opacity ?? defaultProfileSettings.opacity), 0, 1),
    minWidthPx,
    maxWidthPx
  };
}

export function normalizeProfileId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(trimmed) ? trimmed : null;
}

export function normalizeNullableProfileId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  return normalizeProfileId(value);
}

export function slugifyProfileName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'profile';
}

export function normalizeWatermarkFile(value: unknown, allowEmpty = true): string | null {
  if (typeof value !== 'string') {
    return allowEmpty ? '' : null;
  }

  const file = value.trim().replace(/^\/+/, '');
  if (!file && allowEmpty) {
    return '';
  }

  if (!file || !file.startsWith('watermarks/') || file.includes('..') || !file.toLowerCase().endsWith('.png')) {
    return null;
  }

  return file;
}

export function normalizeWatermarkSettings(input: unknown): WatermarkSettings {
  if (!isObject(input)) {
    return createEmptyWatermarkSettings();
  }

  if (!Array.isArray(input.profiles)) {
    return migrateLegacyWatermarkConfig(input as Partial<WatermarkConfig>);
  }

  const profiles = input.profiles
    .map((profile) => (isObject(profile) ? createWatermarkProfile(profile.id, profile as Partial<WatermarkProfile>) : null))
    .filter((profile): profile is WatermarkProfile => profile !== null);
  const file = normalizeWatermarkFile(input.file) ?? '';
  const defaultProfileForUploads = normalizeNullableProfileId(input.defaultProfileForUploads);

  return {
    file,
    defaultProfileForUploads:
      defaultProfileForUploads && profiles.some((profile) => profile.id === defaultProfileForUploads)
        ? defaultProfileForUploads
        : null,
    profiles
  };
}

async function readWatermarkDocument(
  s3: S3Client,
  bucketName: string,
  migrateLegacy: boolean
): Promise<WatermarkDocument> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: watermarkJsonKey }));
    const body = response.Body ? await response.Body.transformToString('utf-8') : '';
    const parsed = body.trim() ? JSON.parse(stripBom(body)) as unknown : {};
    const data = normalizeWatermarkSettings(parsed);

    if (migrateLegacy && isLegacyWatermarkConfig(parsed)) {
      const document = { data, etag: response.ETag, exists: true };
      try {
        await putWatermarkSettings(s3, bucketName, data, document);
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          return readWatermarkDocument(s3, bucketName, true);
        }

        throw error;
      }
      return readWatermarkDocument(s3, bucketName, false);
    }

    return {
      data,
      etag: response.ETag,
      exists: true
    };
  } catch (error) {
    if (hasErrorName(error, 'NoSuchKey')) {
      return {
        data: createEmptyWatermarkSettings(),
        exists: false
      };
    }

    throw error;
  }
}

async function putWatermarkSettings(
  s3: S3Client,
  bucketName: string,
  settings: WatermarkSettings,
  document: WatermarkDocument
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: watermarkJsonKey,
      Body: JSON.stringify(settings, null, 2),
      CacheControl: 'public, max-age=60',
      ContentType: 'application/json; charset=utf-8',
      ...(document.exists ? { IfMatch: document.etag } : { IfNoneMatch: '*' })
    })
  );
}

function migrateLegacyWatermarkConfig(input: Partial<WatermarkConfig>): WatermarkSettings {
  const file = normalizeWatermarkFile(input.file) ?? '';
  const profile = createWatermarkProfile('standard', {
    name: 'Standard',
    position: input.position,
    marginPct: input.marginPct,
    widthPct: input.widthPct,
    opacity: input.opacity,
    minWidthPx: input.minWidthPx,
    maxWidthPx: input.maxWidthPx
  });

  return {
    file,
    defaultProfileForUploads: null,
    profiles: profile ? [profile] : []
  };
}

function isLegacyWatermarkConfig(input: unknown): boolean {
  return isObject(input) && !Array.isArray(input.profiles);
}

function normalizePosition(value: unknown, fallback: unknown): WatermarkPosition {
  if (typeof value === 'string' && watermarkPositionSet.has(value)) {
    return value as WatermarkPosition;
  }

  if (typeof fallback === 'string' && watermarkPositionSet.has(fallback)) {
    return fallback as WatermarkPosition;
  }

  return defaultProfileSettings.position;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isConditionalWriteFailure(error: unknown): boolean {
  return hasErrorName(error, 'PreconditionFailed') || hasErrorName(error, 'ConditionalRequestConflict');
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
