import db from './database.js';

// Comment statuses
export const COMMENT_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

/**
 * Simple HTML escape for user input
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Validate email format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export const Comment = {
  /**
   * Find comment by ID
   */
  async findById(id) {
    return (await db.prepare('SELECT * FROM blog_comments WHERE id = ?')).get(id);
  },

  /**
   * Get all comments with optional status filter
   * @param {string|null} status - Filter by status (null for all)
   */
  async findAll(status = null) {
    if (status) {
      return (await db.prepare(`
        SELECT c.*, p.title as post_title, p.slug as post_slug
        FROM blog_comments c
        LEFT JOIN blog_posts p ON c.post_id = p.id
        WHERE c.status = ?
        ORDER BY c.created_at DESC
      `)).all(status);
    }

    return (await db.prepare(`
      SELECT c.*, p.title as post_title, p.slug as post_slug
      FROM blog_comments c
      LEFT JOIN blog_posts p ON c.post_id = p.id
      ORDER BY c.created_at DESC
    `)).all();
  },

  /**
   * Get approved comments for a post
   * @param {number} postId - Blog post ID
   */
  async findByPostId(postId) {
    return (await db.prepare(`
      SELECT id, first_name, last_name, website, comment, created_at
      FROM blog_comments
      WHERE post_id = ? AND status = 'approved'
      ORDER BY created_at ASC
    `)).all(postId);
  },

  /**
   * Get approved comments for a post by slug
   * @param {string} slug - Blog post slug
   */
  async findByPostSlug(slug) {
    return (await db.prepare(`
      SELECT c.id, c.first_name, c.last_name, c.website, c.comment, c.created_at
      FROM blog_comments c
      JOIN blog_posts p ON c.post_id = p.id
      WHERE p.slug = ? AND c.status = 'approved'
      ORDER BY c.created_at ASC
    `)).all(slug);
  },

  /**
   * Count comments for a post
   * @param {number} postId - Blog post ID
   */
  async countByPostId(postId) {
    const result = (await db.prepare(`
      SELECT COUNT(*) as count FROM blog_comments
      WHERE post_id = ? AND status = 'approved'
    `)).get(postId);
    return result?.count || 0;
  },

  /**
   * Create new comment
   */
  async create({ postId, firstName, lastName, email, website, comment }) {
    // Validate required fields
    if (!firstName || firstName.trim().length < 2) {
      throw new Error('First name must be at least 2 characters');
    }
    if (!email || !isValidEmail(email)) {
      throw new Error('Valid email is required');
    }
    if (!comment || comment.trim().length < 10) {
      throw new Error('Comment must be at least 10 characters');
    }
    if (comment.length > 2000) {
      throw new Error('Comment must be less than 2000 characters');
    }

    // Check rate limiting (max 3 comments per email per hour)
    const recentCount = (await db.prepare(`
      SELECT COUNT(*) as count FROM blog_comments
      WHERE email = ? AND created_at > datetime('now', '-1 hour')
    `)).get(email);

    if (recentCount && recentCount.count >= 3) {
      throw new Error('Too many comments. Please try again later.');
    }

    // Verify post exists and is published
    const post = (await db.prepare(`
      SELECT id FROM blog_posts WHERE id = ? AND status = 'published'
    `)).get(postId);

    if (!post) {
      throw new Error('Post not found');
    }

    // Sanitize inputs
    const sanitizedComment = {
      postId,
      firstName: escapeHtml(firstName.trim()),
      lastName: lastName ? escapeHtml(lastName.trim()) : null,
      email: email.trim().toLowerCase(),
      website: website ? escapeHtml(website.trim()) : null,
      comment: escapeHtml(comment.trim()),
    };

    const result = (await db.prepare(`
      INSERT INTO blog_comments (post_id, first_name, last_name, email, website, comment, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `)).run(
      sanitizedComment.postId,
      sanitizedComment.firstName,
      sanitizedComment.lastName,
      sanitizedComment.email,
      sanitizedComment.website,
      sanitizedComment.comment
    );

    return {
      id: result.lastInsertRowid,
      ...sanitizedComment,
      status: 'pending',
    };
  },

  /**
   * Approve comment
   */
  async approve(id) {
    const comment = await this.findById(id);
    if (!comment) {
      throw new Error('Comment not found');
    }

    (await db.prepare(`
      UPDATE blog_comments SET status = 'approved' WHERE id = ?
    `)).run(id);

    return { ...comment, status: 'approved' };
  },

  /**
   * Reject comment
   */
  async reject(id) {
    const comment = await this.findById(id);
    if (!comment) {
      throw new Error('Comment not found');
    }

    (await db.prepare(`
      UPDATE blog_comments SET status = 'rejected' WHERE id = ?
    `)).run(id);

    return { ...comment, status: 'rejected' };
  },

  /**
   * Delete comment
   */
  async delete(id) {
    const comment = await this.findById(id);
    if (!comment) {
      throw new Error('Comment not found');
    }

    (await db.prepare('DELETE FROM blog_comments WHERE id = ?')).run(id);
    return true;
  },

  /**
   * Bulk approve comments
   * @param {number[]} ids - Array of comment IDs
   */
  async bulkApprove(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { updated: 0 };

    const placeholders = ids.map(() => '?').join(',');
    (await db.prepare(`
      UPDATE blog_comments SET status = 'approved' WHERE id IN (${placeholders})
    `)).run(...ids);

    return { updated: ids.length };
  },

  /**
   * Bulk reject comments
   * @param {number[]} ids - Array of comment IDs
   */
  async bulkReject(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { updated: 0 };

    const placeholders = ids.map(() => '?').join(',');
    (await db.prepare(`
      UPDATE blog_comments SET status = 'rejected' WHERE id IN (${placeholders})
    `)).run(...ids);

    return { updated: ids.length };
  },

  /**
   * Bulk delete comments
   * @param {number[]} ids - Array of comment IDs
   */
  async bulkDelete(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0 };

    const placeholders = ids.map(() => '?').join(',');
    (await db.prepare(`
      DELETE FROM blog_comments WHERE id IN (${placeholders})
    `)).run(...ids);

    return { deleted: ids.length };
  },

  /**
   * Count comments by status
   */
  async countByStatus() {
    const results = (await db.prepare(`
      SELECT status, COUNT(*) as count
      FROM blog_comments
      GROUP BY status
    `)).all();

    const counts = { pending: 0, approved: 0, rejected: 0, total: 0 };
    for (const row of results) {
      counts[row.status] = row.count;
      counts.total += row.count;
    }
    return counts;
  },
};

export default Comment;
