import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';

const bucket = process.env.B2_BUCKET_NAME!;

const s3 = new S3Client({
  endpoint: process.env.B2_ENDPOINT!,
  region: 'us-east-005', // ponytail: B2 ignores region, but SDK requires one
  credentials: {
    accessKeyId: process.env.B2_APPLICATION_KEY_ID!,
    secretAccessKey: process.env.B2_APPLICATION_KEY!,
  },
});

/**
 * Upload a file to the B2 bucket.
 */
export async function uploadFile(
  path: string,
  buffer: Buffer,
  contentType = 'application/octet-stream',
): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: path,
    Body: buffer,
    ContentType: contentType,
  }));
  return path;
}

/**
 * Generate a time-limited presigned download URL.
 */
export async function getSignedUrl(
  path: string,
  expiresIn = 3600,
): Promise<string> {
  return awsGetSignedUrl(s3, new GetObjectCommand({
    Bucket: bucket,
    Key: path,
  }), { expiresIn });
}

/**
 * Delete a file from the B2 bucket.
 */
export async function deleteFile(path: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: path,
  }));
}

/**
 * Get a file stream from B2 bucket.
 * ponytail: bypasses B2 CORS and presigned URL 403 quirks
 */
export async function getFileStream(path: string) {
  const response = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: path,
  }));
  return response;
}
