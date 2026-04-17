import type { Command } from '@commander-js/extra-typings';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { extractText } from 'unpdf';
import { apiCall } from '../lib/client.js';
import { normaliseFilename } from './ingest.js';
import { result, error, errorJson, status, success, colours as c } from '../lib/output.js';

const SUPPORTED_LOCAL_EXTS = new Set(['.pdf', '.html', '.htm', '.md', '.txt']);

// ── HTML to Markdown ───────────────────────────────���────────────────────────

function htmlToMarkdown(html: string): string {
  return html
    // Headings
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '\n#### $1\n')
    .replace(/<h5[^>]*>(.*?)<\/h5>/gi, '\n##### $1\n')
    .replace(/<h6[^>]*>(.*?)<\/h6>/gi, '\n###### $1\n')
    // Code blocks
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    // Links
    .replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    // Lists
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<\/?[ou]l[^>]*>/gi, '\n')
    // Paragraphs and breaks
    .replace(/<p[^>]*>(.*?)<\/p>/gis, '\n$1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Bold and italic
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Content extraction ──────────────────────────────────────────────────────

interface ExtractedContent {
  title: string;
  body: string;
  wordCount: number;
}

function isUrl(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://');
}

function deriveFilename(source: string): string {
  if (isUrl(source)) {
    try {
      const url = new URL(source);
      const segments = url.pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1] || url.hostname;
      const name = last.replace(/\.[^.]+$/, ''); // strip extension
      return normaliseFilename(name + '.md');
    } catch {
      return 'feed-content.md';
    }
  }
  const base = path.basename(source).replace(/\.[^.]+$/, '');
  return normaliseFilename(base + '.md');
}

async function extractFromHtml(html: string, sourceUrl?: string): Promise<ExtractedContent> {
  const { document } = parseHTML(html);
  const reader = new Readability(document);
  const article = reader.parse();

  if (!article) {
    throw new Error('Could not extract article content — page may not be an article');
  }

  const body = htmlToMarkdown(article.content);
  const title = article.title || 'Untitled';
  const header = sourceUrl ? `# ${title}\n\nSource: ${sourceUrl}\n\n` : `# ${title}\n\n`;

  return {
    title,
    body: header + body,
    wordCount: body.split(/\s+/).length,
  };
}

async function extractFromPdf(buffer: Uint8Array, source: string): Promise<ExtractedContent> {
  const { text, totalPages } = await extractText(buffer, { mergePages: true });

  if (!text || text.trim().length === 0) {
    throw new Error('PDF contains no extractable text (may be scanned/image-only)');
  }

  // Derive title from first line or filename
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) || '';
  const title = firstLine.length > 10 && firstLine.length < 200 ? firstLine.trim() : path.basename(source);
  const header = `# ${title}\n\nSource: ${source}\nPages: ${totalPages}\n\n`;

  return {
    title,
    body: header + text,
    wordCount: text.split(/\s+/).length,
  };
}

async function extractFromUrl(url: string): Promise<ExtractedContent> {
  status(`Fetching ${url}...`);
  const response = await fetch(url, {
    headers: { 'User-Agent': 'vcs-feed/1.0 (Viking Context Service)' },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/pdf')) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return extractFromPdf(buffer, url);
  }

  if (contentType.includes('text/html')) {
    const html = await response.text();
    return extractFromHtml(html, url);
  }

  if (contentType.includes('text/markdown') || contentType.includes('text/plain')) {
    const text = await response.text();
    return {
      title: deriveFilename(url).replace('.md', ''),
      body: `Source: ${url}\n\n${text}`,
      wordCount: text.split(/\s+/).length,
    };
  }

  throw new Error(`Unsupported content type: ${contentType.split(';')[0]}`);
}

async function extractFromFile(filePath: string): Promise<ExtractedContent> {
  const ext = path.extname(filePath).toLowerCase();

  if (!SUPPORTED_LOCAL_EXTS.has(ext)) {
    throw new Error(`Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_LOCAL_EXTS].join(', ')}`);
  }

  if (ext === '.pdf') {
    const buffer = new Uint8Array(await readFile(filePath));
    return extractFromPdf(buffer, filePath);
  }

  const content = await readFile(filePath, 'utf-8');

  if (ext === '.html' || ext === '.htm') {
    return extractFromHtml(content, filePath);
  }

  // .md, .txt — use directly
  // Try to extract title from YAML frontmatter or first heading
  const fmMatch = content.match(/^---\n[\s\S]*?title:\s*["']?(.+?)["']?\s*\n[\s\S]*?---/);
  const firstLine = content.split('\n').find((l) => l.trim().length > 0) || '';
  const title = fmMatch?.[1]
    || (firstLine.startsWith('#') ? firstLine.replace(/^#+\s*/, '') : path.basename(filePath));

  return {
    title,
    body: content,
    wordCount: content.split(/\s+/).length,
  };
}

// ── Command ───────────────────────────────���─────────────────────────────────

export function registerFeed(program: Command): void {
  program
    .command('feed')
    .description('Fetch and ingest content from URLs or local files (HTML, PDF, Markdown)')
    .argument('<source>', 'URL (http/https) or local file path')
    .option('--prefix <uri>', 'VCS URI prefix', 'viking://resources/feed/')
    .option('--filename <name>', 'Override auto-derived filename')
    .option('--dry-run', 'Show extracted content without ingesting')
    .action(async (source, options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;
      const prefix = options.prefix.endsWith('/') ? options.prefix : options.prefix + '/';

      try {
        // Extract content
        let extracted: ExtractedContent;
        if (isUrl(source)) {
          extracted = await extractFromUrl(source);
        } else {
          const resolved = path.resolve(source);
          try {
            await stat(resolved);
          } catch {
            if (isJson) errorJson('FEED_FAILED', `File not found: ${source}`);
            else error(`File not found: ${source}`);
            process.exit(1);
            return;
          }
          extracted = await extractFromFile(resolved);
        }

        const filename = options.filename
          ? normaliseFilename(options.filename)
          : deriveFilename(source);
        const uri = prefix + filename;

        // Dry run — show preview and exit
        if (options.dryRun) {
          if (isJson) {
            result({ title: extracted.title, source, words: extracted.wordCount, filename, uri, preview: extracted.body.slice(0, 500) }, true);
          } else {
            console.log(`  ${c.bold('Title')}: ${extracted.title}`);
            console.log(` ${c.bold('Source')}: ${source}`);
            console.log(`  ${c.bold('Words')}: ${extracted.wordCount.toLocaleString()}`);
            console.log(`   ${c.bold('File')}: ${filename}`);
            console.log(`    ${c.bold('URI')}: ${uri}`);
            console.log(`${c.bold('Preview')}: ${c.dim(extracted.body.slice(0, 300).replace(/\n/g, ' '))}...`);
          }
          process.exit(0);
          return;
        }

        // Ingest to VCS
        status('Ingesting to VCS...');
        const contentBase64 = Buffer.from(extracted.body).toString('base64');
        const response = await apiCall('resources', {
          method: 'POST',
          body: {
            content_base64: contentBase64,
            uri_prefix: prefix,
            filename,
          },
          timeout: 60_000,
        });

        if (!response.ok) {
          let msg = `API returned ${response.status}`;
          try {
            const errBody = (await response.json()) as Record<string, unknown>;
            if (errBody.error) msg = String(errBody.error);
          } catch { /* ignore */ }

          if (isJson) errorJson('FEED_FAILED', msg);
          else error(msg);
          process.exit(2);
          return;
        }

        const data = (await response.json()) as { uri: string };

        if (isJson) {
          result({ uri: data.uri, title: extracted.title, words: extracted.wordCount }, true);
        } else {
          success(`Ingested ${data.uri} (${extracted.wordCount.toLocaleString()} words)`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isJson) errorJson('FEED_FAILED', msg);
        else error(msg);
        process.exit(1);
      }
    });
}
