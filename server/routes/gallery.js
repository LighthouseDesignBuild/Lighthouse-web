import { Router } from 'express';
import GalleryItem from '../models/GalleryItem.js';
import { isEditor } from '../middleware/auth.js';
import upload, { getFileType, handleUploadError, GALLERY_DIR } from '../middleware/upload.js';
import {
  processImage,
  processVideo,
  deleteProcessedFiles,
  detectEmbedPlatform,
  getEmbedThumbnail,
  processImageForRailway,
  processVideoForRailway,
  deleteRailwayFiles,
} from '../utils/imageProcessor.js';
import { getStorage, railwayStorage } from '../services/storage.js';
import { isRailwayStorageEnabled } from '../config/railway.js';

const router = Router();

// Valid gallery categories
const GALLERY_CATEGORIES = ['kitchen', 'bathroom', 'outdoor', 'additions'];

/**
 * GET /api/gallery
 * List all gallery items (public)
 * Returns presigned URLs for Railway storage items
 * Optional query param: ?category=kitchen to filter by category
 */
router.get('/', async (req, res) => {
  try {
    const { category } = req.query;

    // Get items - optionally filtered by category
    let items;
    if (category && GALLERY_CATEGORIES.includes(category)) {
      items = await GalleryItem.findByCategory(category);
    } else {
      items = await GalleryItem.findAll();
    }

    // Process items and generate presigned URLs for Railway items
    const enrichedItems = await Promise.all(items.map(async (item) => {
      const baseItem = {
        id: item.id,
        type: item.type,
        filename: item.filename,
        embedUrl: item.embed_url,
        embedPlatform: item.embed_platform,
        sizeClass: item.size_class,
        displayOrder: item.display_order,
        createdAt: item.created_at,
        category: item.category, // Include category in response
      };

      // Check if this is a Railway storage item (has variant keys)
      if (GalleryItem.isRailwayItem(item)) {
        if (item.type === 'image') {
          // Image with variant keys
          const urls = await railwayStorage.getImageUrls({
            key_sm: item.key_sm,
            key_md: item.key_md,
            key_lg: item.key_lg,
          });
          return {
            ...baseItem,
            url_sm: urls.url_sm,
            url_md: urls.url_md,
            url_lg: urls.url_lg,
            thumbnail: urls.url_sm, // Use small variant as thumbnail
            blurData: item.blur_data, // Base64 blur placeholder for instant loading
          };
        } else if (item.type === 'video') {
          // Video with video key and optional thumbnail keys
          const videoUrls = await railwayStorage.getVideoUrls(item.video_key, {
            key_sm: item.thumb_key_sm,
            key_md: item.thumb_key_md,
            key_lg: item.thumb_key_lg,
          });
          return {
            ...baseItem,
            videoUrl: videoUrls.videoUrl,
            thumbnail_sm: videoUrls.thumbnail_sm,
            thumbnail_md: videoUrls.thumbnail_md,
            thumbnail_lg: videoUrls.thumbnail_lg,
            thumbnail: videoUrls.thumbnail_sm || videoUrls.thumbnail_md,
            blurData: item.blur_data, // Base64 blur placeholder for instant loading
          };
        }
      }

      // Legacy item (local/R2 storage) or embed
      return {
        ...baseItem,
        filepath: item.filepath,
        thumbnail: item.thumbnail,
      };
    }));

    res.json({
      items: enrichedItems,
      total: items.length
    });
  } catch (err) {
    console.error('List gallery error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to load gallery'
    });
  }
});

/**
 * POST /api/gallery
 * Upload new item(s) - supports batch upload with video thumbnails
 * Uses Railway Buckets storage when enabled (STORAGE_TYPE=railway)
 */
router.post('/', isEditor, upload.fields([
  { name: 'files', maxCount: 20 },
  { name: 'thumbnails', maxCount: 20 }
]), handleUploadError, async (req, res) => {
  try {
    const files = req.files?.files || [];
    const thumbnails = req.files?.thumbnails || [];

    if (files.length === 0) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'No files uploaded'
      });
    }

    const sizeClass = req.body.sizeClass || 'medium';
    const category = req.body.category || null;
    const useRailway = isRailwayStorageEnabled();

    // Validate category if provided
    if (category && !GALLERY_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: 'ValidationError',
        message: `Invalid category. Must be one of: ${GALLERY_CATEGORIES.join(', ')}`
      });
    }

    // Parse thumbnail indices (which files have thumbnails)
    let thumbnailIndices = [];
    if (req.body.thumbnailIndices) {
      thumbnailIndices = Array.isArray(req.body.thumbnailIndices)
        ? req.body.thumbnailIndices.map(i => parseInt(i))
        : [parseInt(req.body.thumbnailIndices)];
    }

    // Create a map of file index to thumbnail file
    const thumbnailMap = new Map();
    thumbnailIndices.forEach((fileIndex, thumbIndex) => {
      if (thumbnails[thumbIndex]) {
        thumbnailMap.set(fileIndex, thumbnails[thumbIndex]);
      }
    });

    const results = [];
    const errors = [];

    // Process each file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const fileType = getFileType(file.mimetype);

        let item;

        if (useRailway) {
          // Railway Buckets storage with WebP variants
          if (fileType === 'image') {
            const processed = await processImageForRailway(file.path, file.filename);
            item = await GalleryItem.create({
              type: fileType,
              filename: file.originalname, // Use original filename for display
              keys: processed.keys,
              contentHash: processed.contentHash,
              blurData: processed.blurData, // Base64 blur placeholder
              sizeClass,
              category,
              uploadedBy: req.session.userId,
            });

            if (!item) {
              throw new Error('Database returned null after insert - check server logs for details');
            }

            // Get presigned URLs for response
            const urls = await railwayStorage.getImageUrls(processed.keys);
            results.push({
              id: item.id,
              type: item.type,
              url_sm: urls.url_sm,
              url_md: urls.url_md,
              url_lg: urls.url_lg,
              thumbnail: urls.url_sm,
              blurData: processed.blurData,
              sizeClass: item.size_class,
              originalName: file.originalname,
            });
          } else if (fileType === 'video') {
            const thumbFile = thumbnailMap.get(i);
            const processed = await processVideoForRailway(file.path, file.filename, thumbFile);
            item = await GalleryItem.create({
              type: fileType,
              filename: file.originalname, // Use original filename for display
              videoKey: processed.videoKey,
              thumbnailKeys: processed.thumbnailKeys,
              contentHash: processed.contentHash,
              blurData: processed.blurData, // Base64 blur placeholder for video thumbnail
              sizeClass,
              category,
              uploadedBy: req.session.userId,
            });

            if (!item) {
              throw new Error('Database returned null after video insert - check server logs for details');
            }

            // Get presigned URLs for response
            const urls = await railwayStorage.getVideoUrls(processed.videoKey, processed.thumbnailKeys);
            results.push({
              id: item.id,
              type: item.type,
              videoUrl: urls.videoUrl,
              thumbnail: urls.thumbnail_sm || urls.thumbnail_md,
              blurData: processed.blurData,
              sizeClass: item.size_class,
              originalName: file.originalname,
            });
          } else {
            errors.push({ file: file.originalname, error: 'Unsupported file type' });
            continue;
          }
        } else {
          // Legacy local/R2 storage
          let processed;
          if (fileType === 'image') {
            processed = await processImage(file.path, file.filename);
          } else if (fileType === 'video') {
            const thumbFile = thumbnailMap.get(i);
            processed = await processVideo(file.path, file.filename, thumbFile);
          } else {
            errors.push({ file: file.originalname, error: 'Unsupported file type' });
            continue;
          }

          item = await GalleryItem.create({
            type: fileType,
            filename: file.originalname, // Use original filename for display
            filepath: processed.filepath,
            thumbnail: processed.thumbnail,
            sizeClass,
            category,
            uploadedBy: req.session.userId,
          });

          results.push({
            id: item.id,
            type: item.type,
            filepath: item.filepath,
            thumbnail: item.thumbnail,
            sizeClass: item.size_class,
            originalName: file.originalname,
          });
        }
      } catch (err) {
        console.error(`Error processing ${file.originalname}:`, err);
        errors.push({ file: file.originalname, error: err.message });
      }
    }

    // Return appropriate status based on results
    if (results.length === 0 && errors.length > 0) {
      // All uploads failed
      return res.status(500).json({
        success: false,
        uploaded: [],
        errors: errors,
        message: 'All uploads failed'
      });
    }

    if (errors.length > 0) {
      // Partial success (some succeeded, some failed)
      return res.status(207).json({
        success: true,
        uploaded: results,
        errors: errors,
        total: results.length,
        message: `${results.length} uploaded, ${errors.length} failed`
      });
    }

    // All succeeded
    res.status(201).json({
      success: true,
      uploaded: results,
      total: results.length
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to process upload'
    });
  }
});

/**
 * POST /api/gallery/embed
 * Add YouTube/Vimeo embed
 */
router.post('/embed', isEditor, async (req, res) => {
  try {
    const { url, sizeClass = 'medium', category = null } = req.body;

    if (!url) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'URL is required'
      });
    }

    // Validate category if provided
    if (category && !GALLERY_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: 'ValidationError',
        message: `Invalid category. Must be one of: ${GALLERY_CATEGORIES.join(', ')}`
      });
    }

    // Detect platform
    const platform = detectEmbedPlatform(url);
    if (!platform) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid URL. Only YouTube and Vimeo URLs are supported'
      });
    }

    // Get thumbnail
    const thumbnail = getEmbedThumbnail(url, platform);

    // Save to database
    const item = await GalleryItem.createEmbed({
      embedUrl: url,
      embedPlatform: platform,
      thumbnail,
      sizeClass,
      category,
      uploadedBy: req.session.userId
    });

    res.status(201).json({
      success: true,
      item: {
        id: item.id,
        type: item.type,
        embedUrl: item.embed_url,
        embedPlatform: item.embed_platform,
        thumbnail: item.thumbnail,
        sizeClass: item.size_class,
        category: item.category
      }
    });
  } catch (err) {
    console.error('Add embed error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to add embed'
    });
  }
});

/**
 * GET /api/gallery/:id
 * Get single item
 */
router.get('/:id', async (req, res) => {
  try {
    const item = await GalleryItem.findById(parseInt(req.params.id));

    if (!item) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Gallery item not found'
      });
    }

    res.json({
      item: {
        id: item.id,
        type: item.type,
        filepath: item.filepath,
        embedUrl: item.embed_url,
        embedPlatform: item.embed_platform,
        thumbnail: item.thumbnail,
        sizeClass: item.size_class,
        displayOrder: item.display_order,
        createdAt: item.created_at,
        updatedAt: item.updated_at
      }
    });
  } catch (err) {
    console.error('Get item error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to get item'
    });
  }
});

/**
 * PUT /api/gallery/:id
 * Update item (size class, order, category)
 */
router.put('/:id', isEditor, async (req, res) => {
  try {
    const itemId = parseInt(req.params.id);
    const { sizeClass, displayOrder, category } = req.body;

    const existing = await GalleryItem.findById(itemId);
    if (!existing) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Gallery item not found'
      });
    }

    // Validate size class
    if (sizeClass && !['small', 'medium', 'large', 'tall', 'wide'].includes(sizeClass)) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid size class'
      });
    }

    // Validate category
    if (category && !GALLERY_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: 'ValidationError',
        message: `Invalid category. Must be one of: ${GALLERY_CATEGORIES.join(', ')}`
      });
    }

    const item = await GalleryItem.update(itemId, { sizeClass, displayOrder, category });

    res.json({
      success: true,
      item: {
        id: item.id,
        type: item.type,
        filepath: item.filepath,
        embedUrl: item.embed_url,
        thumbnail: item.thumbnail,
        sizeClass: item.size_class,
        displayOrder: item.display_order,
        category: item.category
      }
    });
  } catch (err) {
    console.error('Update item error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to update item'
    });
  }
});

/**
 * DELETE /api/gallery/:id
 * Delete item and associated files (Railway or local/R2)
 */
router.delete('/:id', isEditor, async (req, res) => {
  try {
    const itemId = parseInt(req.params.id);

    const item = await GalleryItem.findById(itemId);
    if (!item) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Gallery item not found'
      });
    }

    // Delete files based on storage type
    if (item.type !== 'embed') {
      try {
        if (GalleryItem.isRailwayItem(item)) {
          // Railway storage - delete variant keys
          if (item.type === 'image') {
            await deleteRailwayFiles({
              key_sm: item.key_sm,
              key_md: item.key_md,
              key_lg: item.key_lg,
            });
          } else if (item.type === 'video') {
            await deleteRailwayFiles(
              { videoKey: item.video_key },
              {
                key_sm: item.thumb_key_sm,
                key_md: item.thumb_key_md,
                key_lg: item.thumb_key_lg,
              }
            );
          }
        } else if (item.filepath) {
          // Legacy local/R2 storage
          await deleteProcessedFiles(item.filepath, item.thumbnail);
        }
      } catch (fileErr) {
        console.warn('Warning: Could not delete files:', fileErr.message);
      }
    }

    // Delete from database
    await GalleryItem.delete(itemId);

    res.json({
      success: true,
      message: 'Item deleted successfully'
    });
  } catch (err) {
    console.error('Delete item error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to delete item'
    });
  }
});

/**
 * POST /api/gallery/reorder
 * Bulk reorder items
 */
router.post('/reorder', isEditor, async (req, res) => {
  try {
    const { orderedIds } = req.body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'orderedIds must be a non-empty array'
      });
    }

    const items = await GalleryItem.reorder(orderedIds);

    res.json({
      success: true,
      items: items.map(item => ({
        id: item.id,
        displayOrder: item.display_order
      }))
    });
  } catch (err) {
    console.error('Reorder error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to reorder items'
    });
  }
});

/**
 * GET /api/gallery/categories
 * Get list of categories with counts
 */
router.get('/categories', async (req, res) => {
  try {
    const categories = await GalleryItem.getCategories();

    // Always return all valid categories with their counts (0 if no items)
    const categoryCounts = GALLERY_CATEGORIES.map(cat => {
      const found = categories.find(c => c.category === cat);
      return {
        id: cat,
        name: cat === 'kitchen' ? 'Kitchen Remodeling' :
              cat === 'bathroom' ? 'Bathroom Remodeling' :
              cat === 'outdoor' ? 'Outdoor Living' :
              cat === 'additions' ? 'Home Additions' : cat,
        count: found ? found.count : 0
      };
    });

    res.json({
      categories: categoryCounts,
      total: categoryCounts.reduce((sum, c) => sum + c.count, 0)
    });
  } catch (err) {
    console.error('Categories error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to get categories'
    });
  }
});

/**
 * GET /api/gallery/stats
 * Get gallery statistics
 */
router.get('/stats/summary', isEditor, async (req, res) => {
  try {
    const total = await GalleryItem.count();
    const images = (await GalleryItem.findByType('image')).length;
    const videos = (await GalleryItem.findByType('video')).length;
    const embeds = (await GalleryItem.findByType('embed')).length;

    res.json({
      total,
      images,
      videos,
      embeds
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to get stats'
    });
  }
});

export default router;
