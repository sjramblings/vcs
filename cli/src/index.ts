import { Command } from '@commander-js/extra-typings';
import { registerHealth } from './commands/health.js';
import { registerConfig } from './commands/config.js';
import { registerFind } from './commands/find.js';
import { registerSearch } from './commands/search.js';
import { registerRead } from './commands/read.js';
import { registerLs } from './commands/ls.js';
import { registerTree } from './commands/tree.js';
import { registerIngest } from './commands/ingest.js';
import { registerRemember } from './commands/remember.js';
import { registerMkdir } from './commands/mkdir.js';
import { registerRm } from './commands/rm.js';
import { registerMv } from './commands/mv.js';
import { registerSession } from './commands/session.js';
import { registerStatus } from './commands/status.js';
import { registerFeed } from './commands/feed.js';

const program = new Command()
  .name('vcs')
  .description('Viking Context Service CLI')
  .version('2.2.0')
  .option('--json', 'Output raw JSON instead of human-readable format');

registerHealth(program);
registerConfig(program);
registerFind(program);
registerSearch(program);
registerRead(program);
registerLs(program);
registerTree(program);
registerIngest(program);
registerRemember(program);
registerMkdir(program);
registerRm(program);
registerMv(program);
registerSession(program);
registerStatus(program);
registerFeed(program);

program.parse();

export { program };
