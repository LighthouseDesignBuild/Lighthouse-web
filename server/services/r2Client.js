/**
 * Cloudflare R2 Client Factory
 *
 * S3-compatible client configured for Cloudflare R2.
 * Only initializes when R2 storage is enabled (STORAGE_TYPE=r2)
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

// Lazy initialization - only create client when needed
let r2Client = null;

/**
 * Get or create the R2 client
 * @returns {S3Client} Configured R2 client
 */
function getR2Client() {
  if (r2Client) return r2Client;

  // Validate required environment variables
  const requiredVars = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const missing = requiredVars.filter(v => !process.env[v]);

  if (missing.length > 0) {
    throw new Error(`Missing required R2 environment variables: ${missing.join(', ')}`);
  }

  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  console.log('✓ R2 client initialized');
  return r2Client;
}

/**
 * Upload a file to R2
 * @param {Buffer} body - File contents
 * @param {string} key - Object key (path in bucket)
 * @param {string} contentType - MIME type
 * @returns {Promise<string>} Public URL of uploaded file
 */
async function uploadToR2(body, key, contentType) {
  const client = getR2Client();

  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  });

  await client.send(command);

  // Return public URL
  const baseUrl = process.env.R2_PUBLIC_BASE_URL || `https://${process.env.R2_BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return `${baseUrl}/${key}`;
}

/**
 * Delete a file from R2
 * @param {string} key - Object key to delete
 * @returns {Promise<boolean>} True if deleted successfully
 */
async function deleteFromR2(key) {
  const client = getR2Client();

  try {
    const command = new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    });

    await client.send(command);
    return true;
  } catch (err) {
    console.error('R2 delete error:', err);
    return false;
  }
}

/**
 * Check if a file exists in R2
 * @param {string} key - Object key to check
 * @returns {Promise<boolean>} True if exists
 */
async function existsInR2(key) {
  const client = getR2Client();

  try {
    const command = new HeadObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    });

    await client.send(command);
    return true;
  } catch (err) {
    if (err.name === 'NotFound') return false;
    throw err;
  }
}

/**
 * Get the public URL for an R2 object
 * @param {string} key - Object key
 * @returns {string} Public URL
 */
function getR2Url(key) {
  const baseUrl = process.env.R2_PUBLIC_BASE_URL || `https://${process.env.R2_BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return `${baseUrl}/${key}`;
}

/**
 * Extract the key from an R2 URL
 * @param {string} url - Full R2 URL
 * @returns {string|null} Object key or null if not an R2 URL
 */
function getKeyFromR2Url(url) {
  const baseUrl = process.env.R2_PUBLIC_BASE_URL;
  if (!baseUrl || !url.startsWith(baseUrl)) return null;
  return url.replace(baseUrl + '/', '');
}

export {
  getR2Client,
  uploadToR2,
  deleteFromR2,
  existsInR2,
  getR2Url,
  getKeyFromR2Url,
  PutObjectCommand,
  DeleteObjectCommand,
};

export default {
  getClient: getR2Client,
  upload: uploadToR2,
  delete: deleteFromR2,
  exists: existsInR2,
  getUrl: getR2Url,
  getKeyFromUrl: getKeyFromR2Url,
};
