import {
  DeleteObjectsCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import type { S3Event, S3EventRecord, SQSEvent, SQSRecord } from 'aws-lambda';
import sharp from 'sharp';
import { basename, extname } from 'node:path';
import { hasErrorName, readPhotosJson, updatePhotosJson as updateStoredPhotosJson } from '../_shared/photos-json.js';
import type { PhotoEntry, PhotoVariantName, PhotosJson, WatermarkPosition, WatermarkProfile, WatermarkSettings } from '../_shared/types.js';
import { readWatermarkSettings } from '../_shared/watermark.js';

const s3 = new S3Client({});

const bucketName = requiredEnv('PHOTOS_BUCKET');
const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif']);
const fullVariantExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.avif'];
const staleFullVariantExtensions = fullVariantExtensions.filter((extension) => extension !== '.png');

type ImageEvent = S3Event | SQSEvent;

interface OriginalObject {
  bytes: Uint8Array;
  lastModified: string | null;
}

interface ImageDimensions {
  width: number;
  height: number;
}

interface WatermarkState {
  settings: WatermarkSettings;
  source?: Uint8Array;
}

interface ResolvedWatermark {
  enabled: boolean;
  profile?: WatermarkProfile;
  source?: Uint8Array;
}

interface InvocationContext {
  getWatermark: () => Promise<WatermarkState>;
}

interface CreateOptions {
  metadataMode: 'upload' | 'reprocess';
}

interface VariantResult {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
}

export const handler = async (event: ImageEvent): Promise<{ processed: number }> => {
  const context = createInvocationContext();
  let processed = 0;

  if (isSqsEvent(event)) {
    for (const record of event.Records) {
      await handleSqsRecord(record, context);
      processed += 1;
    }

    return { processed };
  }

  for (const record of event.Records) {
    await handleRecord(record, context);
    processed += 1;
  }

  return { processed };
};

function createInvocationContext(): InvocationContext {
  let watermarkPromise: Promise<WatermarkState> | undefined;

  return {
    getWatermark: () => {
      watermarkPromise ??= readWatermarkState();
      return watermarkPromise;
    }
  };
}

async function handleSqsRecord(record: SQSRecord, context: InvocationContext): Promise<void> {
  const body = JSON.parse(record.body) as { originalKey?: string };

  if (!body.originalKey) {
    throw new Error(`SQS message ${record.messageId} did not include originalKey.`);
  }

  await handleCreated(body.originalKey, context, { metadataMode: 'reprocess' });
}

async function handleRecord(record: S3EventRecord, context: InvocationContext): Promise<void> {
  const key = decodeS3Key(record.s3.object.key);

  if (!key.startsWith('originals/')) {
    console.log(`Skipping non-original key: ${key}`);
    return;
  }

  const eventName = record.eventName;
  if (eventName.startsWith('ObjectCreated:')) {
    await handleCreated(key, context, { metadataMode: 'upload' });
    return;
  }

  if (eventName.startsWith('ObjectRemoved:')) {
    await handleRemoved(key);
    return;
  }

  console.log(`Skipping unsupported event ${eventName} for ${key}`);
}

async function handleCreated(
  originalKey: string,
  context: InvocationContext,
  options: CreateOptions
): Promise<void> {
  const extension = extname(originalKey).toLowerCase();
  if (!supportedExtensions.has(extension)) {
    console.warn(`Unsupported image extension for ${originalKey}`);
    return;
  }

  const id = basename(originalKey, extension);
  if (!id) {
    console.warn(`Unable to derive photo id from ${originalKey}`);
    return;
  }

  const original = await getOriginalObject(originalKey);
  const baseImage = sharp(original.bytes, { failOn: 'none', sequentialRead: true }).rotate();
  const metadata = await baseImage.metadata();
  const dimensions = normalizedDimensions(metadata);
  const createdAt = original.lastModified;
  const now = new Date().toISOString();
  const [photosDocument, watermarkState] = await Promise.all([
    readPhotosJson(s3, bucketName),
    context.getWatermark()
  ]);
  const existing = photosDocument.data.photos.find((photo) => photo.id === id);
  const watermarkProfile = existing ? existing.watermarkProfile ?? null : watermarkState.settings.defaultProfileForUploads;
  const watermark = resolveWatermark(watermarkState, watermarkProfile, id);

  const variantKeys: Record<PhotoVariantName, string> = {
    thumb: `thumb/${id}.webp`,
    medium: `medium/${id}.webp`,
    full: `full/${id}.png`
  };

  const [thumb, medium, full] = await Promise.all([
    renderWebpVariant(baseImage.clone(), dimensions, resizeToWidth(dimensions, 400), variantKeys.thumb, watermark),
    renderWebpVariant(baseImage.clone(), dimensions, resizeToWidth(dimensions, 1200), variantKeys.medium, watermark),
    renderFullVariant(
      baseImage.clone(),
      dimensions,
      variantKeys.full,
      extension,
      original.bytes,
      watermark
    )
  ]);

  await Promise.all([putVariant(thumb), putVariant(medium), putVariant(full)]);
  await deleteStaleFullVariants(id);

  await upsertPhotoMetadata(
    id,
    originalKey,
    variantKeys,
    dimensions,
    createdAt,
    now,
    options.metadataMode,
    watermarkProfile
  );

  console.log(`Processed ${originalKey} into ${Object.values(variantKeys).join(', ')}`);
}

async function upsertPhotoMetadata(
  id: string,
  originalKey: string,
  variantKeys: Record<PhotoVariantName, string>,
  dimensions: ImageDimensions,
  createdAt: string | null,
  now: string,
  metadataMode: CreateOptions['metadataMode'],
  watermarkProfile: string | null
): Promise<void> {
  await updatePhotosJson((current) => {
    const existing = current.photos.find((photo) => photo.id === id);
    const previousCreatedAt = existing?.createdAt ?? createdAt ?? now;
    const order =
      existing?.order ??
      (current.photos.length === 0 ? 1 : Math.max(...current.photos.map((photo) => photo.order)) + 1);

    const entry: PhotoEntry = {
      id,
      title: existing?.title ?? humanizeTitle(id),
      description: existing?.description ?? '',
      album: existing?.album ?? '',
      watermarkProfile: existing ? existing.watermarkProfile ?? null : watermarkProfile,
      order,
      originalKey,
      variants: {
        thumb: `/photos/${variantKeys.thumb}`,
        medium: `/photos/${variantKeys.medium}`,
        full: `/photos/${variantKeys.full}`
      },
      width: dimensions.width,
      height: dimensions.height,
      takenAt: existing?.takenAt ?? null,
      createdAt: previousCreatedAt,
      updatedAt: now,
      deleted: existing?.deleted ?? false,
      deletedAt: existing?.deletedAt ?? null
    };

    if (existing && photoEntriesEqual(existing, entry)) {
      return current;
    }

    const photos = current.photos.filter((photo) => photo.id !== id);
    photos.push(entry);
    photos.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));

    return {
      version: current.version + 1,
      updatedAt: now,
      photos
    };
  });
}

async function handleRemoved(originalKey: string): Promise<void> {
  const extension = extname(originalKey).toLowerCase();
  const id = basename(originalKey, extension);

  if (!id) {
    console.warn(`Unable to derive photo id from deleted key ${originalKey}`);
    return;
  }

  await deleteVariants(id);

  await updatePhotosJson((current) => {
    const photos = current.photos.filter((photo) => photo.id !== id);
    if (photos.length === current.photos.length) {
      return current;
    }

    return {
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      photos
    };
  });

  console.log(`Removed variants and metadata for ${originalKey}`);
}

async function renderWebpVariant(
  pipeline: sharp.Sharp,
  sourceDimensions: ImageDimensions,
  dimensions: ImageDimensions,
  key: string,
  watermark: ResolvedWatermark
): Promise<VariantResult> {
  if (dimensions.width) {
    pipeline = pipeline.resize({ width: dimensions.width, withoutEnlargement: true });
  }

  pipeline = await applyWatermark(pipeline, dimensions, watermark, sourceDimensions);

  return {
    key,
    body: await pipeline.webp({ quality: 82, effort: 4 }).toBuffer(),
    contentType: 'image/webp'
  };
}

async function renderFullVariant(
  pipeline: sharp.Sharp,
  dimensions: ImageDimensions,
  key: string,
  extension: string,
  originalBytes: Uint8Array,
  watermark: ResolvedWatermark
): Promise<VariantResult> {
  if (!watermark.enabled && extension === '.png') {
    return {
      key,
      body: originalBytes,
      contentType: 'image/png'
    };
  }

  if (watermark.enabled) {
    pipeline = await applyWatermark(pipeline, dimensions, watermark);
  }

  return {
    key,
    body: await pipeline
      .keepMetadata()
      .withMetadata({ orientation: 1 })
      .png({ compressionLevel: 9, progressive: true })
      .toBuffer(),
    contentType: 'image/png'
  };
}

async function applyWatermark(
  pipeline: sharp.Sharp,
  dimensions: ImageDimensions,
  watermark: ResolvedWatermark,
  referenceDimensions: ImageDimensions = dimensions
): Promise<sharp.Sharp> {
  if (!watermark.enabled || !watermark.profile || !watermark.source) {
    return pipeline;
  }

  const overlay = await renderWatermarkOverlay(watermark.source, watermark.profile, dimensions, referenceDimensions);
  if (!overlay) {
    return pipeline;
  }

  return pipeline.composite([
    {
      input: overlay.buffer,
      left: overlay.left,
      top: overlay.top
    }
  ]);
}

async function renderWatermarkOverlay(
  watermarkBuffer: Uint8Array,
  config: WatermarkProfile,
  image: ImageDimensions,
  referenceImage: ImageDimensions = image
): Promise<{ buffer: Buffer; left: number; top: number } | null> {
  const referenceWidth = Math.max(1, referenceImage.width);
  const referenceHeight = Math.max(1, referenceImage.height);
  const scale = Math.min(image.width / referenceWidth, image.height / referenceHeight);
  const shortestSide = Math.max(1, Math.min(referenceWidth, referenceHeight));
  const referenceMargin = Math.max(0, Math.round((config.marginPct / 100) * shortestSide));
  const referenceMaxOverlayWidth = Math.max(1, referenceWidth - referenceMargin * 2);
  const referenceDesiredWidth = Math.round((config.widthPct / 100) * referenceWidth);
  const referenceTargetWidth = clamp(
    referenceDesiredWidth,
    config.minWidthPx,
    Math.min(config.maxWidthPx, referenceMaxOverlayWidth)
  );
  const margin = Math.max(0, Math.round(referenceMargin * scale));
  const maxOverlayWidth = Math.max(1, image.width - margin * 2);
  const targetWidth = clamp(Math.round(referenceTargetWidth * scale), 1, maxOverlayWidth);

  const buffer = await sharp(watermarkBuffer, { failOn: 'none' })
    .resize({ width: targetWidth, withoutEnlargement: false })
    .ensureAlpha()
    .composite([
      {
        input: Buffer.from([255, 255, 255, Math.round(config.opacity * 255)]),
        raw: { width: 1, height: 1, channels: 4 },
        tile: true,
        blend: 'dest-in'
      }
    ])
    .png()
    .toBuffer();

  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) {
    return null;
  }

  const { left, top } = watermarkCoordinates(config.position, image, {
    width: metadata.width,
    height: metadata.height
  }, margin);

  return { buffer, left, top };
}

function watermarkCoordinates(
  position: WatermarkPosition,
  image: ImageDimensions,
  overlay: ImageDimensions,
  margin: number
): { left: number; top: number } {
  const [vertical, horizontal] = position.split('-') as [string, string];
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

async function readWatermarkState(): Promise<WatermarkState> {
  const settings = await readWatermarkSettings(s3, bucketName);

  if (!settings.file) {
    return { settings };
  }

  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: settings.file }));
    if (!response.Body) {
      console.warn(`Watermark object was empty: ${settings.file}`);
      return { settings };
    }

    return {
      settings,
      source: await response.Body.transformToByteArray()
    };
  } catch (error) {
    if (error instanceof NoSuchKey || hasErrorName(error, 'NoSuchKey')) {
      console.warn(`Watermark object was not found: ${settings.file}`);
      return { settings };
    }

    throw error;
  }
}

function resolveWatermark(state: WatermarkState, profileId: string | null, photoId: string): ResolvedWatermark {
  if (!profileId) {
    return { enabled: false };
  }

  const profile = state.settings.profiles.find((item) => item.id === profileId);
  if (!profile) {
    console.warn(`Photo ${photoId} references missing watermark profile: ${profileId}`);
    return { enabled: false };
  }

  if (!state.settings.file || !state.source || profile.opacity <= 0) {
    return { enabled: false };
  }

  return {
    enabled: true,
    profile,
    source: state.source
  };
}

async function getOriginalObject(key: string): Promise<OriginalObject> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));

  if (!response.Body) {
    throw new Error(`S3 object body was empty for ${key}`);
  }

  return {
    bytes: await response.Body.transformToByteArray(),
    lastModified: response.LastModified?.toISOString() ?? null
  };
}

async function putVariant(variant: VariantResult): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: variant.key,
      Body: variant.body,
      CacheControl: 'public, max-age=31536000, immutable',
      ContentType: variant.contentType
    })
  );
}

async function deleteVariants(id: string): Promise<void> {
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: {
        Objects: [
          { Key: `thumb/${id}.webp` },
          { Key: `medium/${id}.webp` },
          ...fullVariantExtensions.map((extension) => ({ Key: `full/${id}${extension}` }))
        ],
        Quiet: true
      }
    })
  );
}

async function deleteStaleFullVariants(id: string): Promise<void> {
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: {
        Objects: staleFullVariantExtensions.map((extension) => ({ Key: `full/${id}${extension}` })),
        Quiet: true
      }
    })
  );
}

async function updatePhotosJson(mutator: (current: PhotosJson) => PhotosJson): Promise<void> {
  await updateStoredPhotosJson(s3, bucketName, mutator);
}

function normalizedDimensions(metadata: sharp.Metadata): ImageDimensions {
  if (!metadata.width || !metadata.height) {
    throw new Error('Unable to read image dimensions.');
  }

  if (metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8) {
    return {
      width: metadata.height,
      height: metadata.width
    };
  }

  return {
    width: metadata.width,
    height: metadata.height
  };
}

function resizeToWidth(dimensions: ImageDimensions, targetWidth: number): ImageDimensions {
  if (dimensions.width <= targetWidth) {
    return dimensions;
  }

  return {
    width: targetWidth,
    height: Math.max(1, Math.round((dimensions.height * targetWidth) / dimensions.width))
  };
}

function decodeS3Key(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}

function humanizeTitle(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function photoEntriesEqual(left: PhotoEntry, right: PhotoEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSqsEvent(event: ImageEvent): event is SQSEvent {
  return event.Records[0] ? 'messageId' in event.Records[0] : false;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }

  return value;
}
