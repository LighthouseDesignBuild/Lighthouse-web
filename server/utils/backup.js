/**
 * Database Backup Utilities
 *
 * Handles backup and restore of the SQLite database to/from Railway bucket.
 * Backup is a single file that gets overwritten on each save.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { railwayConfig, validateRailwayConfig, isRailwayStorageEnabled } from '../config/railway.js';
import { DB_PATH, initDatabase } from '../models/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Backup key in bucket
const BACKUP_KEY = 'backups/lighthouse.db';

// Lazy S3 client initialization
let backupClient = null;

/**
 * Get or create the S3 client for backup operations
 */
function getBackupClient() {
  if (backupClient) return backupClient;

  validateRailwayConfig();

  backupClient = new S3Client({
    region: railwayConfig.region,
    endpoint: railwayConfig.endpoint,
    credentials: {
      accessKeyId: railwayConfig.accessKeyId,
      secretAccessKey: railwayConfig.secretAccessKey,
    },
    forcePathStyle: true,
  });

  return backupClient;
}

/**
 * Upload current database to Railway bucket
 * Overwrites the existing backup file
 * @returns {Promise<{success: boolean, message: string, timestamp: string}>}
 */
export async function backupDatabase() {
  if (!isRailwayStorageEnabled()) {
    console.log('Backup skipped: Railway storage not enabled');
    return {
      success: false,
      message: 'Railway storage not enabled',
      timestamp: new Date().toISOString(),
    };
  }

  try {
    // Read current database file
    if (!fs.existsSync(DB_PATH)) {
      throw new Error('Database file not found');
    }

    const dbBuffer = fs.readFileSync(DB_PATH);
    const client = getBackupClient();

    // Upload to bucket
    const command = new PutObjectCommand({
      Bucket: railwayConfig.bucketName,
      Key: BACKUP_KEY,
      Body: dbBuffer,
      ContentType: 'application/x-sqlite3',
      Metadata: {
        'backup-timestamp': new Date().toISOString(),
        'backup-size': dbBuffer.length.toString(),
      },
    });

    await client.send(command);

    const timestamp = new Date().toISOString();
    console.log(`✓ Database backed up to bucket at ${timestamp}`);

    return {
      success: true,
      message: 'Database backed up successfully',
      timestamp,
      size: dbBuffer.length,
    };
  } catch (error) {
    console.error('Backup failed:', error);
    return {
      success: false,
      message: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Check if a backup exists in the bucket
 * @returns {Promise<{exists: boolean, metadata?: object}>}
 */
export async function checkBackupExists() {
  if (!isRailwayStorageEnabled()) {
    return { exists: false, message: 'Railway storage not enabled' };
  }

  try {
    const client = getBackupClient();

    const command = new HeadObjectCommand({
      Bucket: railwayConfig.bucketName,
      Key: BACKUP_KEY,
    });

    const response = await client.send(command);

    return {
      exists: true,
      metadata: {
        lastModified: response.LastModified,
        size: response.ContentLength,
        backupTimestamp: response.Metadata?.['backup-timestamp'],
      },
    };
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return { exists: false };
    }
    throw error;
  }
}

/**
 * Restore database from Railway bucket backup
 * WARNING: This will replace the current database
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function restoreDatabase() {
  if (!isRailwayStorageEnabled()) {
    return {
      success: false,
      message: 'Railway storage not enabled',
    };
  }

  try {
    const client = getBackupClient();

    // Download backup from bucket
    const command = new GetObjectCommand({
      Bucket: railwayConfig.bucketName,
      Key: BACKUP_KEY,
    });

    const response = await client.send(command);

    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    const dbBuffer = Buffer.concat(chunks);

    // Validate it's a valid SQLite database (check magic header)
    const sqliteHeader = 'SQLite format 3';
    const headerStr = dbBuffer.slice(0, 15).toString('utf8');
    if (headerStr !== sqliteHeader) {
      throw new Error('Invalid backup file: not a valid SQLite database');
    }

    // Backup current database before restore (just in case)
    const dataDir = path.dirname(DB_PATH);
    const backupPath = path.join(dataDir, `lighthouse-pre-restore-${Date.now()}.db`);

    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, backupPath);
      console.log(`✓ Current database backed up to ${backupPath}`);
    }

    // Write restored database
    fs.writeFileSync(DB_PATH, dbBuffer);

    console.log('✓ Database restored from bucket backup');

    return {
      success: true,
      message: 'Database restored successfully. Please refresh the page.',
      restoredSize: dbBuffer.length,
      previousBackup: backupPath,
    };
  } catch (error) {
    console.error('Restore failed:', error);
    return {
      success: false,
      message: error.message,
    };
  }
}

/**
 * Get backup status information
 * @returns {Promise<object>}
 */
export async function getBackupStatus() {
  const status = {
    enabled: isRailwayStorageEnabled(),
    localDbExists: fs.existsSync(DB_PATH),
    localDbSize: null,
    backupExists: false,
    backupMetadata: null,
  };

  if (status.localDbExists) {
    const stats = fs.statSync(DB_PATH);
    status.localDbSize = stats.size;
    status.localDbModified = stats.mtime;
  }

  if (status.enabled) {
    try {
      const backupInfo = await checkBackupExists();
      status.backupExists = backupInfo.exists;
      status.backupMetadata = backupInfo.metadata;
    } catch (error) {
      status.backupError = error.message;
    }
  }

  return status;
}

export default {
  backupDatabase,
  restoreDatabase,
  checkBackupExists,
  getBackupStatus,
  BACKUP_KEY,
};
