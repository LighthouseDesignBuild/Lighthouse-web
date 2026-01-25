/**
 * Public Blog API Routes
 *
 * GET /api/blog - List published posts (paginated)
 * GET /api/blog/:slug - Get single published post
 * GET /api/blog/:slug/comments - Get approved comments for a post
 * POST /api/blog/:slug/comments - Submit a new comment
 */

import { Router } from 'express';
import BlogPost, { CATEGORIES } from '../models/BlogPost.js';
import Comment from '../models/Comment.js';
import { getPresignedUrl } from '../services/railwayClient.js';
import { isRailwayStorageEnabled } from '../config/railway.js';

const router = Router();

/**
 * Generate presigned URL for featured image if using Railway storage
 */
async function getFeaturedImageUrl(imageKey) {
  if (!imageKey) return null;

  if (isRailwayStorageEnabled()) {
    try {
      return await getPresignedUrl(imageKey);
    } catch (error) {
      console.error('Failed to get presigned URL for featured image:', error);
      return null;
    }
  }

  // Local storage - return as-is
  return imageKey;
}

/**
 * Flatten block data structure for frontend consumption
 * Converts { type: "paragraph", data: { text: "..." } }
 * to { type: "paragraph", text: "..." }
 */
function flattenBlockData(block) {
  if (!block || !block.data) return block;

  const flattened = { type: block.type };

  // Copy all data properties to top level
  for (const [key, value] of Object.entries(block.data)) {
    flattened[key] = value;
  }

  return flattened;
}

/**
 * Process content blocks - flatten structure and convert image keys to URLs
 */
async function processContentBlocks(content) {
  if (!Array.isArray(content)) return [];

  const processedBlocks = [];

  for (const block of content) {
    const flattened = flattenBlockData(block);

    // Convert image block key to URL
    if (flattened.type === 'image' && flattened.key) {
      flattened.url = await getFeaturedImageUrl(flattened.key);
    }

    // Convert image-gallery block keys to URLs
    if (flattened.type === 'image-gallery' && Array.isArray(flattened.images)) {
      flattened.images = await Promise.all(
        flattened.images.map(async (img) => ({
          ...img,
          url: img.key ? await getFeaturedImageUrl(img.key) : img.url,
        }))
      );
    }

    // Convert video block to embedUrl format and rename type for frontend
    if (flattened.type === 'video' && flattened.platform && flattened.videoId) {
      flattened.type = 'video-embed'; // Frontend expects 'video-embed'
      if (flattened.platform === 'youtube') {
        flattened.embedUrl = `https://www.youtube.com/embed/${flattened.videoId}`;
      } else if (flattened.platform === 'vimeo') {
        flattened.embedUrl = `https://player.vimeo.com/video/${flattened.videoId}`;
      }
    }

    // Convert list block style to ordered boolean for frontend
    if (flattened.type === 'list') {
      flattened.ordered = flattened.style === 'ordered';
    }

    processedBlocks.push(flattened);
  }

  return processedBlocks;
}

/**
 * Enrich post with image URLs and process content blocks
 */
async function enrichPostWithUrls(post, includeContent = false) {
  if (!post) return null;

  const enriched = { ...post };
  enriched.featuredImageUrl = await getFeaturedImageUrl(post.featured_image_key);
  enriched.categoryName = CATEGORIES[post.category] || post.category;

  // Process content blocks if requested (for single post view)
  if (includeContent && post.content) {
    enriched.content = await processContentBlocks(post.content);
  }

  return enriched;
}

/**
 * GET /api/blog
 * List published posts with pagination
 * Query params: limit (default 12), offset (default 0)
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 12, 50);
    const offset = parseInt(req.query.offset) || 0;

    const { posts, total, hasMore } = await BlogPost.findPublished(limit, offset);

    // Enrich posts with image URLs
    const enrichedPosts = await Promise.all(
      posts.map(async (post) => {
        const enriched = await enrichPostWithUrls(post);
        // Don't send full content in list view
        delete enriched.content;
        return enriched;
      })
    );

    res.json({
      success: true,
      posts: enrichedPosts,
      total,
      hasMore,
      limit,
      offset,
    });
  } catch (error) {
    console.error('List blog posts error:', error);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to load blog posts',
    });
  }
});

/**
 * GET /api/blog/categories
 * Get available categories
 */
router.get('/categories', (req, res) => {
  res.json({
    success: true,
    categories: Object.entries(CATEGORIES).map(([slug, name]) => ({ slug, name })),
  });
});

/**
 * GET /api/blog/:slug
 * Get single published post by slug
 */
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const post = await BlogPost.findBySlug(slug);
    if (!post) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Blog post not found',
      });
    }

    // Enrich with image URLs and process content blocks
    const enrichedPost = await enrichPostWithUrls(post, true);

    // Get comment count
    const commentCount = await Comment.countByPostId(post.id);
    enrichedPost.commentCount = commentCount;

    res.json({
      success: true,
      post: enrichedPost,
    });
  } catch (error) {
    console.error('Get blog post error:', error);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to load blog post',
    });
  }
});

/**
 * GET /api/blog/:slug/comments
 * Get approved comments for a post
 */
router.get('/:slug/comments', async (req, res) => {
  try {
    const { slug } = req.params;

    // Verify post exists
    const post = await BlogPost.findBySlug(slug);
    if (!post) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Blog post not found',
      });
    }

    const comments = await Comment.findByPostSlug(slug);

    res.json({
      success: true,
      comments,
      count: comments.length,
    });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to load comments',
    });
  }
});

/**
 * POST /api/blog/:slug/comments
 * Submit a new comment (goes to pending status)
 */
router.post('/:slug/comments', async (req, res) => {
  try {
    const { slug } = req.params;
    const { firstName, lastName, email, website, comment, honeypot } = req.body;

    // Honeypot spam check - if filled, it's a bot
    if (honeypot) {
      // Silently accept but don't save
      return res.json({
        success: true,
        message: 'Comment submitted for review',
      });
    }

    // Verify post exists and is published
    const post = await BlogPost.findBySlug(slug);
    if (!post) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Blog post not found',
      });
    }

    // Create comment (model handles validation)
    const newComment = await Comment.create({
      postId: post.id,
      firstName,
      lastName,
      email,
      website,
      comment,
    });

    res.status(201).json({
      success: true,
      message: 'Comment submitted for review. It will appear after approval.',
      commentId: newComment.id,
    });
  } catch (error) {
    console.error('Submit comment error:', error);

    // Handle validation errors
    if (error.message.includes('required') ||
        error.message.includes('must be') ||
        error.message.includes('Too many')) {
      return res.status(400).json({
        error: 'ValidationError',
        message: error.message,
      });
    }

    res.status(500).json({
      error: 'ServerError',
      message: 'Failed to submit comment',
    });
  }
});

export default router;
