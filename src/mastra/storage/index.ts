// MUST run before process.env.DATABASE_URL is read below: this is the fatal
// boot path (PostgresStore.init crash-loops the whole server if the DB TLS
// handshake fails). Importing the normalizer here — not only in the entry
// point — guarantees the sslmode rewrite happens before this module reads the
// connection string, independent of bundler/import-order behavior.
import "../../utils/normalizeDatabaseUrl";
import { PostgresStore } from "@mastra/pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required but was not set. " +
      "Configure it in Replit Secrets (production) or in your local .env (development). " +
      "Refusing to start to avoid silently connecting to a non-existent database.",
  );
}

export const sharedPostgresStorage = new PostgresStore({
  connectionString,
});
