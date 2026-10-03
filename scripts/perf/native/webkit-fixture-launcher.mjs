// Mimic Tauri's launcher -> native app ancestry without cargo or the app.
import { spawn } from 'node:child_process';
const child = spawn(process.argv[2], [process.argv[3]], { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
