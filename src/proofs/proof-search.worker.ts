import { runProofSearchPass } from './search/search.js';
import { installProofSearchWorkerRuntime } from './search/worker-runtime.js';

installProofSearchWorkerRuntime(self, runProofSearchPass);
