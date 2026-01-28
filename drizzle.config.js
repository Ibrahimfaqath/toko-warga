// drizzle.config.js
import { defineConfig } from 'drizzle-kit';

// LOAD ENV OTOMATIS
process.loadEnvFile();

export default defineConfig({
    schema: './src/db/schema.js',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials: {
        url: process.env.DATABASE_URL,
    },
});