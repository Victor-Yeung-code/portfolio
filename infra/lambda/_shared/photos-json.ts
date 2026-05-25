import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import type { GalleryJson, GalleryPhotoEntry, PhotoEntry, PhotosDocument, PhotosJson } from './types.js';

export const photosJsonKey = 'data/photos.json';
export const galleryJsonKey = 'data/gallery.json';

export async function updatePhotosJson(
  s3: S3Client,
  bucketName: string,
  mutator: (current: PhotosJson) => PhotosJson
): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const document = await readPhotosJson(s3, bucketName);
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
      await writeGalleryJson(s3, bucketName, next);
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

export async function readPhotosJson(s3: S3Client, bucketName: string): Promise<PhotosDocument> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: photosJsonKey }));
    const body = response.Body ? await response.Body.transformToString('utf-8') : '';
    const parsed = body ? (JSON.parse(stripBom(body)) as PhotosJson) : createEmptyPhotosJson();

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

export function createEmptyPhotosJson(): PhotosJson {
  return {
    version: 0,
    updatedAt: new Date(0).toISOString(),
    photos: []
  };
}

export function normalizePhotosJson(input: PhotosJson): PhotosJson {
  return {
    version: typeof input.version === 'number' ? input.version : 0,
    updatedAt: input.updatedAt ?? new Date(0).toISOString(),
    photos: Array.isArray(input.photos) ? input.photos.map(normalizePhotoEntry).filter(isPhotoEntry) : []
  };
}

export async function writeGalleryJson(s3: S3Client, bucketName: string, photos: PhotosJson): Promise<void> {
  const gallery = toGalleryJson(photos);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: galleryJsonKey,
      Body: JSON.stringify(gallery, null, 2),
      CacheControl: 'public, max-age=60',
      ContentType: 'application/json; charset=utf-8'
    })
  );
}

export function toGalleryJson(photos: PhotosJson): GalleryJson {
  return {
    version: photos.version,
    updatedAt: photos.updatedAt,
    photos: photos.photos
      .filter((photo) => !photo.deleted)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map(toGalleryPhoto)
  };
}

function toGalleryPhoto(photo: PhotoEntry): GalleryPhotoEntry {
  return {
    id: photo.id,
    title: photo.title,
    description: photo.description,
    album: photo.album,
    order: photo.order,
    variants: photo.variants,
    width: photo.width,
    height: photo.height,
    takenAt: photo.takenAt
  };
}

function normalizePhotoEntry(input: unknown): PhotoEntry | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const photo = input as Partial<PhotoEntry>;
  const variants = typeof photo.variants === 'object' && photo.variants !== null ? photo.variants : null;
  if (!stringValue(photo.id) || !variants || !stringValue(variants.thumb) || !stringValue(variants.medium) || !stringValue(variants.full)) {
    return null;
  }

  return {
    id: stringValue(photo.id),
    title: stringValue(photo.title),
    description: stringValue(photo.description),
    album: stringValue(photo.album),
    order: typeof photo.order === 'number' && Number.isFinite(photo.order) ? photo.order : 0,
    originalKey: stringValue(photo.originalKey),
    variants: {
      thumb: stringValue(variants.thumb),
      medium: stringValue(variants.medium),
      full: stringValue(variants.full)
    },
    width: typeof photo.width === 'number' && Number.isFinite(photo.width) ? photo.width : 0,
    height: typeof photo.height === 'number' && Number.isFinite(photo.height) ? photo.height : 0,
    takenAt: typeof photo.takenAt === 'string' ? photo.takenAt : null,
    createdAt: stringValue(photo.createdAt),
    updatedAt: stringValue(photo.updatedAt),
    deleted: photo.deleted === true,
    deletedAt: typeof photo.deletedAt === 'string' ? photo.deletedAt : null
  };
}

function isPhotoEntry(value: PhotoEntry | null): value is PhotoEntry {
  return value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, '');
}

export function hasErrorName(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name;
}

function isConditionalWriteFailure(error: unknown): boolean {
  return hasErrorName(error, 'PreconditionFailed') || hasErrorName(error, 'ConditionalRequestConflict');
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
