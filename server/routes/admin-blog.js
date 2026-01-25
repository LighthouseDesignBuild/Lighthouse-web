/**
 * Admin Blog API Routes
 *
 * Comment Moderation (MUST come before /:id routes to avoid shadowing):
 * GET    /api/admin/blog/comments           - List all comments
 * PUT    /api/admin/blog/comments/:id/approve - Approve comment
 * PUT    /api/admin/blog/comments/:id/reject  - Reject comment
 * DELETE /api/admin/blog/comments/:id        - Delete comment
 * POST   /api/admin/blog/comments/bulk       - Bulk actions
 *
 * Blog Management:
 * GET    /api/admin/blog           - List all posts (drafts + published)
 * GET    /api/admin/blog/:id       - Get single post by ID
 * POST   /api/admin/blog           - Create new post
 * PUT    /api/admin/blog/:id       - Update post
 * DELETE /api/admin/blog/:id       - Delete post
 * POST   /api/admin/blog/upload    - Upload image for blog post
 *
 * Backup:
 * GET    /api/admin/blog/backup/status   - Get backup status
 * POST   /api/admin/blog/backup          - Trigger manual backup
 * POST   /api/admin/blog/backup/restore  - Restore from backup
 */

import { Router } from 'express';
import BlogPost, { CATEGORIES } from '../models/BlogPost.js';
import Comment from '../models/Comment.js';
import { isEditor, isAdmin } from '../middleware/auth.js';
import upload, { getFileType, handleUploadError } from '../middleware/upload.js';
import { backupDatabase, restoreDatabase, getBackupStatus } from '../utils/backup.js';
import { getPresignedUrl, uploadToRailway } from '../services/railwayClient.js';
import { isRailwayStorageEnabled } from '../config/railway.js';
import fs from 'fs';
import path from 'path';

const router = Router();

// All admin routes require at least editor access
router.use(isEditor);

// ============================================
// BLOG POST MANAGEMENT
// ============================================

/**
 * GET /api/admin/blog
 * List all posts (drafts + published)
 */
router.get('/', async (req, res) => {
  try {
    const posts = await BlogPost.findAll();
    const counts = await BlogPost.countByStatus();

    // Add category names
    const enrichedPosts = posts.map(post => ({
      ...post,
      categoryName: CATEGORIES[post.category] || post.category,
    }));

    res.json({
      success: true,
      posts: enrichedPosts,
      counts,
    });
  } catch (error) {
    console.error('Admin list posts error:', error);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to load posts',
    });
  }
});

/**
 * GET /api/admin/blog/categories
 * Get available categories
 */
router.get('/categories', (req, res) => {
  res.json({
    success: true,
    categories: Object.entries(CATEGORIES).map(([slug, name]) => ({ slug, name })),
  });
});

// ============================================
// COMMENT MODERATION
// These routes MUST be defined BEFORE the /:id route
// to avoid being shadowed by the parameterized route
// ============================================

/**
 * GET /api/admin/blog/comments
 * List all comments with optional status filter
 */
router.get('/comments', async (req, res) => {
  try {
    const { status } = req.query;
    const comments = await Comment.findAll(status || null);
    const counts = await Comment.countByStatus();

    res.json({
      success: true,
      comments,
      counts,
    });
  } catch (error) {
    console.error('Admin list comments error:', error);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to load comments',
    });
  }
});

/**
 * PUT /api/admin/blog/comments/:id/approve
 * Approve a comment
 */
router.put('/comments/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const comment = await Comment.approve(parseInt(id));

    res.json({
      success: true,
      comment,
      message: 'Comment approved',
    });
  } catch (error) {
    console.error('Approve comment error:', error);

    if (error.message === 'Comment not found') {
      return res.status(404).json({
        error: 'NotFound',
        message: error.message,
      });
    }

    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to approve comment',
    });
  }
});

/**
 * PUT /api/admin/blog/comments/:id/reject
 * Reject a comment
 */
router.put('/comments/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const comment = await Comment.reject(parseInt(id));

    res.json({
      success: true,
      comment,
      message: 'Comment rejected',
    });
  } catch (error) {
    console.error('Reject comment error:', error);

    if (error.message === 'Comment not found') {
      return res.status(404).json({
        error: 'NotFound',
        message: error.message,
      });
    }

    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to reject comment',
    });
  }
});

/**
 * DELETE /api/admin/blog/comments/:id
 * Delete a comment
 */
router.delete('/comments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await Comment.delete(parseInt(id));

    res.json({
      success: true,
      message: 'Comment deleted',
    });
  } catch (error) {
    console.error('Delete comment error:', error);

    if (error.message === 'Comment not found') {
      return res.status(404).json({
        error: 'NotFound',
        message: error.message,
      });
    }

    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to delete comment',
    });
  }
});

/**
 * POST /api/admin/blog/comments/bulk
 * Bulk actions on comments
 */
router.post('/comments/bulk', async (req, res) => {
  try {
    const { action, ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'No comments selected',
      });
    }

    let result;
    switch (action) {
      case 'approve':
        result = await Comment.bulkApprove(ids);
        break;
      case 'reject':
        result = await Comment.bulkReject(ids);
        break;
      case 'delete':
        result = await Comment.bulkDelete(ids);
        break;
      default:
        return res.status(400).json({
          error: 'ValidationError',
          message: 'Invalid action',
        });
    }

    res.json({
      success: true,
      result,
      message: `${action} completed for ${ids.length} comment(s)`,
    });
  } catch (error) {
    console.error('Bulk comment action error:', error);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to perform bulk action',
    });
  }
});

// ============================================
// BLOG POST MANAGEMENT (Parameterized routes)
// These come AFTER specific routes like /comments
// ============================================

/**
 * GET /api/admin/blog/:id
 * Get single post by ID (for editing)
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const post = await BlogPost.findById(parseInt(id));

    if (!post) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Post not found',
      });
    }

    // Get featured image URL if exists
    let featuredImageUrl = null;
    if (post.featured_image_key) {
      if (isRailwayStorageEnabled()) {
        try {
          featuredImageUrl = await getPresignedUrl(post.featured_image_key);
        } catch (e) {
          console.error('Failed to get featured image URL:', e);
        }
      } else {
        // Local storage - return key as-is (it's already a path)
        featuredImageUrl = post.featured_image_key;
      }
    }

    // Enrich content blocks with preview URLs for images
    if (Array.isArray(post.content)) {
      for (const block of post.content) {
        if (block.type === 'image' && block.data?.key) {
          if (isRailwayStorageEnabled()) {
            try {
              block.data.previewUrl = await getPresignedUrl(block.data.key);
            } catch (e) {
              console.error('Failed to get image preview URL:', e);
            }
          } else {
            // Local storage - return key as-is
            block.data.previewUrl = block.data.key;
          }
        }
      }
    }

    res.json({
      success: true,
      post: {
        ...post,
        featuredImageUrl,
        categoryName: CATEGORIES[post.category] || post.category,
      },
    });
  } catch (error) {
    console.error('Admin get post error:', error);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to load post',
    });
  }
});

/**
 * POST /api/admin/blog
 * Create new post
 */
router.post('/', async (req, res) => {
  try {
    const {
      title,
      slug,
      category,
      content,
      featuredImageKey,
      featuredImageAlt,
      metaTitle,
      metaDescription,
      canonicalUrl,
      status,
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Title is required',
      });
    }

    if (!category) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Category is required',
      });
    }

    const post = await BlogPost.create({
      title: title.trim(),
      slug: slug?.trim(),
      category,
      content: content || [],
      featuredImageKey,
      featuredImageAlt,
      metaTitle,
      metaDescription,
      canonicalUrl,
      status: status || 'draft',
      authorId: req.session.userId,
      authorName: req.session.username,
    });

    // Trigger backup after create
    backupDatabase().catch(err => console.error('Backup after create failed:', err));

    res.status(201).json({
      success: true,
      post,
      message: status === 'published' ? 'Post published successfully' : 'Draft saved',
    });
  } catch (error) {
    console.error('Create post error:', error);

    if (error.message.includes('Invalid category')) {
      return res.status(400).json({
        error: 'ValidationError',
        message: error.message,
      });
    }

    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to create post',
    });
  }
});

/**
 * PUT /api/admin/blog/:id
 * Update post
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      slug,
      category,
      content,
      featuredImageKey,
      featuredImageAlt,
      metaTitle,
      metaDescription,
      canonicalUrl,
      status,
    } = req.body;

    const post = await BlogPost.update(parseInt(id), {
      title,
      slug,
      category,
      content,
      featuredImageKey,
      featuredImageAlt,
      metaTitle,
      metaDescription,
      canonicalUrl,
      status,
    });

    // Trigger backup after update
    backupDatabase().catch(err => console.error('Backup after update failed:', err));

    res.json({
      success: true,
      post,
      message: 'Post updated successfully',
    });
  } catch (error) {
    console.error('Update post error:', error);

    if (error.message === 'Post not found') {
      return res.status(404).json({
        error: 'NotFound',
        message: error.message,
      });
    }

    if (error.message.includes('Invalid category')) {
      return res.status(400).json({
        error: 'ValidationError',
        message: error.message,
      });
    }

    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to update post',
    });
  }
});

/**
 * DELETE /api/admin/blog/:id
 * Delete post
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await BlogPost.delete(parseInt(id));

    // Trigger backup after delete
    backupDatabase().catch(err => console.error('Backup after delete failed:', err));

    res.json({
      success: true,
      message: 'Post deleted successfully',
    });
  } catch (error) {
    console.error('Delete post error:', error);

    if (error.message === 'Post not found') {
      return res.status(404).json({
        error: 'NotFound',
        message: error.message,
      });
    }

    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to delete post',
    });
  }
});

/**
 * POST /api/admin/blog/upload
 * Upload image for blog post
 * Returns the storage key to be saved in post content
 */
router.post('/upload', upload.single('image'), handleUploadError, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'No image file provided',
      });
    }

    const fileType = getFileType(req.file.mimetype);
    if (fileType !== 'image') {
      // Clean up uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: 'ValidationError',
        message: 'Only image files are allowed',
      });
    }

    if (isRailwayStorageEnabled()) {
      // Process and upload to Railway bucket with blog prefix
      const result = await processBlogImage(req.file.path, req.file.originalname);

      // Get presigned URL for preview
      const previewUrl = await getPresignedUrl(result.key);

      res.json({
        success: true,
        key: result.key,
        previewUrl,
      });
    } else {
      // Local storage fallback
      const filename = req.file.filename;
      const filepath = `/uploads/${filename}`;

      res.json({
        success: true,
        key: filepath,
        previewUrl: filepath,
      });
    }
  } catch (error) {
    console.error('Upload image error:', error);

    // Clean up file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to upload image',
    });
  }
});

/**
 * Process and upload a blog image to Railway bucket
 * Creates a single optimized WebP image (no variants for simplicity)
 */
async function processBlogImage(inputPath, originalFilename) {
  const sharp = (await import('sharp')).default;
  const crypto = await import('crypto');

  // Read the original file
  const inputBuffer = await fs.promises.readFile(inputPath);

  // Generate content hash for cache busting
  const hash = crypto.createHash('md5').update(inputBuffer).digest('hex').substring(0, 8);

  // Create slug from filename
  const baseName = path.basename(originalFilename, path.extname(originalFilename));
  const slug = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  // Convert to WebP with reasonable quality
  const webpBuffer = await sharp(inputBuffer)
    .resize(1600, 1200, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();

  // Generate key with blog prefix
  const key = `blog/${slug}-${hash}.webp`;

  // Upload to Railway bucket
  await uploadToRailway(webpBuffer, key, 'image/webp');

  // Clean up local file
  await fs.promises.unlink(inputPath);

  return { key };
}

// ============================================
// BACKUP & RESTORE (Admin only)
// ============================================

/**
 * GET /api/admin/backup/status
 * Get backup status information
 */
router.get('/backup/status', isAdmin, async (req, res) => {
  try {
    const status = await getBackupStatus();
    res.json({
      success: true,
      status,
    });
  } catch (error) {
    console.error('Get backup status error:', error);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to get backup status',
    });
  }
});

/**
 * POST /api/admin/backup
 * Trigger manual backup
 */
router.post('/backup', isAdmin, async (req, res) => {
  try {
    const result = await backupDatabase();

    if (result.success) {
      res.json({
        success: true,
        message: 'Backup completed successfully',
        timestamp: result.timestamp,
        size: result.size,
      });
    } else {
      res.status(500).json({
        error: 'BackupError',
        message: result.message,
      });
    }
  } catch (error) {
    console.error('Manual backup error:', error);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to create backup',
    });
  }
});

/**
 * POST /api/admin/backup/restore
 * Restore from backup
 */
router.post('/backup/restore', isAdmin, async (req, res) => {
  try {
    const result = await restoreDatabase();

    if (result.success) {
      // Destroy session to force re-login after restore
      req.session.destroy();

      res.json({
        success: true,
        message: result.message,
        restoredSize: result.restoredSize,
      });
    } else {
      res.status(500).json({
        error: 'RestoreError',
        message: result.message,
      });
    }
  } catch (error) {
    console.error('Restore error:', error);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to restore from backup',
    });
  }
});

export default router;
