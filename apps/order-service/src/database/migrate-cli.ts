import { migrateForDeploy } from './migrate';

// Run apart from app boot, so a failed migration stops the rollout instead of crashlooping the replicas
// that were serving fine. Railway's pre-deploy runs it before the new replica starts.
void migrateForDeploy().then((code) => process.exit(code));
