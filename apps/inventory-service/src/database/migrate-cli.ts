import { migrateForDeploy } from './migrate';

// Run apart from app boot, so a failed migration stops the rollout instead of crashlooping the replicas
// that were serving fine. Railway's pre-deploy runs it through pre-deploy-cli, before the stock seed.
void migrateForDeploy().then((code) => process.exit(code));
