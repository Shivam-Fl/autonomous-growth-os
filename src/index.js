// Process entrypoint: load config, open the database (migrations run on
// open), build the HTTP app, listen on $PORT (default 3000). Zero external
// services; the only runtime dependency is express.

import { openDatabase, DEFAULT_DB_PATH } from './data/db.js';
import { createRepositories } from './data/repositories.js';
import { buildApp } from './api/routes.js';

export function configFromEnv(env = process.env) {
  return {
    port: Number.parseInt(env.PORT ?? '', 10) || 3000,
    dbPath: env.DB_PATH || DEFAULT_DB_PATH,
  };
}

export function boot({ port, dbPath }) {
  const db = openDatabase(dbPath);
  const repositories = createRepositories(db);
  const app = buildApp({ repositories });
  const server = app.listen(port, () => {
    console.log(`autonomous-growth-os listening on http://localhost:${port} (db: ${dbPath})`);
  });
  return { db, server };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  boot(configFromEnv());
}
