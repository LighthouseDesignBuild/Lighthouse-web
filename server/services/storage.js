import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { uploadToR2, deleteFromR2, existsInR2, getR2Url, getKeyFromR2Url } from './r2Client.js';
import { isRailwayStorageEnabled } from '../config/railway.js';
import {
  getPresignedUrl,
  getPresignedUrls,
  deleteMultipleFromRailway,
} from './railwayClient.js';
import {
  processImageForRailway,
  processVideoForRailway,
  deleteRailwayFiles,
} from '../utils/imageProcessor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths for local storage
const GALLERY_DIR = path.join(__dirname, '../../src/assets/images/gallery');
const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Only create local directories if using local storage
const isServerless = process.env.VERCEL === '1';
const useR2 = process.env.STORAGE_TYPE === 'r2';

if (!isServerless && !useR2 && !fs.existsSync(GALLERY_DIR)) {
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
}

/**
 * Local Storage Implementation
 * Default storage adapter for development.
 */
export const localStorage = {
  /**
   * Move file from uploads to gallery storage
   * @param {string} uploadPath - Path to uploaded file
   * @param {string} filename - Final filename
   * @returns {Promise<string>} - Web-accessible path
   */
  async save(uploadPath, filename) {
    const destPath = path.join(GALLERY_DIR, filename);

    // Copy file to gallery directory
    await fs.promises.copyFile(uploadPath, destPath);

    // Remove from uploads
    await fs.promises.unlink(uploadPath);

    // Return web-accessible path
    return `/src/assets/images/gallery/${filename}`;
  },

  /**
   * Delete file from storage
   * @param {string} filepath - Web-accessible path
   * @returns {Promise<boolean>}
   */
  async delete(filepath) {
    // Convert web path to filesystem path
    const fsPath = path.join(__dirname, '../..', filepath);

    if (fs.existsSync(fsPath)) {
      await fs.promises.unlink(fsPath);
      return true;
    }

    return false;
  },

  /**
   * Check if file exists
   * @param {string} filepath - Web-accessible path
   * @returns {boolean}
   */
  exists(filepath) {
    const fsPath = path.join(__dirname, '../..', filepath);
    return fs.existsSync(fsPath);
  },

  /**
   * Get full filesystem path
   * @param {string} filepath - Web-accessible path
   * @returns {string}
   */
  getFullPath(filepath) {
    return path.join(__dirname, '../..', filepath);
  },

  /**
   * Get URL (for local storage, just returns the path)
   * @param {string} filepath - Web-accessible path
   * @returns {string}
   */
  getUrl(filepath) {
    return filepath;
  },

  /**
   * Clean up temporary uploads older than specified age
   * @param {number} maxAgeMs - Max age in milliseconds
   */
  async cleanupUploads(maxAgeMs = 3600000) {
    if (!fs.existsSync(UPLOADS_DIR)) return;

    const files = await fs.promises.readdir(UPLOADS_DIR);
    const now = Date.now();

    for (const file of files) {
      if (file === '.gitkeep') continue;

      const filePath = path.join(UPLOADS_DIR, file);
      const stats = await fs.promises.stat(filePath);

      if (now - stats.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(filePath);
      }
    }
  },

  /**
   * Storage type identifier
   */
  type: 'local'
};

/**
 * Cloudflare R2 Storage Implementation
 * Uses S3-compatible API for cloud storage with no egress fees.
 */
export const r2Storage = {
  /**
   * Upload file to R2
   * @param {string} uploadPath - Path to uploaded file
   * @param {string} filename - Final filename
   * @returns {Promise<string>} - CDN URL
   */
  async save(uploadPath, filename) {
    // Read file contents
    const fileBuffer = await fs.promises.readFile(uploadPath);

    // Determine content type from extension
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';

    // Upload to R2 with gallery/ prefix
    const key = `gallery/${filename}`;
    const url = await uploadToR2(fileBuffer, key, contentType);

    // Clean up local upload file
    await fs.promises.unlink(uploadPath);

    return url;
  },

  /**
   * Delete file from R2
   * @param {string} filepath - Full CDN URL or key
   * @returns {Promise<boolean>}
   */
  async delete(filepath) {
    // Extract key from URL if needed
    let key = getKeyFromR2Url(filepath);
    if (!key) {
      // Assume it's already a key or a local path pattern
      key = filepath.startsWith('gallery/') ? filepath : `gallery/${path.basename(filepath)}`;
    }

    return await deleteFromR2(key);
  },

  /**
   * Check if file exists in R2
   * @param {string} filepath - Full CDN URL or key
   * @returns {Promise<boolean>}
   */
  async exists(filepath) {
    let key = getKeyFromR2Url(filepath);
    if (!key) {
      key = filepath.startsWith('gallery/') ? filepath : `gallery/${path.basename(filepath)}`;
    }

    return await existsInR2(key);
  },

  /**
   * Get full URL for a key
   * @param {string} key - Object key
   * @returns {string}
   */
  getUrl(key) {
    // If already a full URL, return as-is
    if (key.startsWith('http')) return key;
    return getR2Url(key);
  },

  /**
   * Clean up temporary uploads (same as local - uploads are always local first)
   * @param {number} maxAgeMs - Max age in milliseconds
   */
  async cleanupUploads(maxAgeMs = 3600000) {
    if (!fs.existsSync(UPLOADS_DIR)) return;

    const files = await fs.promises.readdir(UPLOADS_DIR);
    const now = Date.now();

    for (const file of files) {
      if (file === '.gitkeep') continue;

      const filePath = path.join(UPLOADS_DIR, file);
      const stats = await fs.promises.stat(filePath);

      if (now - stats.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(filePath);
      }
    }
  },

  /**
   * Storage type identifier
   */
  type: 'r2'
};

/**
 * Railway Buckets Storage Implementation
 * Uses S3-compatible API with presigned URLs for direct browser access.
 * Generates responsive WebP variants for images.
 */
export const railwayStorage = {
  /**
   * Process and upload image to Railway Buckets
   * Generates sm, md, lg WebP variants
   * @param {string} uploadPath - Path to uploaded file
   * @param {string} filename - Original filename
   * @param {Object} options - Processing options
   * @returns {Promise<Object>} Keys and metadata for database storage
   */
  async saveImage(uploadPath, filename, options = {}) {
    return processImageForRailway(uploadPath, filename);
  },

  /**
   * Process and upload video to Railway Buckets
   * @param {string} uploadPath - Path to uploaded video
   * @param {string} filename - Original filename
   * @param {Object} thumbFile - Optional thumbnail file
   * @returns {Promise<Object>} Keys and metadata for database storage
   */
  async saveVideo(uploadPath, filename, thumbFile = null) {
    return processVideoForRailway(uploadPath, filename, thumbFile);
  },

  /**
   * Legacy save method for backward compatibility
   * Routes to appropriate processor based on file type
   * @param {string} uploadPath - Path to uploaded file
   * @param {string} filename - Original filename
   * @param {Object} options - Processing options
   * @returns {Promise<Object>} Keys and metadata
   */
  async save(uploadPath, filename, options = {}) {
    const ext = path.extname(filename).toLowerCase();
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const videoExts = ['.mp4', '.webm', '.mov'];

    if (imageExts.includes(ext)) {
      return this.saveImage(uploadPath, filename, options);
    } else if (videoExts.includes(ext)) {
      return this.saveVideo(uploadPath, filename, options.thumbFile);
    } else {
      throw new Error(`Unsupported file type: ${ext}`);
    }
  },

  /**
   * Generate presigned URLs for image variant keys
   * @param {Object} keys - Object with key_sm, key_md, key_lg
   * @returns {Promise<Object>} Presigned URLs
   */
  async getImageUrls(keys) {
    const urls = {};

    if (keys.key_sm) {
      urls.url_sm = await getPresignedUrl(keys.key_sm);
    }
    if (keys.key_md) {
      urls.url_md = await getPresignedUrl(keys.key_md);
    }
    if (keys.key_lg) {
      urls.url_lg = await getPresignedUrl(keys.key_lg);
    }

    return urls;
  },

  /**
   * Generate presigned URL for video key
   * @param {string} videoKey - Video object key
   * @param {Object} thumbnailKeys - Optional thumbnail variant keys
   * @returns {Promise<Object>} Presigned URLs for video and thumbnails
   */
  async getVideoUrls(videoKey, thumbnailKeys = null) {
    const urls = {};

    if (videoKey) {
      urls.videoUrl = await getPresignedUrl(videoKey);
    }

    if (thumbnailKeys) {
      if (thumbnailKeys.key_sm) {
        urls.thumbnail_sm = await getPresignedUrl(thumbnailKeys.key_sm);
      }
      if (thumbnailKeys.key_md) {
        urls.thumbnail_md = await getPresignedUrl(thumbnailKeys.key_md);
      }
      if (thumbnailKeys.key_lg) {
        urls.thumbnail_lg = await getPresignedUrl(thumbnailKeys.key_lg);
      }
    }

    return urls;
  },

  /**
   * Delete files from Railway Buckets
   * @param {Object} keys - Image keys or video key
   * @param {Object} thumbnailKeys - Optional thumbnail keys
   * @returns {Promise<Object>} Deletion results
   */
  async delete(keys, thumbnailKeys = null) {
    return deleteRailwayFiles(keys, thumbnailKeys);
  },

  /**
   * Clean up temporary uploads (same as local)
   * @param {number} maxAgeMs - Max age in milliseconds
   */
  async cleanupUploads(maxAgeMs = 3600000) {
    if (!fs.existsSync(UPLOADS_DIR)) return;

    const files = await fs.promises.readdir(UPLOADS_DIR);
    const now = Date.now();

    for (const file of files) {
      if (file === '.gitkeep') continue;

      const filePath = path.join(UPLOADS_DIR, file);
      const stats = await fs.promises.stat(filePath);

      if (now - stats.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(filePath);
      }
    }
  },

  /**
   * Storage type identifier
   */
  type: 'railway'
};

/**
 * Storage Factory
 * Switch between local, R2, and Railway storage based on STORAGE_TYPE environment variable
 */
export function getStorage() {
  if (process.env.STORAGE_TYPE === 'railway') {
    console.log('📦 Using Railway Buckets storage');
    return railwayStorage;
  }

  if (process.env.STORAGE_TYPE === 'r2') {
    console.log('📦 Using Cloudflare R2 storage');
    return r2Storage;
  }

  console.log('📦 Using local file storage');
  return localStorage;
}

// Export the active storage (lazy - determined at first use)
let _storage = null;
export const storage = new Proxy({}, {
  get(target, prop) {
    if (!_storage) {
      _storage = getStorage();
    }
    return _storage[prop];
  }
});

export default storage;
