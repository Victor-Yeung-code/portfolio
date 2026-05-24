import {
  ListObjectsV2Command,
  S3Client
} from '@aws-sdk/client-s3';
import {
  SendMessageBatchCommand,
  SQSClient
} from '@aws-sdk/client-sqs';

const s3 = new S3Client({});
const sqs = new SQSClient({});

const bucketName = process.env.PHOTOS_BUCKET;
const queueUrl = process.env.QUEUE_URL;
const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif']);

if (!bucketName) {
  throw new Error('Missing PHOTOS_BUCKET environment variable.');
}

if (!queueUrl) {
  throw new Error('Missing QUEUE_URL environment variable.');
}

export const handler = async (): Promise<{ count: number }> => {
  const originalKeys = await listOriginalKeys();
  await sendReprocessMessages(originalKeys);

  console.log(`Queued ${originalKeys.length} originals for reprocessing.`);

  return {
    count: originalKeys.length
  };
};

async function listOriginalKeys(): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: 'originals/',
        ContinuationToken: continuationToken
      })
    );

    for (const item of response.Contents ?? []) {
      if (item.Key && isSupportedOriginal(item.Key)) {
        keys.push(item.Key);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

async function sendReprocessMessages(originalKeys: string[]): Promise<void> {
  for (let index = 0; index < originalKeys.length; index += 10) {
    const batch = originalKeys.slice(index, index + 10);
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

function isSupportedOriginal(key: string): boolean {
  const extension = key.slice(key.lastIndexOf('.')).toLowerCase();
  return key !== 'originals/' && supportedExtensions.has(extension);
}
