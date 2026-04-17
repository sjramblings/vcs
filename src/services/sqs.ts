import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createHash } from 'crypto';

const client = new SQSClient({});
let queueUrl: string;

/**
 * Initialises the SQS service with the rollup queue URL.
 * Must be called before any other functions.
 */
export function initSqs(url: string): void {
  queueUrl = url;
}

/**
 * Enqueues a parent URI for rollup processing via SQS FIFO queue.
 *
 * Dedup strategy: URI hash + per-minute time bucket. Writes within the
 * same calendar minute coalesce into one message. After a minute boundary
 * a new message gets through, so a post-rollup write is never suppressed
 * for more than ~60s (matching ROLLUP_COOLDOWN_SEC). Per-parent ordering
 * is preserved via MessageGroupId.
 */
export async function enqueueRollup(parentUri: string): Promise<void> {
  const uriHash = createHash('sha256').update(parentUri).digest('hex').slice(0, 40);
  const minuteBucket = Math.floor(Date.now() / 60_000);

  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        parentUri,
        triggeredAt: new Date().toISOString(),
      }),
      MessageGroupId: uriHash,
      MessageDeduplicationId: `rollup::${uriHash}::${minuteBucket}`,
    })
  );
}

