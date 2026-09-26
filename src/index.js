// Process entrypoint: load config, open the database (migrations run on
// open), build the HTTP app, listen on $PORT (default 3000). Zero external
// services; the only runtime dependency is express.
//
// This is the composition root for the policy stack and the ONLY reader of
// POLICY_SIGNING_SECRET: buildApp assembles the kernel, the trust reader, the
// executor and the write routes from what it is handed here, so no route file
// and no policy module ever touches process.env.

import { openDatabase, DEFAULT_DB_PATH } from './data/db.js';
import { createRepositories } from './data/repositories.js';
import { buildApp, packageVersion } from './api/routes.js';
import { DEFAULT_SIGNING_SECRET } from './policy/kernel.js';

export function configFromEnv(env = process.env) {
  return {
    port: Number.parseInt(env.PORT ?? '', 10) || 3000,
    dbPath: env.DB_PATH || DEFAULT_DB_PATH,
    // An unset secret falls back to the dev-only literal, which the kernel
    // documents as forgeable. A deployment that means it sets this.
    policySecret: env.POLICY_SIGNING_SECRET || DEFAULT_SIGNING_SECRET,
  };
}

export function boot({ port, dbPath, policySecret = DEFAULT_SIGNING_SECRET }) {
  const db = openDatabase(dbPath);
  const repositories = createRepositories(db);
  const app = buildApp({
    repositories,
    policySecret,
    // The build's own version is stamped into every capability, so a receipt
    // says which policy produced it.
    policyVersion: packageVersion(),
    capabilityTtlMs: 900_000,
  });
  const server = app.listen(port, () => {
    console.log(`autonomous-growth-os listening on http://localhost:${port} (db: ${dbPath})`);
  });
  return { db, server };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  boot(configFromEnv());
}
