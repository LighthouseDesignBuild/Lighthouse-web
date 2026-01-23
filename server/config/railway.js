/**
 * Railway Buckets Configuration
 * S3-compatible storage configuration for Railway's Object Storage
 */

// Railway Bucket configuration from environment variables
export const railwayConfig = {
  bucketName: process.env.RAILWAY_BUCKET_NAME,
  endpoint: process.env.RAILWAY_BUCKET_ENDPOINT,
  accessKeyId: process.env.RAILWAY_ACCESS_KEY_ID,
  secretAccessKey: process.env.RAILWAY_SECRET_ACCESS_KEY,
  region: process.env.RAILWAY_BUCKET_REGION || 'us-east-1',
};

// Presigned URL expiry (default: 7 days)
export const PRESIGN_EXPIRY_SECONDS = parseInt(
  process.env.MEDIA_PRESIGN_EXPIRY_SECONDS || '604800',
  10
);

// Responsive image variant sizes
export const VARIANT_SIZES = {
  sm: { width: 400, suffix: 'sm' },
  md: { width: 800, suffix: 'md' },
  lg: { width: 1600, suffix: 'lg' },
};

// Media path prefixes
export const MEDIA_PATHS = {
  images: process.env.MEDIA_BASE_PATH_IMAGES || 'images',
  videos: process.env.MEDIA_BASE_PATH_VIDEOS || 'videos',
};

/**
 * Validate Railway configuration
 * Throws descriptive error if required environment variables are missing
 */
export function validateRailwayConfig() {
  const required = [
    { key: 'bucketName', env: 'RAILWAY_BUCKET_NAME' },
    { key: 'endpoint', env: 'RAILWAY_BUCKET_ENDPOINT' },
    { key: 'accessKeyId', env: 'RAILWAY_ACCESS_KEY_ID' },
    { key: 'secretAccessKey', env: 'RAILWAY_SECRET_ACCESS_KEY' },
  ];

  const missing = required.filter(({ key }) => !railwayConfig[key]);

  if (missing.length > 0) {
    const missingEnvVars = missing.map(({ env }) => env).join(', ');
    throw new Error(
      `Railway Buckets configuration incomplete. Missing environment variables: ${missingEnvVars}\n` +
      'Please set these in your .env file or Railway dashboard.'
    );
  }

  return true;
}

/**
 * Check if Railway storage is configured and enabled
 */
export function isRailwayStorageEnabled() {
  return process.env.STORAGE_TYPE === 'railway';
}

export default {
  railwayConfig,
  PRESIGN_EXPIRY_SECONDS,
  VARIANT_SIZES,
  MEDIA_PATHS,
  validateRailwayConfig,
  isRailwayStorageEnabled,
};
