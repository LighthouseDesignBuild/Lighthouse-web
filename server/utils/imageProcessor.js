import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getStorage } from '../services/storage.js';
import { VARIANT_SIZES } from '../config/railway.js';
import {
  uploadToRailway,
  generateImageKey,
  generateVideoKey,
  sanitizeSlug,
  deleteMultipleFromRailway,
} from '../services/railwayClient.js';

// Lazy load sharp to avoid issues when not using Railway storage
let sharp = null;
async function getSharp() {
  if (!sharp) {
    sharp = (await import('sharp')).default;
  }
  return sharp;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get storage adapter (local or R2 based on STORAGE_TYPE)
let storage = null;
function getStorageAdapter() {
  if (!storage) {
    storage = getStorage();
  }
  return storage;
}

/**
 * Process uploaded image
 * Uses the configured storage adapter (local or R2)
 */
export async function processImage(inputPath, filename) {
  const ext = path.extname(filename).toLowerCase();
  const baseName = path.basename(filename, ext);

  // Keep original format
  const outputFilename = `${baseName}${ext}`;

  try {
    // Save to storage (local or R2)
    const storageAdapter = getStorageAdapter();
    const filepath = await storageAdapter.save(inputPath, outputFilename);

    return {
      filename: outputFilename,
      filepath: filepath,
      thumbnail: filepath, // Use same image as thumbnail
    };
  } catch (err) {
    // Clean up on error
    if (fs.existsSync(inputPath)) {
      await fs.promises.unlink(inputPath);
    }
    throw err;
  }
}

/**
 * Process video file
 * Optionally accepts a client-generated thumbnail file
 * @param {string} inputPath - Path to the uploaded video
 * @param {string} filename - The filename for the video
 * @param {object} thumbFile - Optional multer file object for thumbnail
 */
export async function processVideo(inputPath, filename, thumbFile = null) {
  const baseName = path.basename(filename, path.extname(filename));
  let thumbnailPath = null;

  try {
    const storageAdapter = getStorageAdapter();

    // Save video to storage
    const filepath = await storageAdapter.save(inputPath, filename);

    // If client provided a thumbnail, save it too
    if (thumbFile && thumbFile.path) {
      const thumbFilename = `${baseName}_thumb.jpg`;
      thumbnailPath = await storageAdapter.save(thumbFile.path, thumbFilename);
    }

    return {
      filename,
      filepath: filepath,
      thumbnail: thumbnailPath
    };
  } catch (err) {
    // Clean up on error
    if (fs.existsSync(inputPath)) {
      await fs.promises.unlink(inputPath);
    }
    if (thumbFile && thumbFile.path && fs.existsSync(thumbFile.path)) {
      await fs.promises.unlink(thumbFile.path);
    }
    throw err;
  }
}

/**
 * Delete processed files (main + thumbnail)
 * Works with both local paths and R2 URLs
 */
export async function deleteProcessedFiles(filepath, thumbnail) {
  const storageAdapter = getStorageAdapter();
  const deleted = [];

  try {
    // Delete main file
    if (filepath) {
      const mainDeleted = await storageAdapter.delete(filepath);
      if (mainDeleted) deleted.push(filepath);
    }

    // Delete thumbnail if different from main file
    if (thumbnail && thumbnail !== filepath) {
      const thumbDeleted = await storageAdapter.delete(thumbnail);
      if (thumbDeleted) deleted.push(thumbnail);
    }
  } catch (err) {
    console.warn('Warning deleting files:', err.message);
  }

  return deleted;
}

/**
 * Get YouTube video ID from URL
 */
export function getYoutubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Get Vimeo video ID from URL
 */
export function getVimeoId(url) {
  const match = url.match(/vimeo\.com\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Get thumbnail URL for video embeds
 */
export function getEmbedThumbnail(url, platform) {
  if (platform === 'youtube') {
    const videoId = getYoutubeId(url);
    if (videoId) {
      return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    }
  }

  if (platform === 'vimeo') {
    // Vimeo thumbnails require API call, return placeholder
    return null;
  }

  return null;
}

/**
 * Detect embed platform from URL
 */
export function detectEmbedPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return 'youtube';
  }
  if (url.includes('vimeo.com')) {
    return 'vimeo';
  }
  return null;
}

// ============================================================
// Railway Buckets Processing Functions
// ============================================================

/**
 * Generate an 8-character content hash from a buffer
 * @param {Buffer} buffer - File contents
 * @returns {string} 8-character hex hash
 */
export function generateContentHash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex').substring(0, 8);
}

/**
 * Generate a tiny base64 blur placeholder image (16x16 pixels)
 * Used for instant visual feedback while the full image loads
 * @param {Buffer} inputBuffer - Original image buffer
 * @returns {Promise<string>} Base64 data URL for the blur placeholder
 */
export async function generateBlurPlaceholder(inputBuffer) {
  const sharpInstance = await getSharp();

  // Create a tiny 16x16 pixel version with blur
  const blurBuffer = await sharpInstance(inputBuffer)
    .resize(16, 16, { fit: 'cover' })
    .blur(1) // Slight blur for smoother appearance
    .webp({ quality: 20 }) // Very low quality is fine for placeholder
    .toBuffer();

  // Return as base64 data URL
  return `data:image/webp;base64,${blurBuffer.toString('base64')}`;
}

/**
 * Generate responsive WebP variants using Sharp
 * @param {Buffer} inputBuffer - Original image buffer
 * @returns {Promise<Object>} Variants object with sm, md, lg buffers and dimensions
 */
export async function generateVariants(inputBuffer) {
  const sharpInstance = await getSharp();
  const variants = {};

  for (const [size, config] of Object.entries(VARIANT_SIZES)) {
    const image = sharpInstance(inputBuffer);
    const metadata = await image.metadata();

    // Resize only if image is larger than target width
    const resizedImage = image.resize({
      width: config.width,
      withoutEnlargement: true,
    });

    const buffer = await resizedImage.webp({ quality: 85 }).toBuffer();

    // Get actual dimensions after resize
    const resizedMetadata = await sharpInstance(buffer).metadata();

    variants[size] = {
      buffer,
      width: resizedMetadata.width,
      height: resizedMetadata.height,
    };
  }

  return variants;
}

/**
 * Process image for Railway Buckets storage
 * Generates WebP variants and uploads to Railway
 * @param {string} inputPath - Path to uploaded file
 * @param {string} filename - Original filename
 * @returns {Promise<Object>} Keys and metadata for database storage
 */
export async function processImageForRailway(inputPath, filename) {
  const uploadedKeys = [];

  try {
    // Read the original file
    const inputBuffer = await fs.promises.readFile(inputPath);

    // Generate content hash for cache busting
    const contentHash = generateContentHash(inputBuffer);

    // Create slug from filename
    const baseName = path.basename(filename, path.extname(filename));
    const slug = sanitizeSlug(baseName);

    // Generate WebP variants
    const variants = await generateVariants(inputBuffer);

    // Generate blur placeholder for instant loading
    const blurData = await generateBlurPlaceholder(inputBuffer);

    // Upload each variant to Railway
    const keys = {};
    for (const [size, variant] of Object.entries(variants)) {
      const key = generateImageKey(slug, contentHash, size);
      await uploadToRailway(variant.buffer, key, 'image/webp');
      uploadedKeys.push(key);
      keys[`key_${size}`] = key;
    }

    // Clean up the local upload file
    await fs.promises.unlink(inputPath);

    return {
      filename,
      keys: {
        key_sm: keys.key_sm,
        key_md: keys.key_md,
        key_lg: keys.key_lg,
      },
      contentHash,
      blurData, // Base64 blur placeholder for instant loading
      dimensions: {
        sm: { width: variants.sm.width, height: variants.sm.height },
        md: { width: variants.md.width, height: variants.md.height },
        lg: { width: variants.lg.width, height: variants.lg.height },
      },
    };
  } catch (err) {
    // Rollback: delete any uploaded keys
    if (uploadedKeys.length > 0) {
      await deleteMultipleFromRailway(uploadedKeys);
    }

    // Clean up local file
    if (fs.existsSync(inputPath)) {
      await fs.promises.unlink(inputPath);
    }

    throw err;
  }
}

/**
 * Process video for Railway Buckets storage
 * Uploads video as-is and generates thumbnail variants if provided
 * @param {string} inputPath - Path to uploaded video
 * @param {string} filename - Original filename
 * @param {Object} thumbFile - Optional multer file object for thumbnail
 * @returns {Promise<Object>} Keys and metadata for database storage
 */
export async function processVideoForRailway(inputPath, filename, thumbFile = null) {
  const uploadedKeys = [];

  try {
    // Read the video file
    const videoBuffer = await fs.promises.readFile(inputPath);

    // Generate content hash
    const contentHash = generateContentHash(videoBuffer);

    // Create slug from filename
    const baseName = path.basename(filename, path.extname(filename));
    const slug = sanitizeSlug(baseName);

    // Determine content type from extension
    const ext = path.extname(filename).toLowerCase();
    const videoContentTypes = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
    };
    const contentType = videoContentTypes[ext] || 'video/mp4';

    // Upload video to Railway
    const videoKey = generateVideoKey(slug, contentHash);
    await uploadToRailway(videoBuffer, videoKey, contentType);
    uploadedKeys.push(videoKey);

    // Process thumbnail if provided
    let thumbnailKeys = null;
    let blurData = null;
    if (thumbFile && thumbFile.path) {
      const thumbBuffer = await fs.promises.readFile(thumbFile.path);
      const thumbHash = generateContentHash(thumbBuffer);
      const thumbSlug = `${slug}-thumb`;

      // Generate thumbnail variants
      const thumbVariants = await generateVariants(thumbBuffer);

      // Generate blur placeholder for instant loading
      blurData = await generateBlurPlaceholder(thumbBuffer);

      thumbnailKeys = {};
      for (const [size, variant] of Object.entries(thumbVariants)) {
        const key = generateImageKey(thumbSlug, thumbHash, size);
        await uploadToRailway(variant.buffer, key, 'image/webp');
        uploadedKeys.push(key);
        thumbnailKeys[`key_${size}`] = key;
      }

      // Clean up thumbnail file
      await fs.promises.unlink(thumbFile.path);
    }

    // Clean up the local video file
    await fs.promises.unlink(inputPath);

    return {
      filename,
      videoKey,
      thumbnailKeys,
      contentHash,
      blurData, // Base64 blur placeholder for video thumbnail
    };
  } catch (err) {
    // Rollback: delete any uploaded keys
    if (uploadedKeys.length > 0) {
      await deleteMultipleFromRailway(uploadedKeys);
    }

    // Clean up local files
    if (fs.existsSync(inputPath)) {
      await fs.promises.unlink(inputPath);
    }
    if (thumbFile && thumbFile.path && fs.existsSync(thumbFile.path)) {
      await fs.promises.unlink(thumbFile.path);
    }

    throw err;
  }
}

/**
 * Delete Railway Buckets files by keys
 * Handles both image variants and video keys
 * @param {Object} keys - Object with key_sm, key_md, key_lg, or videoKey
 * @param {Object} thumbnailKeys - Optional thumbnail variant keys
 * @returns {Promise<Object>} Deletion results
 */
export async function deleteRailwayFiles(keys, thumbnailKeys = null) {
  const keysToDelete = [];

  // Collect image/video keys
  if (keys) {
    if (keys.key_sm) keysToDelete.push(keys.key_sm);
    if (keys.key_md) keysToDelete.push(keys.key_md);
    if (keys.key_lg) keysToDelete.push(keys.key_lg);
    if (keys.videoKey) keysToDelete.push(keys.videoKey);
  }

  // Collect thumbnail keys
  if (thumbnailKeys) {
    if (thumbnailKeys.key_sm) keysToDelete.push(thumbnailKeys.key_sm);
    if (thumbnailKeys.key_md) keysToDelete.push(thumbnailKeys.key_md);
    if (thumbnailKeys.key_lg) keysToDelete.push(thumbnailKeys.key_lg);
  }

  if (keysToDelete.length === 0) {
    return { success: 0, failed: 0 };
  }

  return deleteMultipleFromRailway(keysToDelete);
}

export default {
  processImage,
  processVideo,
  deleteProcessedFiles,
  getYoutubeId,
  getVimeoId,
  getEmbedThumbnail,
  detectEmbedPlatform,
  // Railway-specific exports
  generateContentHash,
  generateVariants,
  generateBlurPlaceholder,
  processImageForRailway,
  processVideoForRailway,
  deleteRailwayFiles,
};
