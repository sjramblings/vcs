import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { writeFileSync } from 'fs';

const args = process.argv.slice(2);
const startIdx = args.indexOf('--start');
const endIdx = args.indexOf('--end');

if (startIdx === -1 || endIdx === -1) {
  console.error('Usage: collect-metrics.ts --start <ISO8601> --end <ISO8601>');
  process.exit(1);
}

const startTime = args[startIdx + 1];
const endTime = args[endIdx + 1];
const region = process.env.AWS_REGION ?? 'ap-southeast-2';

const client = new CloudWatchClient({ region });

interface MetricQuery {
  id: string;
  namespace: string;
  metric: string;
  stat: string;
  dimensions?: { Name: string; Value: string }[];
}

const queries: MetricQuery[] = [
  // Bedrock usage
  { id: 'bedrock_input_tokens', namespace: 'AWS/Bedrock', metric: 'InputTokenCount', stat: 'Sum' },
  { id: 'bedrock_output_tokens', namespace: 'AWS/Bedrock', metric: 'OutputTokenCount', stat: 'Sum' },
  { id: 'bedrock_throttles', namespace: 'AWS/Bedrock', metric: 'InvocationThrottles', stat: 'Sum' },
  { id: 'bedrock_latency_p95', namespace: 'AWS/Bedrock', metric: 'InvocationLatency', stat: 'p95' },
  // DynamoDB capacity
  { id: 'dynamo_rcu', namespace: 'AWS/DynamoDB', metric: 'ConsumedReadCapacityUnits', stat: 'Sum',
    dimensions: [{ Name: 'TableName', Value: 'vcs-context' }] },
  { id: 'dynamo_wcu', namespace: 'AWS/DynamoDB', metric: 'ConsumedWriteCapacityUnits', stat: 'Sum',
    dimensions: [{ Name: 'TableName', Value: 'vcs-context' }] },
  // Lambda health
  { id: 'lambda_errors', namespace: 'AWS/Lambda', metric: 'Errors', stat: 'Sum' },
  { id: 'lambda_cold_starts', namespace: 'AWS/Lambda', metric: 'Init Duration', stat: 'Sum' },
  // SQS DLQ depth
  { id: 'dlq_rollup', namespace: 'AWS/SQS', metric: 'ApproximateNumberOfMessagesVisible', stat: 'Maximum',
    dimensions: [{ Name: 'QueueName', Value: 'vcs-rollup-dlq.fifo' }] },
  { id: 'dlq_bridge', namespace: 'AWS/SQS', metric: 'ApproximateNumberOfMessagesVisible', stat: 'Maximum',
    dimensions: [{ Name: 'QueueName', Value: 'vcs-memory-bridge-dlq' }] },
  // Custom VCS metrics (from Powertools EMF)
  { id: 'vector_query_p95', namespace: 'VCS', metric: 'VectorQueryLatency', stat: 'p95' },
  { id: 'bedrock_cost', namespace: 'VCS', metric: 'BedrockEstimatedCostUSD', stat: 'Sum' },
];

async function collectMetrics() {
  console.log(`Collecting metrics from ${startTime} to ${endTime} (${region})`);

  const command = new GetMetricDataCommand({
    StartTime: new Date(startTime),
    EndTime: new Date(endTime),
    MetricDataQueries: queries.map((q) => ({
      Id: q.id,
      MetricStat: {
        Metric: {
          Namespace: q.namespace,
          MetricName: q.metric,
          Dimensions: q.dimensions,
        },
        Period: 300,
        Stat: q.stat,
      },
    })),
  });

  const result = await client.send(command);

  const metrics: Record<string, number | null> = {};
  for (const r of result.MetricDataResults ?? []) {
    const values = r.Values ?? [];
    metrics[r.Id!] = values.length > 0
      ? values.reduce((a, b) => a + b, 0)
      : null;
  }

  const output = {
    eval_window: { start: startTime, end: endTime },
    region,
    collected_at: new Date().toISOString(),
    metrics,
  };

  const outputPath = '/tmp/test-results/aws-metrics.json';
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Metrics written to ${outputPath}`);
  console.log(JSON.stringify(output, null, 2));
}

collectMetrics().catch((err) => {
  console.error('Failed to collect metrics:', err);
  process.exit(1);
});
