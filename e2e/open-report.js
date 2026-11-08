// npm run e2e:report  opens e2e/results/index.html in the default browser
import { spawn } from 'node:child_process';
import path from 'node:path';

const file = path.resolve(import.meta.dirname, 'results', 'index.html');
const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]]
  : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
console.log(file);
