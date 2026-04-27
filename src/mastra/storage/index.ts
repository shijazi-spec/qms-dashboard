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
