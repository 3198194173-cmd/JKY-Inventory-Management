import { localDatabase } from './sqlite.mjs';
export const env = process.env;
export const runtimeDatabase = localDatabase as unknown as D1Database;
