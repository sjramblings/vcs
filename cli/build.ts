import { mkdir } from 'node:fs/promises';

await mkdir('./dist', { recursive: true });

const proc = Bun.spawn(
  ['bun', 'build', '--compile', '--minify', '--bytecode', './src/index.ts', '--outfile', './dist/vcs'],
  { cwd: import.meta.dir, stdout: 'inherit', stderr: 'inherit' }
);

const exitCode = await proc.exited;
if (exitCode !== 0) {
  console.error('Build failed with exit code', exitCode);
  process.exit(1);
}

console.log('Built: dist/vcs');
