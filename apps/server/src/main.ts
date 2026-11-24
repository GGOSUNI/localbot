import { runSupervisor } from './supervisor.ts';
import { runWorker } from './worker.ts';

if (process.argv.includes('--worker')) await runWorker();
else await runSupervisor();
