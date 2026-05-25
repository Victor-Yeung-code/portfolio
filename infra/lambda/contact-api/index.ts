import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const ses = new SESv2Client({});

const adminOriginSecret = requiredEnv('ADMIN_ORIGIN_SECRET');
const contactToEmail = requiredEnv('CONTACT_TO_EMAIL');
const contactFromEmail = requiredEnv('CONTACT_FROM_EMAIL');
const domainName = requiredEnv('DOMAIN_NAME');
const turnstileSecretKey = process.env.TURNSTILE_SECRET_KEY ?? '';

interface ContactRequest {
  name?: unknown;
  email?: unknown;
  message?: unknown;
  turnstileToken?: unknown;
  website?: unknown;
}

interface ValidContact {
  name: string;
  email: string;
  message: string;
  turnstileToken: string;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    if (!isTrustedCloudFrontRequest(event)) {
      return jsonResponse(403, { error: 'Forbidden' });
    }

    const method = event.requestContext.http.method.toUpperCase();
    if (method === 'OPTIONS') {
      return { statusCode: 204, headers: noStoreHeaders() };
    }

    if (method !== 'POST' || normalizePath(event.rawPath) !== '/api/contact') {
      return jsonResponse(404, { error: 'Not found' });
    }

    assertSameOrigin(event);

    const input = parseJsonBody<ContactRequest>(event);
    if (typeof input.website === 'string' && input.website.trim()) {
      return jsonResponse(200, { ok: true });
    }

    const contact = validateContact(input);
    await verifyTurnstile(contact.turnstileToken);
    await sendContactEmail(contact);

    return jsonResponse(200, { ok: true });
  } catch (error) {
    if (isHttpError(error)) {
      return jsonResponse(error.statusCode, { error: error.message });
    }

    console.error(error);
    return jsonResponse(500, { error: 'Unable to send message right now.' });
  }
};

function validateContact(input: ContactRequest): ValidContact {
  const name = stringField(input.name).slice(0, 100);
  const email = stringField(input.email).slice(0, 320);
  const message = stringField(input.message).slice(0, 2000);
  const turnstileToken = stringField(input.turnstileToken);

  if (name.length < 1) {
    throw httpError(400, 'Name is required.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(400, 'Email must be valid.');
  }

  if (message.length < 10) {
    throw httpError(400, 'Message must be at least 10 characters.');
  }

  return { name, email, message, turnstileToken };
}

async function verifyTurnstile(token: string): Promise<void> {
  if (!turnstileSecretKey) {
    return;
  }

  if (!token) {
    throw httpError(400, 'Verification failed.');
  }

  const body = new URLSearchParams({
    secret: turnstileSecretKey,
    response: token
  });

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body
  });

  if (!response.ok) {
    throw httpError(400, 'Verification failed.');
  }

  const result = (await response.json()) as { success?: boolean; hostname?: string };
  const allowedHosts = new Set([domainName, `www.${domainName}`]);

  if (!result.success || (result.hostname && !allowedHosts.has(result.hostname))) {
    throw httpError(400, 'Verification failed.');
  }
}

async function sendContactEmail(contact: ValidContact): Promise<void> {
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: contactFromEmail,
      Destination: {
        ToAddresses: [contactToEmail]
      },
      ReplyToAddresses: [contact.email],
      Content: {
        Simple: {
          Subject: {
            Data: `Portfolio contact from ${contact.name}`,
            Charset: 'UTF-8'
          },
          Body: {
            Text: {
              Charset: 'UTF-8',
              Data: [
                `Name: ${contact.name}`,
                `Email: ${contact.email}`,
                '',
                contact.message
              ].join('\n')
            }
          }
        }
      }
    })
  );
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

function assertSameOrigin(event: APIGatewayProxyEventV2): void {
  const origin = headerValue(event, 'origin');
  if (origin && origin !== `https://${domainName}`) {
    throw httpError(403, 'Invalid origin.');
  }
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

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, '');
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
