import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const client = new S3Client({});
let bucketName: string;

/**
 * Initialises the S3 service with the content bucket name.
 * Must be called before any other functions.
 */
export function initS3(name: string): void {
  bucketName = name;
}

/**
 * Stores L2 full content in S3.
 */
export async function putL2Content(
  s3Key: string,
  content: string
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: content,
      ContentType: 'text/markdown; charset=utf-8',
    })
  );
}

/**
 * Retrieves L2 content from S3 as a string.
 */
export async function getL2Content(s3Key: string): Promise<string> {
  const result = await client.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    })
  );

  if (!result.Body) {
    throw new Error(`Empty S3 response for key: ${s3Key}`);
  }

  return result.Body.transformToString('utf-8');
}

/**
 * Archives a session by writing messages and summary to S3.
 * Writes to archives/{sessionId}/messages.json and archives/{sessionId}/summary.json.
 */
export async function archiveSession(
  sessionId: string,
  messages: unknown,
  summary: unknown
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: `archives/${sessionId}/messages.json`,
      Body: JSON.stringify(messages),
      ContentType: 'application/json',
    })
  );

  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: `archives/${sessionId}/summary.json`,
      Body: JSON.stringify(summary),
      ContentType: 'application/json',
    })
  );
}

/**
 * Deletes a single object from S3 by key.
 * Used for cascade delete of L2 content.
 */
export async function deleteS3Object(s3Key: string): Promise<void> {
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    })
  );
}
