import { CloudFrontClient, CreateInvalidationCommand, ListDistributionsCommand } from '@aws-sdk/client-cloudfront';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { extname, parse } from 'node:path';
import { hasErrorName, readPhotosJson, stripBom, updatePhotosJson } from '../_shared/photos-json.js';
import type { PhotoEntry, WatermarkConfig, WatermarkPosition } from '../_shared/types.js';
import { watermarkPositions } from '../_shared/types.js';

const s3 = new S3Client({});
const lambda = new LambdaClient({});
const sqs = new SQSClient({});
const cloudFront = new CloudFrontClient({});

const photosBucket = requiredEnv('PHOTOS_BUCKET');
const republishFunctionName = requiredEnv('REPUBLISH_FUNCTION_NAME');
const queueUrl = requiredEnv('REPROCESS_QUEUE_URL');
const adminOriginSecret = requiredEnv('ADMIN_ORIGIN_SECRET');
const domainName = requiredEnv('DOMAIN_NAME');
const watermarkJsonKey = 'data/watermark.json';
const photoContentTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/avif']);
const watermarkPositionSet = new Set<string>(watermarkPositions);
let distributionIdPromise: Promise<string> | undefined;

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    if (!isTrustedCloudFrontRequest(event)) {
      return jsonResponse(403, { error: 'Forbidden' });
    }

    if (event.requestContext.http.method === 'OPTIONS') {
      return { statusCode: 204, headers: noStoreHeaders() };
    }

    return await route(event);
  } catch (error) {
    if (isHttpError(error)) {
      return jsonResponse(error.statusCode, { error: error.message });
    }

    console.error(error);
    return jsonResponse(500, { error: 'Internal server error' });
  }
};

async function route(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method.toUpperCase();
  const path = normalizePath(event.rawPath);

  if (method === 'GET' && path === '/api/admin/photos') {
    const document = await readPhotosJson(s3, photosBucket);
    return jsonResponse(200, document.data);
  }

  if (method === 'GET' && path === '/api/admin/watermark') {
    return jsonResponse(200, await getWatermark());
  }

  if (method === 'POST' && path === '/api/admin/upload-url') {
    return jsonResponse(200, await createUploadUrl(parseJsonBody<UploadUrlRequest>(event)));
  }

  const photoMatch = path.match(/^\/api\/admin\/photos\/([^/]+)$/);
  if (photoMatch && method === 'PATCH') {
    return jsonResponse(200, await updatePhoto(decodeURIComponent(photoMatch[1]), parseJsonBody<PhotoPatch>(event)));
  }

  if (photoMatch && method === 'DELETE') {
    return await purgePhoto(decodeURIComponent(photoMatch[1]));
  }

  const softDeleteMatch = path.match(/^\/api\/admin\/photos\/([^/]+)\/soft-delete$/);
  if (softDeleteMatch && method === 'POST') {
    return jsonResponse(200, await setPhotoDeleted(decodeURIComponent(softDeleteMatch[1]), true));
  }

  const restoreMatch = path.match(/^\/api\/admin\/photos\/([^/]+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    return jsonResponse(200, await setPhotoDeleted(decodeURIComponent(restoreMatch[1]), false));
  }

  if (method === 'PUT' && path === '/api/admin/watermark') {
    return jsonResponse(200, await saveWatermark(parseJsonBody<Partial<WatermarkConfig>>(event)));
  }

  if (method === 'POST' && path === '/api/admin/republish') {
    return jsonResponse(200, await invokeRepublish());
  }

  if (method === 'GET' && path === '/api/admin/republish-status') {
    return jsonResponse(200, await getRepublishStatus());
  }

  if (method === 'POST' && path === '/api/admin/invalidate-photos') {
    return jsonResponse(200, await invalidatePhotos());
  }

  return jsonResponse(400, { error: 'Not found' });
}

interface UploadUrlRequest {
  filename?: string;
  contentType?: string;
  kind?: 'photo' | 'watermark';
}

interface PhotoPatch {
  title?: unknown;
  description?: unknown;
  album?: unknown;
  order?: unknown;
  tags?: unknown;
}

async function createUploadUrl(input: UploadUrlRequest): Promise<{ id?: string; key: string; url: string; headers: Record<string, string> }> {
  const filename = stringValue(input.filename, 'filename');
  const contentType = stringValue(input.contentType, 'contentType').toLowerCase();
  const kind = input.kind === 'watermark' ? 'watermark' : 'photo';
  const extension = extname(filename).toLowerCase();

  if (kind === 'watermark') {
    if (contentType !== 'image/png' || extension !== '.png') {
      throw httpError(400, 'Watermarks must be PNG files.');
    }

    const key = `watermarks/${safeBaseName(filename)}-${Date.now()}.png`;
    return {
      key,
      url: await signedPutUrl(key, contentType),
      headers: { 'Content-Type': contentType }
    };
  }

  if (!photoContentTypes.has(contentType) || !['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif'].includes(extension)) {
    throw httpError(400, 'Unsupported photo file type.');
  }

  const id = `${safeBaseName(filename)}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const key = `originals/${id}${extension}`;

  return {
    id,
    key,
    url: await signedPutUrl(key, contentType),
    headers: { 'Content-Type': contentType }
  };
}

async function signedPutUrl(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: photosBucket,
      Key: key,
      ContentType: contentType
    }),
    { expiresIn: 300 }
  );
}

async function updatePhoto(id: string, patch: PhotoPatch): Promise<{ photo: PhotoEntry }> {
  const safeId = validatePhotoId(id);
  let updated: PhotoEntry | undefined;

  await updatePhotosJson(s3, photosBucket, (current) => {
    const existing = current.photos.find((photo) => photo.id === safeId);
    if (!existing) {
      throw httpError(400, 'Photo not found.');
    }

    updated = {
      ...existing,
      title: optionalString(patch.title, existing.title),
      description: optionalString(patch.description, existing.description),
      album: optionalString(patch.album, existing.album),
      order: optionalOrder(patch.order, existing.order),
      tags: optionalTags(patch.tags, existing.tags),
      updatedAt: new Date().toISOString()
    };

    const photos = current.photos.map((photo) => (photo.id === safeId ? updated! : photo));
    photos.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));

    return {
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      photos
    };
  });

  return { photo: updated! };
}

async function setPhotoDeleted(id: string, deleted: boolean): Promise<{ photo: PhotoEntry }> {
  const safeId = validatePhotoId(id);
  let updated: PhotoEntry | undefined;

  await updatePhotosJson(s3, photosBucket, (current) => {
    const existing = current.photos.find((photo) => photo.id === safeId);
    if (!existing) {
      throw httpError(400, 'Photo not found.');
    }

    updated = {
      ...existing,
      deleted,
      deletedAt: deleted ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    };

    return {
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      photos: current.photos.map((photo) => (photo.id === safeId ? updated! : photo))
    };
  });

  return { photo: updated! };
}

async function purgePhoto(id: string): Promise<APIGatewayProxyResultV2> {
  const safeId = validatePhotoId(id);
  const document = await readPhotosJson(s3, photosBucket);
  const photo = document.data.photos.find((entry) => entry.id === safeId);

  if (!photo) {
    return jsonResponse(400, { error: 'Photo not found.' });
  }

  if (!photo.deleted) {
    return jsonResponse(409, { error: 'Soft-delete the photo before purging it.' });
  }

  await s3.send(new DeleteObjectCommand({ Bucket: photosBucket, Key: photo.originalKey }));
  return jsonResponse(202, { ok: true });
}

async function getWatermark(): Promise<{ config: WatermarkConfig | null; previewUrl?: string }> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: photosBucket, Key: watermarkJsonKey }));
    const body = response.Body ? await response.Body.transformToString('utf-8') : '';
    const config = body ? normalizeWatermarkConfig(JSON.parse(stripBom(body)) as Partial<WatermarkConfig>) : null;

    if (!config) {
      return { config: null };
    }

    const previewUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: photosBucket, Key: config.file }), {
      expiresIn: 300
    });

    return { config, previewUrl };
  } catch (error) {
    if (hasErrorName(error, 'NoSuchKey')) {
      return { config: null };
    }

    throw error;
  }
}

async function saveWatermark(input: Partial<WatermarkConfig>): Promise<{ config: WatermarkConfig }> {
  const config = normalizeWatermarkConfig(input);
  if (!config) {
    throw httpError(400, 'Invalid watermark config.');
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: photosBucket,
      Key: watermarkJsonKey,
      Body: JSON.stringify(config, null, 2),
      CacheControl: 'public, max-age=60',
      ContentType: 'application/json; charset=utf-8'
    })
  );

  return { config };
}

async function invokeRepublish(): Promise<{ queued: number }> {
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: republishFunctionName,
      InvocationType: 'RequestResponse'
    })
  );

  if (response.FunctionError) {
    throw new Error(`Republish trigger failed: ${response.FunctionError}`);
  }

  const payload = response.Payload ? JSON.parse(new TextDecoder().decode(response.Payload)) as { count?: number } : {};
  return { queued: payload.count ?? 0 };
}

async function getRepublishStatus(): Promise<{ queued: number; processing: number }> {
  const response = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']
    })
  );

  return {
    queued: Number(response.Attributes?.ApproximateNumberOfMessages ?? 0),
    processing: Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  };
}

async function invalidatePhotos(): Promise<{ invalidationId?: string }> {
  const response = await cloudFront.send(
    new CreateInvalidationCommand({
      DistributionId: await resolveDistributionId(),
      InvalidationBatch: {
        CallerReference: `admin-republish-${Date.now()}`,
        Paths: {
          Quantity: 2,
          Items: ['/photos/*', '/data/photos.json']
        }
      }
    })
  );

  return { invalidationId: response.Invalidation?.Id };
}

async function resolveDistributionId(): Promise<string> {
  distributionIdPromise ??= findDistributionId();
  return distributionIdPromise;
}

async function findDistributionId(): Promise<string> {
  let marker: string | undefined;

  do {
    const response = await cloudFront.send(new ListDistributionsCommand({ Marker: marker }));

    for (const item of response.DistributionList?.Items ?? []) {
      if ((item.Aliases?.Items ?? []).includes(domainName) && item.Id) {
        return item.Id;
      }
    }

    marker = response.DistributionList?.NextMarker;
  } while (marker);

  throw new Error(`CloudFront distribution with alias ${domainName} was not found.`);
}

function normalizeWatermarkConfig(input: Partial<WatermarkConfig>): WatermarkConfig | null {
  const file = typeof input.file === 'string' ? input.file.replace(/^\/+/, '') : '';
  if (!file || !file.startsWith('watermarks/') || file.includes('..') || !file.toLowerCase().endsWith('.png')) {
    return null;
  }

  const position =
    typeof input.position === 'string' && watermarkPositionSet.has(input.position)
      ? (input.position as WatermarkPosition)
      : 'bottom-right';
  const minWidthPx = positiveNumber(input.minWidthPx, 40);
  const maxWidthPx = Math.max(minWidthPx, positiveNumber(input.maxWidthPx, 600));

  return {
    file,
    position,
    marginPct: clamp(nonNegativeNumber(input.marginPct, 3), 0, 20),
    widthPct: clamp(positiveNumber(input.widthPct, 15), 1, 50),
    opacity: clamp(nonNegativeNumber(input.opacity, 0.7), 0, 1),
    minWidthPx,
    maxWidthPx
  };
}

function parseJsonBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) {
    return {} as T;
  }

  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
  try {
    return JSON.parse(stripBom(body)) as T;
  } catch {
    throw httpError(400, 'Request body must be valid JSON.');
  }
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  if (isHttpError(body)) {
    return jsonResponse(body.statusCode, { error: body.message });
  }

  return {
    statusCode,
    headers: noStoreHeaders(),
    body: JSON.stringify(body)
  };
}

function noStoreHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

function isTrustedCloudFrontRequest(event: APIGatewayProxyEventV2): boolean {
  return headerValue(event, 'x-admin-origin-secret') === adminOriginSecret;
}

function headerValue(event: APIGatewayProxyEventV2, header: string): string | undefined {
  const lower = header.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }

  return undefined;
}

function normalizePath(path: string): string {
  return path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
}

function validatePhotoId(id: string): string {
  if (!/^[a-z0-9][a-z0-9-_]{0,120}$/i.test(id)) {
    throw httpError(400, 'Invalid photo id.');
  }

  return id;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw httpError(400, `Missing ${name}.`);
  }

  return value.trim();
}

function safeBaseName(filename: string): string {
  const parsed = parse(filename);
  const cleaned = parsed.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);

  return cleaned || 'upload';
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.slice(0, 1000) : fallback;
}

function optionalOrder(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalTags(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 30);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 30);
  }

  return fallback;
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }

  return value;
}

interface HttpError extends Error {
  statusCode: number;
}

function httpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

function isHttpError(error: unknown): error is HttpError {
  return typeof error === 'object' && error !== null && 'statusCode' in error && 'message' in error;
}
