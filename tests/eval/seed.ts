const API_URL = process.env.VCS_API_URL;
const API_KEY = process.env.VCS_API_KEY;

if (!API_URL || !API_KEY) {
  console.error('VCS_API_URL and VCS_API_KEY must be set');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/json', 'x-api-key': API_KEY };

interface SeedDocument {
  uri_prefix: string;
  filename: string;
  content_base64: string;
  description: string;
}

const documents: SeedDocument[] = [
  {
    uri_prefix: 'viking://resources/eval/docs/',
    filename: 'short-test.md',
    content_base64: btoa('I prefer TypeScript for all backend services'),
    description: 'Short document (< 200 chars, bypasses Bedrock summarisation)',
  },
  {
    uri_prefix: 'viking://resources/eval/docs/',
    filename: 'long-test.md',
    content_base64: btoa('A'.repeat(1000)),
    description: 'Long document (> 200 chars, goes through Bedrock summarisation)',
  },
  {
    uri_prefix: 'viking://resources/eval/nested/',
    filename: 'nested-doc.md',
    content_base64: btoa('Nested document for filesystem testing'),
    description: 'Directory marker for ls/tree operations',
  },
];

let failed = false;

for (const doc of documents) {
  const response = await fetch(`${API_URL}/resources`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      content_base64: doc.content_base64,
      uri_prefix: doc.uri_prefix,
      filename: doc.filename,
    }),
  });

  console.log(`Seed [${doc.filename}]: ${response.status} ${response.statusText} — ${doc.description}`);

  if (!response.ok) {
    console.error(`  Failed to seed ${doc.filename}`);
    failed = true;
  }
}

if (failed) {
  console.error('Seed failed — one or more documents could not be created');
  process.exit(1);
}

console.log('Seed complete — all eval fixtures created');
