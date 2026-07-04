// MUST run before process.env.DATABASE_URL is read below: this is the fatal
// boot path (PostgresStore.init crash-loops the whole server if the DB TLS
// handshake fails). Importing the normalizer here — not only in the entry
// point — guarantees the sslmode rewrite happens before this module reads the
// connection string, independent of bundler/import-order behavior.
import { normalizeSslMode } from "../../utils/normalizeDatabaseUrl";
import { PostgresStore } from "@mastra/pg";

const rawConnectionString = process.env.DATABASE_URL;

if (!rawConnectionString) {
  throw new Error(
    "DATABASE_URL is required but was not set. " +
      "Configure it in Replit Secrets (production) or in your local .env (development). " +
      "Refusing to start to avoid silently connecting to a non-existent database.",
  );
}

// Apply the sslmode normalization DIRECTLY to the string we hand to
// PostgresStore rather than relying on the module-load side-effect having
// already rewritten process.env.DATABASE_URL. In the production bundle this
// module can read the env var before that side-effect runs, which reintroduces
// the `sslmode=require` -> verify-full TLS crash (PostgresStore.init failure
// crash-loops the whole server and fails the deploy health check). The pure
// transform is idempotent, so double-normalization is safe. See
// src/utils/normalizeDatabaseUrl.ts.
const connectionString = normalizeSslMode(rawConnectionString)!;

export const sharedPostgresStorage = new PostgresStore({
  connectionString,
});
