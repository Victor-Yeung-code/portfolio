import {
  DeleteObjectsCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import type { S3Event, S3EventRecord } from 'aws-lambda';
import sharp from 'sharp';
import { basename, extname } from 'node:path';

const s3 = new S3Client({});

const bucketName = process.env.PHOTOS_BUCKET;
const photosJsonKey = 'data/photos.json';
const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif']);

if (!bucketName) {
  throw new Error('Missing PHOTOS_BUCKET environment variable.');
}

type PhotoVariantName = 'thumb' | 'medium' | 'full';

interface PhotoEntry {
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
}

interface PhotosJson {
  version: number;
  updatedAt: string;
  photos: PhotoEntry[];
}

interface PhotosDocument {
  data: PhotosJson;
  etag?: string;
  exists: boolean;
}

interface OriginalObject {
  bytes: Uint8Array;
  contentType: string;
  lastModified: string | null;
}

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    await handleRecord(record);
  }
};

async function handleRecord(record: S3EventRecord): Promise<void> {
  const key = decodeS3Key(record.s3.object.key);

  if (!key.startsWith('originals/')) {
    console.log(`Skipping non-original key: ${key}`);
    return;
  }

  const eventName = record.eventName;
  if (eventName.startsWith('ObjectCreated:')) {
    await handleCreated(key);
    return;
  }

  if (eventName.startsWith('ObjectRemoved:')) {
    await handleRemoved(key);
    return;
  }

  console.log(`Skipping unsupported event ${eventName} for ${key}`);
}

async function handleCreated(originalKey: string): Promise<void> {
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

  const original = await getOriginalObject(originalKey, extension);
  const baseImage = sharp(original.bytes, { failOn: 'none', sequentialRead: true }).rotate();
  const metadata = await baseImage.metadata();
  const createdAt = original.lastModified;
  const now = new Date().toISOString();

  if (!metadata.width || !metadata.height) {
    throw new Error(`Unable to read dimensions for ${originalKey}`);
  }

  const width = metadata.width;
  const height = metadata.height;

  const variantKeys: Record<PhotoVariantName, string> = {
    thumb: `thumb/${id}.webp`,
    medium: `medium/${id}.webp`,
    full: `full/${id}${extension}`
  };

  const [thumb, medium] = await Promise.all([
    renderVariant(baseImage.clone(), 400),
    renderVariant(baseImage.clone(), 1200)
  ]);

  await Promise.all([
    putWebpVariant(variantKeys.thumb, thumb),
    putWebpVariant(variantKeys.medium, medium),
    putOriginalVariant(variantKeys.full, original.bytes, original.contentType)
  ]);

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
      order,
      originalKey,
      variants: {
        thumb: `/photos/${variantKeys.thumb}`,
        medium: `/photos/${variantKeys.medium}`,
        full: `/photos/${variantKeys.full}`
      },
      width,
      height,
      takenAt: existing?.takenAt ?? null,
      tags: existing?.tags ?? [],
      createdAt: previousCreatedAt,
      updatedAt: now
    };

    const photos = current.photos.filter((photo) => photo.id !== id);
    photos.push(entry);
    photos.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));

    return {
      version: current.version + 1,
      updatedAt: now,
      photos
    };
  });

  console.log(`Processed ${originalKey} into ${Object.values(variantKeys).join(', ')}`);
}

async function handleRemoved(originalKey: string): Promise<void> {
  const extension = extname(originalKey).toLowerCase();
  const id = basename(originalKey, extension);

  if (!id) {
    console.warn(`Unable to derive photo id from deleted key ${originalKey}`);
    return;
  }

  await deleteVariants(id, extension);

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

async function renderVariant(pipeline: sharp.Sharp, width?: number): Promise<Buffer> {
  if (width) {
    pipeline = pipeline.resize({ width, withoutEnlargement: true });
  }

  return pipeline.webp({ quality: 82, effort: 0 }).toBuffer();
}

async function getOriginalObject(key: string, extension: string): Promise<OriginalObject> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));

  if (!response.Body) {
    throw new Error(`S3 object body was empty for ${key}`);
  }

  return {
    bytes: await response.Body.transformToByteArray(),
    contentType: response.ContentType ?? contentTypeForExtension(extension),
    lastModified: response.LastModified?.toISOString() ?? null
  };
}

async function putWebpVariant(key: string, body: Buffer): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      CacheControl: 'public, max-age=31536000, immutable',
      ContentType: 'image/webp'
    })
  );
}

async function putOriginalVariant(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      CacheControl: 'public, max-age=31536000, immutable',
      ContentType: contentType
    })
  );
}

async function deleteVariants(id: string, extension: string): Promise<void> {
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: {
        Objects: [
          { Key: `thumb/${id}.webp` },
          { Key: `medium/${id}.webp` },
          { Key: `full/${id}${extension}` }
        ],
        Quiet: true
      }
    })
  );
}

async function updatePhotosJson(mutator: (current: PhotosJson) => PhotosJson): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const document = await readPhotosJson();
    const next = mutator(document.data);

    if (next === document.data) {
      return;
    }

    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: photosJsonKey,
          Body: JSON.stringify(next, null, 2),
          CacheControl: 'public, max-age=60',
          ContentType: 'application/json; charset=utf-8',
          ...(document.exists ? { IfMatch: document.etag } : { IfNoneMatch: '*' })
        })
      );
      return;
    } catch (error) {
      if (isConditionalWriteFailure(error) && attempt < 5) {
        await sleep(100 * attempt);
        continue;
      }

      throw error;
    }
  }
}

async function readPhotosJson(): Promise<PhotosDocument> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: photosJsonKey }));
    const body = response.Body ? await response.Body.transformToString('utf-8') : '';
    const parsed = body ? (JSON.parse(body) as PhotosJson) : createEmptyPhotosJson();

    return {
      data: normalizePhotosJson(parsed),
      etag: response.ETag,
      exists: true
    };
  } catch (error) {
    if (error instanceof NoSuchKey || hasErrorName(error, 'NoSuchKey')) {
      return {
        data: createEmptyPhotosJson(),
        exists: false
      };
    }

    throw error;
  }
}

function createEmptyPhotosJson(): PhotosJson {
  return {
    version: 0,
    updatedAt: new Date(0).toISOString(),
    photos: []
  };
}

function normalizePhotosJson(input: PhotosJson): PhotosJson {
  return {
    version: typeof input.version === 'number' ? input.version : 0,
    updatedAt: input.updatedAt ?? new Date(0).toISOString(),
    photos: Array.isArray(input.photos) ? input.photos : []
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

function contentTypeForExtension(extension: string): string {
  switch (extension) {
    case '.avif':
      return 'image/avif';
    case '.png':
      return 'image/png';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

function isConditionalWriteFailure(error: unknown): boolean {
  return hasErrorName(error, 'PreconditionFailed') || hasErrorName(error, 'ConditionalRequestConflict');
}

function hasErrorName(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
