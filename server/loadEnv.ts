/**
 * Load server.env from the server directory before any other modules run.
 * Must be the first import in index.ts so COSMOS_*, SNOWFLAKE_*, etc. are set
 * before database.config and other code read process.env.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, 'server.env') });
