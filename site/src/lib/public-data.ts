export type PhotoVariantName = 'thumb' | 'medium' | 'full';

export interface GalleryPhoto {
  id: string;
  title: string;
  description: string;
  album: string;
  order: number;
  variants: Record<PhotoVariantName, string>;
  width: number;
  height: number;
  takenAt: string | null;
}

export interface GalleryJson {
  version: number;
  updatedAt: string;
  photos: GalleryPhoto[];
}

export interface SocialLink {
  platform: string;
  url: string;
}

export interface SiteConfig {
  name: string;
  tagline: string;
  bio: string;
  social: SocialLink[];
  footer: string;
}

export const defaultSiteConfig: SiteConfig = {
  name: 'Victor Yeung',
  tagline: 'Art & Photography',
  bio: '<p>Victor Yeung is building a new photography portfolio. A fuller artist statement and biography will be added soon.</p>',
  social: [],
  footer: 'Copyright 2026 Victor Yeung'
};

export const emptyGallery: GalleryJson = {
  version: 0,
  updatedAt: new Date(0).toISOString(),
  photos: []
};

export async function fetchSiteConfig(): Promise<SiteConfig> {
  try {
    const response = await fetch('/data/site.json', { cache: 'no-store' });
    if (!response.ok) {
      return defaultSiteConfig;
    }

    return normalizeSiteConfig((await response.json()) as Partial<SiteConfig>);
  } catch {
    return defaultSiteConfig;
  }
}

export async function fetchGallery(): Promise<GalleryJson> {
  try {
    const response = await fetch('/data/gallery.json', { cache: 'no-store' });
    if (!response.ok) {
      return emptyGallery;
    }

    return normalizeGallery((await response.json()) as Partial<GalleryJson>);
  } catch {
    return emptyGallery;
  }
}

function normalizeGallery(input: Partial<GalleryJson>): GalleryJson {
  const version = typeof input.version === 'number' ? input.version : 0;
  const updatedAt = typeof input.updatedAt === 'string' ? input.updatedAt : emptyGallery.updatedAt;
  const variantVersion = `${version}`;

  return {
    version,
    updatedAt,
    photos: Array.isArray(input.photos)
      ? input.photos
          .map((photo) => normalizeGalleryPhoto(photo, variantVersion))
          .filter((photo): photo is GalleryPhoto => photo !== null)
          .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      : []
  };
}

function normalizeGalleryPhoto(input: unknown, variantVersion: string): GalleryPhoto | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const photo = input as Partial<GalleryPhoto>;
  const variants = typeof photo.variants === 'object' && photo.variants !== null ? photo.variants : null;
  if (
    !stringValue(photo.id, '') ||
    !variants ||
    !stringValue(variants.thumb, '') ||
    !stringValue(variants.medium, '') ||
    !stringValue(variants.full, '')
  ) {
    return null;
  }

  return {
    id: stringValue(photo.id, ''),
    title: stringValue(photo.title, ''),
    description: stringValue(photo.description, ''),
    album: stringValue(photo.album, ''),
    order: typeof photo.order === 'number' && Number.isFinite(photo.order) ? photo.order : 0,
    variants: {
      thumb: withVariantVersion(stringValue(variants.thumb, ''), variantVersion),
      medium: withVariantVersion(stringValue(variants.medium, ''), variantVersion),
      full: withVariantVersion(stringValue(variants.full, ''), variantVersion)
    },
    width: typeof photo.width === 'number' && Number.isFinite(photo.width) ? photo.width : 0,
    height: typeof photo.height === 'number' && Number.isFinite(photo.height) ? photo.height : 0,
    takenAt: typeof photo.takenAt === 'string' ? photo.takenAt : null
  };
}

function withVariantVersion(value: string, version: string): string {
  const separator = value.includes('?') ? '&' : '?';
  return `${value}${separator}v=${encodeURIComponent(version)}`;
}

function normalizeSiteConfig(input: Partial<SiteConfig>): SiteConfig {
  return {
    name: stringValue(input.name, defaultSiteConfig.name),
    tagline: stringValue(input.tagline, defaultSiteConfig.tagline),
    bio: stringValue(input.bio, defaultSiteConfig.bio),
    social: Array.isArray(input.social) ? input.social.filter(isSocialLink).slice(0, 8) : [],
    footer: stringValue(input.footer, defaultSiteConfig.footer)
  };
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isSocialLink(value: unknown): value is SocialLink {
  return (
    typeof value === 'object' &&
    value !== null &&
    'platform' in value &&
    'url' in value &&
    typeof value.platform === 'string' &&
    typeof value.url === 'string'
  );
}
