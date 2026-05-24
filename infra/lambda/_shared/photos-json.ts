import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import type { PhotosDocument, PhotosJson } from './types.js';

const photosJsonKey = 'data/photos.json';

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
    photos: Array.isArray(input.photos) ? input.photos : []
  };
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
