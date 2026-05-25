import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { GetQueueAttributesCommand, SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { extname, parse } from 'node:path';
import { hasErrorName, readPhotosJson, stripBom, updatePhotosJson } from '../_shared/photos-json.js';
import { readSiteConfig, validateSiteConfig, writeSiteConfig } from '../_shared/site-config.js';
import type { PhotoEntry, SiteConfig, WatermarkProfile, WatermarkSettings } from '../_shared/types.js';
import {
  createWatermarkProfile,
  normalizeNullableProfileId,
  normalizeProfileId,
  normalizeWatermarkFile,
  readWatermarkSettings,
  slugifyProfileName,
  updateWatermarkSettings
} from '../_shared/watermark.js';

const s3 = new S3Client({});
const lambda = new LambdaClient({});
const sqs = new SQSClient({});
const cloudFront = new CloudFrontClient({});

const photosBucket = requiredEnv('PHOTOS_BUCKET');
const republishFunctionName = requiredEnv('REPUBLISH_FUNCTION_NAME');
const queueUrl = requiredEnv('REPROCESS_QUEUE_URL');
const adminOriginSecret = requiredEnv('ADMIN_ORIGIN_SECRET');
const distributionId = requiredEnv('DISTRIBUTION_ID');
const domainName = requiredEnv('DOMAIN_NAME');
const photoContentTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/avif']);

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    if (!isTrustedCloudFrontRequest(event)) {
      return jsonResponse(403, { error: 'Forbidden' });
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
  assertSameOrigin(event);

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: noStoreHeaders() };
  }

  const path = normalizePath(event.rawPath);

  if (method === 'GET' && path === '/api/admin/photos') {
    const document = await readPhotosJson(s3, photosBucket);
    return jsonResponse(200, document.data);
  }

  if (method === 'GET' && path === '/api/admin/watermark') {
    return jsonResponse(410, { error: 'Use /api/admin/watermark-settings.' });
  }

  if (method === 'GET' && path === '/api/admin/watermark-settings') {
    return jsonResponse(200, await getWatermarkSettingsResponse());
  }

  if (method === 'GET' && path === '/api/admin/site') {
    return jsonResponse(200, await readSiteConfig(s3, photosBucket));
  }

  if (method === 'PUT' && path === '/api/admin/site') {
    return jsonResponse(200, await saveSite(parseJsonBody<Partial<SiteConfig>>(event)));
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
    return jsonResponse(410, { error: 'Use /api/admin/watermark-settings.' });
  }

  if (method === 'PUT' && path === '/api/admin/watermark-settings') {
    return jsonResponse(200, await saveWatermarkSettings(parseJsonBody<WatermarkSettingsPatch>(event)));
  }

  if (method === 'POST' && path === '/api/admin/watermark-profiles') {
    return jsonResponse(200, await createProfile(parseJsonBody<WatermarkProfilePatch>(event)));
  }

  const profileMatch = path.match(/^\/api\/admin\/watermark-profiles\/([^/]+)$/);
  if (profileMatch && method === 'PUT') {
    return jsonResponse(200, await updateProfile(decodeURIComponent(profileMatch[1]), parseJsonBody<WatermarkProfilePatch>(event)));
  }

  if (profileMatch && method === 'DELETE') {
    return jsonResponse(200, await deleteProfile(decodeURIComponent(profileMatch[1])));
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
  watermarkProfile?: unknown;
}

interface WatermarkSettingsPatch {
  file?: unknown;
  defaultProfileForUploads?: unknown;
}

type WatermarkProfilePatch = Partial<WatermarkProfile>;

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

async function updatePhoto(id: string, patch: PhotoPatch): Promise<{ photo: PhotoEntry; reprocessQueued: boolean }> {
  const safeId = validatePhotoId(id);
  let updated: PhotoEntry | undefined;
  let reprocessOriginalKey: string | undefined;
  const hasWatermarkProfilePatch = Object.prototype.hasOwnProperty.call(patch, 'watermarkProfile');
  const watermarkProfile = hasWatermarkProfilePatch
    ? await validatePhotoWatermarkProfile(patch.watermarkProfile)
    : undefined;

  await updatePhotosJson(s3, photosBucket, (current) => {
    const existing = current.photos.find((photo) => photo.id === safeId);
    if (!existing) {
      throw httpError(400, 'Photo not found.');
    }

    const existingWatermarkProfile = existing.watermarkProfile ?? null;
    const nextWatermarkProfile = hasWatermarkProfilePatch ? watermarkProfile! : existingWatermarkProfile;
    const profileChanged = existingWatermarkProfile !== nextWatermarkProfile;

    updated = {
      ...existing,
      title: optionalString(patch.title, existing.title),
      description: optionalString(patch.description, existing.description),
      album: optionalString(patch.album, existing.album),
      order: optionalOrder(patch.order, existing.order),
      watermarkProfile: nextWatermarkProfile,
      updatedAt: new Date().toISOString()
    };
    reprocessOriginalKey = profileChanged ? existing.originalKey : undefined;

    const photos = current.photos.map((photo) => (photo.id === safeId ? updated! : photo));
    photos.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));

    return {
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      photos
    };
  });

  if (reprocessOriginalKey) {
    await sendReprocessMessages([reprocessOriginalKey]);
  }

  return { photo: updated!, reprocessQueued: Boolean(reprocessOriginalKey) };
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

async function getWatermarkPreviewDataUrl(key: string): Promise<string | undefined> {
  if (!key) {
    return undefined;
  }

  try {
    const watermark = await s3.send(new GetObjectCommand({ Bucket: photosBucket, Key: key }));
    const bytes = watermark.Body ? await watermark.Body.transformToByteArray() : new Uint8Array();
    const contentType = watermark.ContentType ?? 'image/png';

    return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch (error) {
    if (hasErrorName(error, 'NoSuchKey')) {
      return undefined;
    }

    throw error;
  }
}

async function getWatermarkSettingsResponse(): Promise<{ settings: WatermarkSettings; previewUrl?: string }> {
  const settings = await readWatermarkSettings(s3, photosBucket);
  return {
    settings,
    previewUrl: await getWatermarkPreviewDataUrl(settings.file)
  };
}

async function saveWatermarkSettings(
  input: WatermarkSettingsPatch
): Promise<{ settings: WatermarkSettings; previewUrl?: string }> {
  const settings = await updateWatermarkSettings(s3, photosBucket, (current) => {
    const file = Object.prototype.hasOwnProperty.call(input, 'file')
      ? validateWatermarkFile(input.file)
      : current.file;
    const defaultProfileForUploads = Object.prototype.hasOwnProperty.call(input, 'defaultProfileForUploads')
      ? validateDefaultProfile(input.defaultProfileForUploads, current)
      : current.defaultProfileForUploads;

    return {
      ...current,
      file,
      defaultProfileForUploads
    };
  });

  return {
    settings,
    previewUrl: await getWatermarkPreviewDataUrl(settings.file)
  };
}

async function createProfile(
  input: WatermarkProfilePatch
): Promise<{ settings: WatermarkSettings; profile: WatermarkProfile; previewUrl?: string }> {
  let created: WatermarkProfile | undefined;
  const settings = await updateWatermarkSettings(s3, photosBucket, (current) => {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
      throw httpError(400, 'Missing profile name.');
    }

    const id = uniqueProfileId(slugifyProfileName(name), current.profiles);
    const profile = createWatermarkProfile(id, input, { name });
    if (!profile) {
      throw httpError(400, 'Invalid profile settings.');
    }

    created = profile;
    return {
      ...current,
      profiles: [...current.profiles, profile]
    };
  });

  return {
    settings,
    profile: created!,
    previewUrl: await getWatermarkPreviewDataUrl(settings.file)
  };
}

async function updateProfile(
  id: string,
  input: WatermarkProfilePatch
): Promise<{ settings: WatermarkSettings; profile: WatermarkProfile; queued: number; previewUrl?: string }> {
  const safeId = validateProfileId(id);
  let updated: WatermarkProfile | undefined;
  const settings = await updateWatermarkSettings(s3, photosBucket, (current) => {
    const existing = current.profiles.find((profile) => profile.id === safeId);
    if (!existing) {
      throw httpError(400, 'Profile not found.');
    }

    const profile = createWatermarkProfile(safeId, input, existing);
    if (!profile) {
      throw httpError(400, 'Invalid profile settings.');
    }

    updated = profile;
    return {
      ...current,
      profiles: current.profiles.map((item) => (item.id === safeId ? profile : item))
    };
  });
  const photos = (await readPhotosJson(s3, photosBucket)).data.photos.filter(
    (photo) => (photo.watermarkProfile ?? null) === safeId
  );
  await sendReprocessMessages(photos.map((photo) => photo.originalKey));

  return {
    settings,
    profile: updated!,
    queued: photos.length,
    previewUrl: await getWatermarkPreviewDataUrl(settings.file)
  };
}

async function deleteProfile(
  id: string
): Promise<{ settings: WatermarkSettings; deleted: true; previewUrl?: string }> {
  const safeId = validateProfileId(id);
  const photos = (await readPhotosJson(s3, photosBucket)).data.photos.filter(
    (photo) => (photo.watermarkProfile ?? null) === safeId
  );

  if (photos.length > 0) {
    throw httpError(409, `Profile is used by ${photos.length} photo${photos.length === 1 ? '' : 's'}.`);
  }

  const settings = await updateWatermarkSettings(s3, photosBucket, (current) => {
    if (!current.profiles.some((profile) => profile.id === safeId)) {
      throw httpError(400, 'Profile not found.');
    }

    return {
      ...current,
      defaultProfileForUploads: current.defaultProfileForUploads === safeId ? null : current.defaultProfileForUploads,
      profiles: current.profiles.filter((profile) => profile.id !== safeId)
    };
  });

  return {
    settings,
    deleted: true,
    previewUrl: await getWatermarkPreviewDataUrl(settings.file)
  };
}

async function saveSite(input: Partial<SiteConfig>): Promise<{ config: SiteConfig }> {
  let config: SiteConfig;

  try {
    config = validateSiteConfig(input);
  } catch (error) {
    throw httpError(400, error instanceof Error ? error.message : 'Invalid site config.');
  }

  await writeSiteConfig(s3, photosBucket, config);

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
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: `admin-republish-${Date.now()}`,
        Paths: {
          Quantity: 4,
          Items: ['/photos/*', '/data/photos.json', '/data/gallery.json', '/data/site.json']
        }
      }
    })
  );

  return { invalidationId: response.Invalidation?.Id };
}

async function validatePhotoWatermarkProfile(value: unknown): Promise<string | null> {
  const profileId = normalizeNullableProfileId(value);
  if (value !== null && value !== undefined && value !== '' && !profileId) {
    throw httpError(400, 'Invalid watermark profile.');
  }

  if (!profileId) {
    return null;
  }

  const settings = await readWatermarkSettings(s3, photosBucket);
  if (!settings.profiles.some((profile) => profile.id === profileId)) {
    throw httpError(400, 'Watermark profile not found.');
  }

  return profileId;
}

function validateDefaultProfile(value: unknown, settings: WatermarkSettings): string | null {
  const profileId = normalizeNullableProfileId(value);
  if (value !== null && value !== undefined && value !== '' && !profileId) {
    throw httpError(400, 'Invalid default profile.');
  }

  if (!profileId) {
    return null;
  }

  if (!settings.profiles.some((profile) => profile.id === profileId)) {
    throw httpError(400, 'Default profile not found.');
  }

  return profileId;
}

function validateWatermarkFile(value: unknown): string {
  const file = normalizeWatermarkFile(value);
  if (file === null) {
    throw httpError(400, 'Invalid watermark file.');
  }

  return file;
}

function validateProfileId(id: string): string {
  const profileId = normalizeProfileId(id);
  if (!profileId) {
    throw httpError(400, 'Invalid profile id.');
  }

  return profileId;
}

function uniqueProfileId(baseId: string, profiles: WatermarkProfile[]): string {
  const used = new Set(profiles.map((profile) => profile.id));
  const safeBase = normalizeProfileId(baseId) ?? 'profile';

  if (!used.has(safeBase)) {
    return safeBase;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${safeBase}-${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  throw httpError(400, 'Unable to create a unique profile id.');
}

async function sendReprocessMessages(originalKeys: string[]): Promise<void> {
  for (let index = 0; index < originalKeys.length; index += 10) {
    const batch = originalKeys.slice(index, index + 10);
    if (batch.length === 0) {
      continue;
    }

    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((originalKey, offset) => ({
          Id: `message${index + offset}`,
          MessageBody: JSON.stringify({ originalKey })
        }))
      })
    );

    if (response.Failed && response.Failed.length > 0) {
      throw new Error(`Failed to enqueue reprocess messages: ${response.Failed.map((item) => item.Id).join(', ')}`);
    }
  }
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

function assertSameOrigin(event: APIGatewayProxyEventV2): void {
  const method = event.requestContext.http.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return;
  }

  const origin = headerValue(event, 'origin');
  if (origin && origin !== `https://${domainName}`) {
    throw httpError(403, 'Invalid origin.');
  }
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
