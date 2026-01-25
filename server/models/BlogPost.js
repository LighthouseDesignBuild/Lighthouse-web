import db from './database.js';

// Fixed categories
export const CATEGORIES = {
  kitchen: 'Kitchen Remodeling',
  bathroom: 'Bathroom Remodeling',
  additions: 'Home Additions',
  outdoor: 'Outdoor Living',
  'design-tips': 'Design Tips',
  'company-news': 'Company News',
};

/**
 * Generate URL slug from title
 * @param {string} title - Post title
 * @returns {string} URL-safe slug
 */
function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);
}

/**
 * Ensure slug is unique by appending number if needed
 * @param {string} baseSlug - Base slug to check
 * @param {number|null} excludeId - Post ID to exclude from check (for updates)
 * @returns {Promise<string>} Unique slug
 */
async function ensureUniqueSlug(baseSlug, excludeId = null) {
  let slug = baseSlug;
  let counter = 1;

  while (true) {
    const query = excludeId
      ? 'SELECT id FROM blog_posts WHERE slug = ? AND id != ?'
      : 'SELECT id FROM blog_posts WHERE slug = ?';
    const params = excludeId ? [slug, excludeId] : [slug];
    const existing = (await db.prepare(query)).get(...params);

    if (!existing) return slug;

    counter++;
    slug = `${baseSlug}-${counter}`;
  }
}

/**
 * Extract first paragraph text from blocks for excerpt
 * @param {Array} blocks - Content blocks
 * @param {number} maxLength - Max excerpt length
 * @returns {string} Excerpt text
 */
function extractExcerpt(blocks, maxLength = 200) {
  if (!Array.isArray(blocks)) return '';

  for (const block of blocks) {
    if (block.type === 'paragraph' && block.data?.text) {
      const text = block.data.text;
      if (text.length <= maxLength) return text;
      return text.substring(0, maxLength).trim() + '...';
    }
  }
  return '';
}

export const BlogPost = {
  /**
   * Find post by ID
   */
  async findById(id) {
    const post = (await db.prepare('SELECT * FROM blog_posts WHERE id = ?')).get(id);
    if (post && post.content) {
      post.content = JSON.parse(post.content);
    }
    return post;
  },

  /**
   * Find post by slug (public - only published)
   */
  async findBySlug(slug) {
    const post = (await db.prepare(`
      SELECT * FROM blog_posts WHERE slug = ? AND status = 'published'
    `)).get(slug);
    if (post && post.content) {
      post.content = JSON.parse(post.content);
    }
    return post;
  },

  /**
   * Find post by slug (admin - any status)
   */
  async findBySlugAdmin(slug) {
    const post = (await db.prepare('SELECT * FROM blog_posts WHERE slug = ?')).get(slug);
    if (post && post.content) {
      post.content = JSON.parse(post.content);
    }
    return post;
  },

  /**
   * Get all posts (admin view - includes drafts)
   */
  async findAll() {
    const posts = (await db.prepare(`
      SELECT id, title, slug, category, status, author_id, author_name,
             featured_image_key, published_at, created_at, updated_at
      FROM blog_posts
      ORDER BY created_at DESC
    `)).all();
    return posts;
  },

  /**
   * Get published posts with pagination
   * @param {number} limit - Number of posts to return
   * @param {number} offset - Offset for pagination
   * @returns {Promise<{posts: Array, total: number, hasMore: boolean}>}
   */
  async findPublished(limit = 12, offset = 0) {
    const posts = (await db.prepare(`
      SELECT id, title, slug, category, content, status, author_name,
             featured_image_key, featured_image_alt, meta_description,
             published_at, created_at
      FROM blog_posts
      WHERE status = 'published'
      ORDER BY published_at DESC
      LIMIT ? OFFSET ?
    `)).all(limit, offset);

    // Parse content and extract excerpt for each post
    for (const post of posts) {
      if (post.content) {
        post.content = JSON.parse(post.content);
        post.excerpt = extractExcerpt(post.content);
      }
    }

    const countResult = (await db.prepare(`
      SELECT COUNT(*) as total FROM blog_posts WHERE status = 'published'
    `)).get();

    const total = countResult?.total || 0;

    return {
      posts,
      total,
      hasMore: offset + posts.length < total,
    };
  },

  /**
   * Create new blog post
   */
  async create({
    title,
    slug,
    category,
    content,
    featuredImageKey,
    featuredImageAlt,
    metaTitle,
    metaDescription,
    canonicalUrl,
    status = 'draft',
    authorId,
    authorName,
  }) {
    // Validate category
    if (!CATEGORIES[category]) {
      throw new Error(`Invalid category: ${category}`);
    }

    // Generate slug if not provided
    const baseSlug = slug || generateSlug(title);
    const uniqueSlug = await ensureUniqueSlug(baseSlug);

    // Serialize content to JSON
    const contentJson = JSON.stringify(content || []);

    // Set published_at if publishing
    const publishedAt = status === 'published' ? new Date().toISOString() : null;

    try {
      const result = (await db.prepare(`
        INSERT INTO blog_posts (
          title, slug, category, content, featured_image_key, featured_image_alt,
          meta_title, meta_description, canonical_url, status, author_id, author_name, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)).run(
        title,
        uniqueSlug,
        category,
        contentJson,
        featuredImageKey || null,
        featuredImageAlt || null,
        metaTitle || null,
        metaDescription || null,
        canonicalUrl || null,
        status,
        authorId,
        authorName,
        publishedAt
      );

      return {
        id: result.lastInsertRowid,
        title,
        slug: uniqueSlug,
        category,
        status,
      };
    } catch (err) {
      if (err.message.includes('UNIQUE constraint')) {
        throw new Error('A post with this slug already exists');
      }
      throw err;
    }
  },

  /**
   * Update blog post
   */
  async update(id, {
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
  }) {
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error('Post not found');
    }

    // Validate category if provided
    if (category && !CATEGORIES[category]) {
      throw new Error(`Invalid category: ${category}`);
    }

    // Handle slug change
    let finalSlug = existing.slug;
    if (slug && slug !== existing.slug) {
      finalSlug = await ensureUniqueSlug(slug, id);
    }

    // Serialize content if provided
    const contentJson = content ? JSON.stringify(content) : JSON.stringify(existing.content);

    // Handle publish transition
    let publishedAt = existing.published_at;
    if (status === 'published' && existing.status !== 'published') {
      publishedAt = new Date().toISOString();
    }

    (await db.prepare(`
      UPDATE blog_posts SET
        title = ?,
        slug = ?,
        category = ?,
        content = ?,
        featured_image_key = ?,
        featured_image_alt = ?,
        meta_title = ?,
        meta_description = ?,
        canonical_url = ?,
        status = ?,
        published_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)).run(
      title ?? existing.title,
      finalSlug,
      category ?? existing.category,
      contentJson,
      featuredImageKey !== undefined ? featuredImageKey : existing.featured_image_key,
      featuredImageAlt !== undefined ? featuredImageAlt : existing.featured_image_alt,
      metaTitle !== undefined ? metaTitle : existing.meta_title,
      metaDescription !== undefined ? metaDescription : existing.meta_description,
      canonicalUrl !== undefined ? canonicalUrl : existing.canonical_url,
      status ?? existing.status,
      publishedAt,
      id
    );

    return this.findById(id);
  },

  /**
   * Delete blog post
   */
  async delete(id) {
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error('Post not found');
    }

    (await db.prepare('DELETE FROM blog_posts WHERE id = ?')).run(id);
    return true;
  },

  /**
   * Count posts by status
   */
  async countByStatus() {
    const results = (await db.prepare(`
      SELECT status, COUNT(*) as count
      FROM blog_posts
      GROUP BY status
    `)).all();

    const counts = { draft: 0, published: 0, total: 0 };
    for (const row of results) {
      counts[row.status] = row.count;
      counts.total += row.count;
    }
    return counts;
  },

  /**
   * Get category display name
   */
  getCategoryName(slug) {
    return CATEGORIES[slug] || slug;
  },

  /**
   * Get all categories
   */
  getCategories() {
    return CATEGORIES;
  },
};

export default BlogPost;
