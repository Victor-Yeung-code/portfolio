import type {
  PhotoEntry,
  PhotosJson,
  RepublishStatus,
  SiteConfig,
  UploadUrlResponse,
  WatermarkConfig,
  WatermarkResponse
} from './types';

interface UploadUrlRequest {
  filename: string;
  contentType: string;
  kind: 'photo' | 'watermark';
}

type PhotoPatch = Pick<PhotoEntry, 'title' | 'description' | 'album' | 'order'>;

export const adminApi = {
  getPhotos: () => request<PhotosJson>('/api/admin/photos'),
  getWatermark: () => request<WatermarkResponse>('/api/admin/watermark'),
  getSite: () => request<SiteConfig>('/api/admin/site'),
  createUploadUrl: (input: UploadUrlRequest) =>
    request<UploadUrlResponse>('/api/admin/upload-url', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
  updatePhoto: (id: string, patch: PhotoPatch) =>
    request<{ photo: PhotoEntry }>(`/api/admin/photos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    }),
  softDeletePhoto: (id: string) =>
    request<{ photo: PhotoEntry }>(`/api/admin/photos/${encodeURIComponent(id)}/soft-delete`, {
      method: 'POST'
    }),
  restorePhoto: (id: string) =>
    request<{ photo: PhotoEntry }>(`/api/admin/photos/${encodeURIComponent(id)}/restore`, {
      method: 'POST'
    }),
  purgePhoto: (id: string) =>
    request<{ ok: true }>(`/api/admin/photos/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    }),
  saveWatermark: (config: WatermarkConfig) =>
    request<{ config: WatermarkConfig }>('/api/admin/watermark', {
      method: 'PUT',
      body: JSON.stringify(config)
    }),
  saveSite: (config: SiteConfig) =>
    request<{ config: SiteConfig }>('/api/admin/site', {
      method: 'PUT',
      body: JSON.stringify(config)
    }),
  republish: () =>
    request<{ queued: number }>('/api/admin/republish', {
      method: 'POST'
    }),
  republishStatus: () => request<RepublishStatus>('/api/admin/republish-status'),
  invalidatePhotos: () =>
    request<{ invalidationId?: string }>('/api/admin/invalidate-photos', {
      method: 'POST'
    })
};

export async function putSignedObject(url: string, file: File, headers: Record<string, string>): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    body: file,
    headers
  });

  if (!response.ok) {
    throw new Error(`Upload failed with ${response.status}`);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);

  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers
  });
  const text = await response.text();
  const body = parseResponse(text);

  if (!response.ok) {
    throw new Error(errorMessage(body, response));
  }

  return body as T;
}

function parseResponse(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessage(body: unknown, response: Response): string {
  if (typeof body === 'object' && body && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }

  return `${response.status} ${response.statusText}`.trim();
}
