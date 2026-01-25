/**
 * Railway Buckets Client Factory
 *
 * S3-compatible client configured for Railway's Object Storage.
 * Includes presigned URL generation for direct browser access.
 * Only initializes when Railway storage is enabled (STORAGE_TYPE=railway)
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { railwayConfig, validateRailwayConfig, PRESIGN_EXPIRY_SECONDS, MEDIA_PATHS } from '../config/railway.js';

// Lazy initialization - only create client when needed
let railwayClient = null;

/**
 * Get or create the Railway S3 client
 * @returns {S3Client} Configured Railway client
 */
export function getRailwayClient() {
  if (railwayClient) return railwayClient;

  // Validate configuration before creating client
  validateRailwayConfig();

  // Log configuration for debugging (mask secrets)
  console.log('=== Railway Buckets Configuration ===');
  console.log('Bucket Name:', railwayConfig.bucketName);
  console.log('Endpoint:', railwayConfig.endpoint);
  console.log('Region:', railwayConfig.region);
  console.log('Access Key ID:', railwayConfig.accessKeyId ? `${railwayConfig.accessKeyId.substring(0, 4)}...` : 'NOT SET');
  console.log('Secret Key:', railwayConfig.secretAccessKey ? 'SET (hidden)' : 'NOT SET');
  console.log('=====================================');

  railwayClient = new S3Client({
    region: railwayConfig.region,
    endpoint: railwayConfig.endpoint,
    credentials: {
      accessKeyId: railwayConfig.accessKeyId,
      secretAccessKey: railwayConfig.secretAccessKey,
    },
    forcePathStyle: true, // Required for S3-compatible services
  });

  console.log('✓ Railway Buckets client initialized');
  return railwayClient;
}

/**
 * Upload a file to Railway Buckets
 * @param {Buffer} body - File contents
 * @param {string} key - Object key (path in bucket)
 * @param {string} contentType - MIME type
 * @returns {Promise<string>} Object key (use getPresignedUrl for access)
 */
export async function uploadToRailway(body, key, contentType) {
  const client = getRailwayClient();

  console.log(`Uploading to Railway: Bucket="${railwayConfig.bucketName}", Key="${key}"`);

  const command = new PutObjectCommand({
    Bucket: railwayConfig.bucketName,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  });

  try {
    await client.send(command);
    console.log(`✓ Upload successful: ${key}`);
    return key;
  } catch (err) {
    console.error(`✗ Upload failed for ${key}:`, err.Code || err.name, err.message);
    console.error('Bucket attempted:', railwayConfig.bucketName);
    console.error('Endpoint used:', railwayConfig.endpoint);
    throw err;
  }
}

/**
 * Delete a file from Railway Buckets
 * @param {string} key - Object key to delete
 * @returns {Promise<boolean>} True if deleted successfully
 */
export async function deleteFromRailway(key) {
  const client = getRailwayClient();

  try {
    const command = new DeleteObjectCommand({
      Bucket: railwayConfig.bucketName,
      Key: key,
    });

    await client.send(command);
    return true;
  } catch (err) {
    console.error('Railway delete error:', err);
    return false;
  }
}

/**
 * Check if a file exists in Railway Buckets
 * @param {string} key - Object key to check
 * @returns {Promise<boolean>} True if exists
 */
export async function existsInRailway(key) {
  const client = getRailwayClient();

  try {
    const command = new HeadObjectCommand({
      Bucket: railwayConfig.bucketName,
      Key: key,
    });

    await client.send(command);
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

/**
 * Generate a presigned URL for direct browser access
 * @param {string} key - Object key
 * @param {number} expiresIn - Expiry time in seconds (default from config)
 * @returns {Promise<string>} Presigned URL valid for specified duration
 */
export async function getPresignedUrl(key, expiresIn = PRESIGN_EXPIRY_SECONDS) {
  const client = getRailwayClient();

  const command = new GetObjectCommand({
    Bucket: railwayConfig.bucketName,
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Generate presigned URLs for multiple keys
 * @param {string[]} keys - Array of object keys
 * @param {number} expiresIn - Expiry time in seconds
 * @returns {Promise<Object>} Map of key -> presigned URL
 */
export async function getPresignedUrls(keys, expiresIn = PRESIGN_EXPIRY_SECONDS) {
  const urlMap = {};

  await Promise.all(
    keys.map(async (key) => {
      if (key) {
        urlMap[key] = await getPresignedUrl(key, expiresIn);
      }
    })
  );

  return urlMap;
}

/**
 * Generate an object key for images
 * Format: images/gallery/<slug>-<hash>-<size>.webp
 * @param {string} slug - Sanitized image name
 * @param {string} hash - Content hash (8 chars)
 * @param {string} size - Variant size (sm, md, lg)
 * @returns {string} Object key
 */
export function generateImageKey(slug, hash, size) {
  const sanitizedSlug = sanitizeSlug(slug);
  return `${MEDIA_PATHS.images}/gallery/${sanitizedSlug}-${hash}-${size}.webp`;
}

/**
 * Generate an object key for videos
 * Format: videos/gallery/<slug>-<hash>.mp4
 * @param {string} slug - Sanitized video name
 * @param {string} hash - Content hash (8 chars)
 * @returns {string} Object key
 */
export function generateVideoKey(slug, hash) {
  const sanitizedSlug = sanitizeSlug(slug);
  return `${MEDIA_PATHS.videos}/gallery/${sanitizedSlug}-${hash}.mp4`;
}

/**
 * Sanitize a string for use in object keys
 * - Lowercase
 * - Replace spaces and special chars with hyphens
 * - Remove consecutive hyphens
 * - Trim hyphens from ends
 * @param {string} input - Raw input string
 * @returns {string} Sanitized slug
 */
export function sanitizeSlug(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50); // Limit length
}

/**
 * Delete multiple keys from Railway Buckets
 * @param {string[]} keys - Array of object keys to delete
 * @returns {Promise<Object>} Results with success/failure counts
 */
export async function deleteMultipleFromRailway(keys) {
  const results = { success: 0, failed: 0, errors: [] };

  await Promise.all(
    keys.filter(Boolean).map(async (key) => {
      try {
        const deleted = await deleteFromRailway(key);
        if (deleted) {
          results.success++;
        } else {
          results.failed++;
        }
      } catch (err) {
        results.failed++;
        results.errors.push({ key, error: err.message });
      }
    })
  );

  return results;
}

export default {
  getClient: getRailwayClient,
  upload: uploadToRailway,
  delete: deleteFromRailway,
  deleteMultiple: deleteMultipleFromRailway,
  exists: existsInRailway,
  getPresignedUrl,
  getPresignedUrls,
  generateImageKey,
  generateVideoKey,
  sanitizeSlug,
};
