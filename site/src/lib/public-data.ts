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
  tags: string[];
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
  email: string;
  social: SocialLink[];
  footer: string;
}

export const defaultSiteConfig: SiteConfig = {
  name: 'Victor Yeung',
  tagline: 'Art & Photography',
  bio: '<p>Victor Yeung is building a new photography portfolio. A fuller artist statement and biography will be added soon.</p>',
  email: 'victoryeung564@gmail.com',
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
  return {
    version: typeof input.version === 'number' ? input.version : 0,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : emptyGallery.updatedAt,
    photos: Array.isArray(input.photos)
      ? input.photos
          .filter((photo): photo is GalleryPhoto => Boolean(photo?.id && photo?.variants?.thumb && photo?.variants?.medium))
          .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      : []
  };
}

function normalizeSiteConfig(input: Partial<SiteConfig>): SiteConfig {
  return {
    name: stringValue(input.name, defaultSiteConfig.name),
    tagline: stringValue(input.tagline, defaultSiteConfig.tagline),
    bio: sanitizeBioHtml(stringValue(input.bio, defaultSiteConfig.bio)),
    email: stringValue(input.email, defaultSiteConfig.email),
    social: Array.isArray(input.social) ? input.social.filter(isSocialLink).slice(0, 8) : [],
    footer: stringValue(input.footer, defaultSiteConfig.footer)
  };
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toBioHtml(value: string): string {
  if (/<[a-z][\s\S]*>/i.test(value)) {
    return value;
  }

  return value
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function sanitizeBioHtml(value: string): string {
  const html = toBioHtml(value);

  if (typeof DOMParser === 'undefined' || typeof document === 'undefined') {
    return html.replace(/<[^>]*>/g, '').trim()
      ? toBioHtml(html.replace(/<[^>]*>/g, ''))
      : defaultSiteConfig.bio;
  }

  const parsed = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const output = document.createElement('div');
  sanitizeChildren(parsed.body.firstElementChild ?? parsed.body, output);

  return output.innerHTML.trim() || defaultSiteConfig.bio;
}

function sanitizeChildren(source: ParentNode, target: HTMLElement): void {
  source.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(node.textContent ?? ''));
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as HTMLElement;
    const tagName = element.tagName.toLowerCase();

    if (tagName === 'script' || tagName === 'style' || tagName === 'iframe' || tagName === 'object') {
      return;
    }

    if (!bioAllowedTags.has(tagName)) {
      sanitizeChildren(element, target);
      return;
    }

    const clean = document.createElement(tagName);
    if (tagName === 'a') {
      const href = safeLinkHref(element.getAttribute('href'));
      if (href) {
        clean.setAttribute('href', href);
        clean.setAttribute('rel', 'noopener noreferrer');
        clean.setAttribute('target', '_blank');
      }
    }

    sanitizeChildren(element, clean);
    target.append(clean);
  });
}

function safeLinkHref(value: string | null): string {
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? value : '';
  } catch {
    return '';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

const bioAllowedTags = new Set(['p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'a', 'blockquote']);
