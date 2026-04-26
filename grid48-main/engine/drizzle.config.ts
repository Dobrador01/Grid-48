import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DB_PATH || "./data/grid48.db",
  },
  verbose: true,
  strict: true,
});
