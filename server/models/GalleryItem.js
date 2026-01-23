import db from './database.js';

export const GalleryItem = {
  /**
   * Get all gallery items ordered by display_order
   */
  async findAll() {
    return (await db.prepare(`
      SELECT * FROM gallery_items
      ORDER BY display_order ASC, created_at DESC
    `)).all();
  },

  /**
   * Find gallery item by ID
   */
  async findById(id) {
    return (await db.prepare('SELECT * FROM gallery_items WHERE id = ?')).get(id);
  },

  /**
   * Create new gallery item (image or video)
   * Supports both legacy (filepath) and Railway (variant keys) storage
   */
  async create({
    type,
    filename,
    filepath = null,
    thumbnail = null,
    sizeClass = 'medium',
    uploadedBy = null,
    // Railway Buckets variant keys (optional)
    keys = null,
    videoKey = null,
    thumbnailKeys = null,
    contentHash = null,
    blurData = null, // Base64 blur placeholder for instant loading
  }) {
    try {
      // Get max display_order
      const maxOrder = (await db.prepare('SELECT MAX(display_order) as max FROM gallery_items')).get();
      const displayOrder = (maxOrder.max || 0) + 1;

      // Extract keys from objects if provided
      const keySm = keys?.key_sm || null;
      const keyMd = keys?.key_md || null;
      const keyLg = keys?.key_lg || null;
      const thumbKeySm = thumbnailKeys?.key_sm || null;
      const thumbKeyMd = thumbnailKeys?.key_md || null;
      const thumbKeyLg = thumbnailKeys?.key_lg || null;

      const result = (await db.prepare(`
        INSERT INTO gallery_items (
          type, filename, filepath, thumbnail, size_class, display_order, uploaded_by,
          key_sm, key_md, key_lg, video_key, thumb_key_sm, thumb_key_md, thumb_key_lg, content_hash, blur_data
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)).run(
        type, filename, filepath, thumbnail, sizeClass, displayOrder, uploadedBy,
        keySm, keyMd, keyLg, videoKey, thumbKeySm, thumbKeyMd, thumbKeyLg, contentHash, blurData
      );

      console.log('GalleryItem.create result:', { lastInsertRowid: result.lastInsertRowid });

      const item = await this.findById(result.lastInsertRowid);
      if (!item) {
        console.error('GalleryItem.create: findById returned null for rowid:', result.lastInsertRowid);
      }
      return item;
    } catch (err) {
      console.error('GalleryItem.create SQL error:', err.message);
      throw new Error(`Database insert failed: ${err.message}`);
    }
  },

  /**
   * Create embed item (YouTube/Vimeo)
   */
  async createEmbed({ embedUrl, embedPlatform, thumbnail, sizeClass = 'medium', uploadedBy }) {
    // Get max display_order
    const maxOrder = (await db.prepare('SELECT MAX(display_order) as max FROM gallery_items')).get();
    const displayOrder = (maxOrder.max || 0) + 1;

    const result = (await db.prepare(`
      INSERT INTO gallery_items (type, embed_url, embed_platform, thumbnail, size_class, display_order, uploaded_by)
      VALUES ('embed', ?, ?, ?, ?, ?, ?)
    `)).run(embedUrl, embedPlatform, thumbnail, sizeClass, displayOrder, uploadedBy);

    return this.findById(result.lastInsertRowid);
  },

  /**
   * Update gallery item
   */
  async update(id, { sizeClass, displayOrder }) {
    const updates = [];
    const values = [];

    if (sizeClass !== undefined) {
      updates.push('size_class = ?');
      values.push(sizeClass);
    }

    if (displayOrder !== undefined) {
      updates.push('display_order = ?');
      values.push(displayOrder);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    (await db.prepare(`
      UPDATE gallery_items
      SET ${updates.join(', ')}
      WHERE id = ?
    `)).run(...values);

    return this.findById(id);
  },

  /**
   * Delete gallery item
   */
  async delete(id) {
    const item = await this.findById(id);
    if (!item) {
      throw new Error('Gallery item not found');
    }

    (await db.prepare('DELETE FROM gallery_items WHERE id = ?')).run(id);
    return item;
  },

  /**
   * Bulk reorder items
   */
  async reorder(orderedIds) {
    const stmt = await db.prepare('UPDATE gallery_items SET display_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');

    const reorderTransaction = await db.transaction((ids) => {
      ids.forEach((id, index) => {
        stmt.run(index + 1, id);
      });
    });

    reorderTransaction(orderedIds);
    return this.findAll();
  },

  /**
   * Get total count
   */
  async count() {
    return (await db.prepare('SELECT COUNT(*) as count FROM gallery_items')).get().count;
  },

  /**
   * Get items by type
   */
  async findByType(type) {
    return (await db.prepare(`
      SELECT * FROM gallery_items
      WHERE type = ?
      ORDER BY display_order ASC, created_at DESC
    `)).all(type);
  },

  /**
   * Bulk create (for batch uploads)
   * Supports both legacy (filepath) and Railway (variant keys) storage
   */
  async createBatch(items, uploadedBy) {
    const maxOrder = (await db.prepare('SELECT MAX(display_order) as max FROM gallery_items')).get();
    let displayOrder = (maxOrder.max || 0) + 1;

    const stmt = await db.prepare(`
      INSERT INTO gallery_items (
        type, filename, filepath, thumbnail, size_class, display_order, uploaded_by,
        key_sm, key_md, key_lg, video_key, thumb_key_sm, thumb_key_md, thumb_key_lg, content_hash, blur_data
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTransaction = await db.transaction((itemsToInsert) => {
      const insertedIds = [];
      for (const item of itemsToInsert) {
        // Extract Railway keys if provided
        const keySm = item.keys?.key_sm || null;
        const keyMd = item.keys?.key_md || null;
        const keyLg = item.keys?.key_lg || null;
        const thumbKeySm = item.thumbnailKeys?.key_sm || null;
        const thumbKeyMd = item.thumbnailKeys?.key_md || null;
        const thumbKeyLg = item.thumbnailKeys?.key_lg || null;

        const result = stmt.run(
          item.type,
          item.filename,
          item.filepath || null,
          item.thumbnail || null,
          item.sizeClass || 'medium',
          displayOrder++,
          uploadedBy,
          keySm, keyMd, keyLg,
          item.videoKey || null,
          thumbKeySm, thumbKeyMd, thumbKeyLg,
          item.contentHash || null,
          item.blurData || null
        );
        insertedIds.push(result.lastInsertRowid);
      }
      return insertedIds;
    });

    const ids = insertTransaction(items);
    return Promise.all(ids.map(id => this.findById(id)));
  },

  /**
   * Check if an item uses Railway storage (has variant keys)
   */
  isRailwayItem(item) {
    return !!(item.key_sm || item.key_md || item.key_lg || item.video_key);
  },

  /**
   * Get variant keys from an item
   */
  getVariantKeys(item) {
    return {
      key_sm: item.key_sm,
      key_md: item.key_md,
      key_lg: item.key_lg,
    };
  },

  /**
   * Get video and thumbnail keys from an item
   */
  getVideoKeys(item) {
    return {
      videoKey: item.video_key,
      thumbnailKeys: {
        key_sm: item.thumb_key_sm,
        key_md: item.thumb_key_md,
        key_lg: item.thumb_key_lg,
      },
    };
  },
};

export default GalleryItem;
