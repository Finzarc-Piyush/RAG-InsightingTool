import { Router } from 'express';
import {
  getSnowflakeDatabases,
  getSnowflakeSchemas,
  getSnowflakeTables,
  importSnowflakeTable,
} from '../controllers/snowflakeController.js';

const router = Router();

router.get('/snowflake/databases', getSnowflakeDatabases);
router.get('/snowflake/schemas', getSnowflakeSchemas);
router.get('/snowflake/tables', getSnowflakeTables);
router.post('/snowflake/import', importSnowflakeTable);

export default router;
