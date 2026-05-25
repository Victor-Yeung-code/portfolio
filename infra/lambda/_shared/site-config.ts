import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import sanitizeHtml from 'sanitize-html';
import { hasErrorName, stripBom } from './photos-json.js';
import type { SiteConfig, SocialLink } from './types.js';

export const siteConfigKey = 'data/site.json';
const bioTextLimit = 15000;
const bioAllowedTags = ['p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'a', 'blockquote'];
const bioAllowedAttributes = { a: ['href', 'rel', 'target'] };

export const defaultSiteConfig: SiteConfig = {
  name: 'Victor Yeung',
  tagline: 'Art & Photography',
  bio: '<p>Victor Yeung is building a new photography portfolio. A fuller artist statement and biography will be added soon.</p>',
  email: 'victoryeung564@gmail.com',
  social: [],
  footer: 'Copyright 2026 Victor Yeung'
};

export async function readSiteConfig(s3: S3Client, bucketName: string): Promise<SiteConfig> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: siteConfigKey }));
    const body = response.Body ? await response.Body.transformToString('utf-8') : '';

    return normalizeSiteConfig(body ? (JSON.parse(stripBom(body)) as Partial<SiteConfig>) : {});
  } catch (error) {
    if (error instanceof NoSuchKey || hasErrorName(error, 'NoSuchKey')) {
      return defaultSiteConfig;
    }

    throw error;
  }
}

export async function writeSiteConfig(s3: S3Client, bucketName: string, config: SiteConfig): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: siteConfigKey,
      Body: JSON.stringify(config, null, 2),
      CacheControl: 'public, max-age=60',
      ContentType: 'application/json; charset=utf-8'
    })
  );
}

export function normalizeSiteConfig(input: Partial<SiteConfig>): SiteConfig {
  return {
    name: cleanString(input.name, defaultSiteConfig.name, 80),
    tagline: cleanString(input.tagline, defaultSiteConfig.tagline, 120),
    bio: normalizeBio(input.bio),
    email: cleanString(input.email, defaultSiteConfig.email, 320),
    social: normalizeSocialLinks(input.social),
    footer: cleanString(input.footer, defaultSiteConfig.footer, 200)
  };
}

export function validateSiteConfig(input: Partial<SiteConfig>): SiteConfig {
  const config = normalizeSiteConfig(input);

  if (config.name.length < 1) {
    throw new Error('Name is required.');
  }

  if (plainTextLength(config.bio) > bioTextLimit) {
    throw new Error('Bio must be 15000 characters or fewer.');
  }

  if (config.email && !isEmail(config.email)) {
    throw new Error('Email must be valid.');
  }

  for (const link of config.social) {
    if (!link.platform || link.platform.length > 20) {
      throw new Error('Social platform labels must be 1-20 characters.');
    }

    if (!isHttpUrl(link.url)) {
      throw new Error('Social URLs must start with http:// or https://.');
    }
  }

  return config;
}

function normalizeSocialLinks(value: unknown): SocialLink[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item !== 'object' || item === null) {
        return null;
      }

      return {
        platform: cleanString('platform' in item ? item.platform : '', '', 20),
        url: cleanString('url' in item ? item.url : '', '', 500)
      };
    })
    .filter((item): item is SocialLink => Boolean(item?.platform || item?.url))
    .slice(0, 8);
}

function cleanString(value: unknown, fallback: string, limit: number): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  return value.trim().slice(0, limit);
}

function normalizeBio(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : defaultSiteConfig.bio;
  return sanitizeBio(toHtmlIfPlainText(raw));
}

export function sanitizeBio(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: bioAllowedTags,
    allowedAttributes: bioAllowedAttributes,
    allowedSchemes: ['http', 'https', 'mailto'],
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (_tagName, attribs) => {
        const href = typeof attribs.href === 'string' ? attribs.href : '';

        return {
          tagName: 'a',
          attribs: {
            href,
            rel: 'noopener noreferrer',
            target: '_blank'
          }
        };
      }
    }
  }).trim();
}

function plainTextLength(html: string): number {
  return sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {}
  }).length;
}

function toHtmlIfPlainText(value: string): string {
  if (/<[a-z][\s\S]*>/i.test(value)) {
    return value;
  }

  return value
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
