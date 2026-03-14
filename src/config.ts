import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

dotenv.config();

function getEnv(key: string, fallback?: string): string {
  const val = process.env[key] || fallback;
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function getEnvInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

/**
 * Resolve a secret with 3-tier fallback:
 *  1. Environment variable (highest priority — user explicit config)
 *  2. Persisted keys file in data directory (survives container restarts)
 *  3. Auto-generate and save to keys file (first run)
 */
function ensureSecret(key: string, keysFilePath: string): string {
  // 1. Env var takes priority
  const envVal = process.env[key];
  if (envVal && envVal.length > 0) return envVal;

  // 2. Try reading from persisted keys file
  let keysData: Record<string, string> = {};
  try {
    if (fs.existsSync(keysFilePath)) {
      keysData = JSON.parse(fs.readFileSync(keysFilePath, 'utf-8'));
      if (keysData[key] && keysData[key].length > 0) {
        return keysData[key];
      }
    }
  } catch {}

  // 3. Generate new key and persist
  const generated = crypto.randomBytes(32).toString('hex');
  keysData[key] = generated;

  try {
    const dir = path.dirname(keysFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keysFilePath, JSON.stringify(keysData, null, 2), { mode: 0o600 });
    console.log(`🔑 ${key} auto-generated and saved to ${keysFilePath}`);
  } catch (err) {
    console.warn(`⚠️  ${key} auto-generated but failed to persist: ${(err as Error).message}`);
  }

  return generated;
}

const dbPath = getEnv('DB_PATH', './data/kore.db');
const dataDir = path.dirname(dbPath);
const keysFilePath = path.join(dataDir, '.kore-keys.json');

export const config = {
  port: getEnvInt('PORT', 3060),
  host: getEnv('HOST', '0.0.0.0'),
  dbPath,
  encryptionKey: ensureSecret('KORE_ENCRYPTION_KEY', keysFilePath),
  jwtSecret: ensureSecret('JWT_SECRET', keysFilePath),
  ipinfoToken: process.env.IPINFO_TOKEN || '',
  firstTokenTimeout: getEnvInt('FIRST_TOKEN_TIMEOUT', 15000),
  nonStreamTimeout: getEnvInt('NON_STREAM_TIMEOUT', 30000),
  healthCheckInterval: getEnvInt('HEALTH_CHECK_INTERVAL', 60000),
  geoCacheTtl: getEnvInt('GEO_CACHE_TTL', 604800000),
};
