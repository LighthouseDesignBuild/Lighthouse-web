import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const GALLERY_DIR = path.join(__dirname, '../../src/assets/images/gallery');

// Detect Vercel serverless environment (read-only filesystem)
const isVercel = process.env.VERCEL === '1';

// Ensure directories exist (skip on Vercel - read-only filesystem)
if (!isVercel) {
  [UPLOADS_DIR, GALLERY_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// Allowed file types
const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const ALLOWED_TYPES = [...IMAGE_TYPES, ...VIDEO_TYPES];

// File size limits (in bytes)
const IMAGE_SIZE_LIMIT = 10 * 1024 * 1024;  // 10MB
const VIDEO_SIZE_LIMIT = 100 * 1024 * 1024; // 100MB

/**
 * Storage configuration - saves to uploads folder with UUID names
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${randomUUID()}${ext}`;
    cb(null, uniqueName);
  }
});

/**
 * File filter - validates file type
 */
const fileFilter = (req, file, cb) => {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type not allowed. Allowed types: ${ALLOWED_TYPES.join(', ')}`), false);
  }
};

/**
 * Dynamic file size limit based on type
 */
const limits = {
  fileSize: VIDEO_SIZE_LIMIT, // Use larger limit, validate per-file in route
  files: 20 // Max 20 files per request for batch upload
};

/**
 * Multer upload instance
 */
export const upload = multer({
  storage,
  fileFilter,
  limits
});

/**
 * Get file type (image or video)
 */
export function getFileType(mimetype) {
  if (IMAGE_TYPES.includes(mimetype)) return 'image';
  if (VIDEO_TYPES.includes(mimetype)) return 'video';
  return null;
}

/**
 * Validate individual file size based on type
 */
export function validateFileSize(file) {
  const type = getFileType(file.mimetype);
  const limit = type === 'video' ? VIDEO_SIZE_LIMIT : IMAGE_SIZE_LIMIT;

  if (file.size > limit) {
    const limitMB = limit / (1024 * 1024);
    throw new Error(`${type} file exceeds ${limitMB}MB limit`);
  }

  return true;
}

/**
 * Error handling middleware for multer errors
 */
export function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'FileTooLarge',
        message: 'File size exceeds the maximum allowed limit'
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: 'TooManyFiles',
        message: 'Maximum 20 files per upload'
      });
    }
    return res.status(400).json({
      error: 'UploadError',
      message: err.message
    });
  }

  if (err) {
    return res.status(400).json({
      error: 'UploadError',
      message: err.message
    });
  }

  next();
}

export { UPLOADS_DIR, GALLERY_DIR, IMAGE_TYPES, VIDEO_TYPES };
export default upload;
