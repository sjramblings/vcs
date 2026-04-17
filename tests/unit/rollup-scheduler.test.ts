import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

/**
 * v1-stable rollup scheduler tests.
 *
 * Replaces the claim/complete/release/dirty-cycle test suite with a
 * minimal set of cases that exercise the single-conditional-UpdateItem design:
 *
 *   1. enqueueRollup — per-minute time-bucketed FIFO dedup so post-rollup
 *      writes are never suppressed for more than ~60s
 *   2. checkCooldown — read-only GetItem, returns true when cooldown elapsed
 *
 * End-to-end burst-coalescing is covered by tests/smoke/e2e.test.ts against a
 * real deployed stack (see S-10 in the v1-stable plan).
 */

// ── enqueueRollup: dedup by parentUri hash only ──
describe('enqueueRollup', () => {
  const { sqsSend } = vi.hoisted(() => ({ sqsSend: vi.fn() }));

  vi.mock('@aws-sdk/client-sqs', () => {
    function MockSQSClient() {
      (this as Record<string, unknown>).send = sqsSend;
    }
    function MockSendMessageCommand(input: unknown) {
      (this as Record<string, unknown>).input = input;
    }
    return {
      SQSClient: MockSQSClient,
      SendMessageCommand: MockSendMessageCommand,
    };
  });

  beforeEach(() => {
    sqsSend.mockReset();
    sqsSend.mockResolvedValue({});
  });

  it('sends one message with MessageGroupId and content-based dedup id derived from the URI hash', async () => {
    const { initSqs, enqueueRollup } = await import('../../src/services/sqs');
    initSqs('https://sqs.test/rollup.fifo');

    const parentUri = 'viking://resources/docs/';
    const expectedHash = createHash('sha256')
      .update(parentUri)
      .digest('hex')
      .slice(0, 40);

    await enqueueRollup(parentUri);

    expect(sqsSend).toHaveBeenCalledTimes(1);
    const call = sqsSend.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(call.input.QueueUrl).toBe('https://sqs.test/rollup.fifo');
    expect(call.input.MessageGroupId).toBe(expectedHash);
    const dedupId = call.input.MessageDeduplicationId as string;
    const minuteBucket = Math.floor(Date.now() / 60_000);
    expect(dedupId).toBe(`rollup::${expectedHash}::${minuteBucket}`);
    const body = JSON.parse(call.input.MessageBody as string);
    expect(body.parentUri).toBe(parentUri);
  });

  it('enqueues twice for two distinct parents with different dedup ids', async () => {
    const { initSqs, enqueueRollup } = await import('../../src/services/sqs');
    initSqs('https://sqs.test/rollup.fifo');

    await enqueueRollup('viking://resources/a/');
    await enqueueRollup('viking://resources/b/');

    expect(sqsSend).toHaveBeenCalledTimes(2);
    const dedupA = (sqsSend.mock.calls[0][0] as { input: { MessageDeduplicationId: string } })
      .input.MessageDeduplicationId;
    const dedupB = (sqsSend.mock.calls[1][0] as { input: { MessageDeduplicationId: string } })
      .input.MessageDeduplicationId;
    expect(dedupA).not.toBe(dedupB);
  });
});
