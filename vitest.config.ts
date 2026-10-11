import { defineConfig } from 'vitest/config';
import { loadEnvFile } from 'node:process';
try { loadEnvFile('.env'); } catch { /* CI supplies the environment */ }
export default defineConfig({ test: { fileParallelism: false } });
