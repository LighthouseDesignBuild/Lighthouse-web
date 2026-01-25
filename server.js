// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import * as cheerio from "cheerio";
import session from "express-session";
import createMemoryStore from "memorystore";
import fs from "fs";

// Import admin routes
import authRoutes from "./server/routes/auth.js";
import userRoutes from "./server/routes/users.js";
import galleryRoutes from "./server/routes/gallery.js";
import blogRoutes from "./server/routes/blog.js";
import adminBlogRoutes from "./server/routes/admin-blog.js";
import backupRoutes from "./server/routes/backup.js";

// Import sitemap generator
import { generateXMLSitemap } from "./server/utils/sitemapGenerator.js";

// NOTE: Database is now lazily initialized when admin routes are accessed. This prevents sql.js WASM loading when non-database routes (like blog API) are called

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust proxy - required for Railway/Docker/cloud environments behind reverse proxy
// This allows Express to trust X-Forwarded-* headers for secure cookies
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Initialize memory session store (with periodic cleanup)
const MemoryStore = createMemoryStore(session);

// Session configuration
app.use(session({
  store: new MemoryStore({
    checkPeriod: 86400000 // Prune expired entries every 24h
  }),
  secret: process.env.SESSION_SECRET || 'lighthouse-admin-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax', // Prevents CSRF while allowing same-site navigation
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// JSON body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// IMPORTANT: Set this to the real HubSpot RSS feed URL.
// For example, if the blog is at https://blog.example.com/,
// the RSS is often at: https://blog.example.com/rss.xml
const HUBSPOT_RSS_URL =
  process.env.HUBSPOT_RSS_URL || "https://blog.raymonddesignbuilders.com/news-info/rss.xml";

// Clean URL handler - serve .html files for URLs without extension
app.use((req, res, next) => {
  if (req.path.startsWith('/pages/') && !req.path.includes('.')) {
    const htmlPath = path.join(__dirname, req.path + '.html');
    if (fs.existsSync(htmlPath)) {
      return res.sendFile(htmlPath);
    }
  }
  next();
});

// Redirect .html URLs to clean URLs (301 permanent redirect for SEO)
app.use((req, res, next) => {
  if (req.path.endsWith('.html') && req.path.startsWith('/pages/')) {
    const cleanPath = req.path.slice(0, -5);
    // Preserve query string in redirect
    const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return res.redirect(301, cleanPath + queryString);
  }
  next();
});

// Serve static files. Adjust this path if the site assets live elsewhere.
const STATIC_DIR = path.join(__dirname, ".");
app.use(express.static(STATIC_DIR));

// Mount admin API routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/gallery", galleryRoutes);

// Mount blog routes
app.use("/api/blog", blogRoutes);
app.use("/api/admin/blog", adminBlogRoutes);

// Mount backup routes (admin only)
app.use("/api/admin/backup", backupRoutes);

// Mount admin comment routes (under /api/admin for consistency)
// Note: These are included in adminBlogRoutes at /api/admin/blog/comments/*

// Serve admin pages
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "index.html"));
});
app.get("/admin/:page", (req, res) => {
  // Extract the requested admin page
  const page = req.params.page || "index.html";
  const filePath = path.join(__dirname, "admin", page.endsWith(".html") ? page : `${page}.html`);
  res.sendFile(filePath, (err) => {
    if (err) {
      // If file doesn't exist, serve the main admin page
      res.sendFile(path.join(__dirname, "admin", "index.html"));
    }
  });
});

// Helper: Fetch and parse HubSpot RSS feed
async function fetchHubspotRss() {
  const resp = await fetch(HUBSPOT_RSS_URL);

  if (!resp.ok) {
    throw new Error(
      `Failed RSS fetch: ${resp.status} ${resp.statusText} for ${HUBSPOT_RSS_URL}`
    );
  }

  const xml = await resp.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const items = parsed?.rss?.channel?.item || [];
  const list = Array.isArray(items) ? items : [items];
  return list;
}

// Helper: Normalize RSS item to consistent format
function normalizeItem(item) {
  // GUID can be an object or string.
  const rawGuid =
    (item.guid && (item.guid._ || item.guid)) || item.link || item.title || "";

  const id = rawGuid;
  const title = item.title || "";
  const link = item.link || "";
  const description = item.description || "";
  const pubDate = item.pubDate || "";

  // Some HubSpot RSS feeds include full content in content:encoded.
  // If not present, fall back to description.
  const contentHtml =
    item["content:encoded"] && item["content:encoded"].trim().length > 0
      ? item["content:encoded"]
      : description;

  return {
    id,
    title,
    link,
    description,
    pubDate,
    contentHtml
  };
}

// Helper: Scrape full blog post content from HubSpot URL
async function scrapeHubSpotBlogPost(url) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch blog post: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove unwanted elements globally
    $('script').remove();
    $('style').remove();
    $('.hs-cta-wrapper').remove();
    $('.hs-form').remove();
    $('img[src*="track.hubspot.com"]').remove(); // Remove tracking pixels
    $('nav').remove(); // Remove navigation
    $('header').remove(); // Remove header
    $('footer').remove(); // Remove footer
    $('.header').remove();
    $('.footer').remove();
    $('.navigation').remove();

    // Try to find the main blog content using HubSpot-specific selectors
    let content = '';

    // Try different common HubSpot blog content selectors in order of specificity
    const selectors = [
      '#main-content',
      '.blog-post-content',
      '.post-body',
      '.hs-blog-post-body',
      '.blog-index__post-content',
      'article .post-content',
      '.blog-post .body',
      'main',
      'article'
    ];

    for (const selector of selectors) {
      const element = $(selector);
      if (element.length > 0) {
        content = element.html();
        console.log(`Found content using selector: ${selector}`);
        break;
      }
    }

    // Clean up the content
    if (content) {
      // Load content into new cheerio instance for cleaning
      const $content = cheerio.load(content);

      // Remove the title (h1) since we display it separately from RSS feed
      $content('h1').first().remove();

      // Remove any remaining unwanted elements from content
      $content('.sidebar').remove();
      $content('.related-posts').remove();
      $content('.comments').remove();
      $content('.share-buttons').remove();
      $content('nav').remove();
      $content('.hhs-blog-grid-cards').remove(); 
      $content('.post-page').remove(); 
      $content('.blog-index').remove(); 

      // Fix image paths to be absolute
      $content('img').each((i, img) => {
        const src = $content(img).attr('src');
        if (src && src.startsWith('/')) {
          const baseUrl = new URL(url).origin;
          $content(img).attr('src', baseUrl + src);
        }
      });

      // Fix link paths - convert HubSpot blog internal links to point to our site
      $content('a').each((i, link) => {
        const href = $content(link).attr('href');
        if (href) {
          // Check if it's a HubSpot blog link
          if (href.includes('blog.raymonddesignbuilders.com/news-info')) {
            // This is a blog post link - convert to our blog-post.html format
            const postPath = href.split('/news-info/')[1];
            if (postPath && postPath.trim()) {
              $content(link).attr('href', `./blog-post.html?id=${encodeURIComponent(href)}`);
            }
          } else if (href.includes('raymonddesignbuilders.com') && !href.includes('blog.raymonddesignbuilders.com')) {
            // This is a link to the old main site - convert to new site pages

            // Map common old site URLs to new site pages
            if (href.includes('/contact') || href.toLowerCase().includes('contact')) {
              $content(link).attr('href', './consultation.html');
            } else if (href.includes('/portfolio') || href.includes('/projects') || href.includes('/our-work')) {
              $content(link).attr('href', './portfolio.html');
            } else if (href.includes('/gallery')) {
              $content(link).attr('href', './gallery.html');
            } else if (href.includes('/about')) {
              $content(link).attr('href', './about.html');
            } else if (href.includes('/services')) {
              $content(link).attr('href', './services.html');
            } else {
              // Default to home page for other old site links
              $content(link).attr('href', './index.html');
            }
          } else if (href.startsWith('/') && !href.startsWith('//')) {
            // Relative link - make absolute to HubSpot site
            const baseUrl = new URL(url).origin;
            $content(link).attr('href', baseUrl + href);
          }
        }
      });

      content = $content.html();
    }

    if (!content || content.trim().length < 50) {
      return '<p>Content could not be extracted from this blog post. <a href="' + url + '" target="_blank">View original post</a></p>';
    }

    return content;
  } catch (error) {
    console.error('Error scraping blog post:', error);
    return '<p>Unable to load blog post content. <a href="' + url + '" target="_blank">View original post</a></p>';
  }
}

// Simple health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// XML Sitemap generation
app.get("/sitemap.xml", async (req, res) => {
  try {
    const sitemap = await generateXMLSitemap();
    res.header('Content-Type', 'application/xml');
    res.send(sitemap);
  } catch (error) {
    console.error('Error generating sitemap:', error);
    res.status(500).send('Error generating sitemap');
  }
});

// Serve home page at root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "pages", "index.html"));
});

// API: Fetch and return HubSpot RSS as JSON (blog listing)
app.get("/api/hubspot-blog", async (req, res) => {
  try {
    const items = await fetchHubspotRss();
    const posts = items.map((item) => {
      const normalized = normalizeItem(item);
      // For the listing endpoint, we can omit contentHtml or keep it.
      return {
        id: normalized.id,
        title: normalized.title,
        link: normalized.link,
        description: normalized.description,
        pubDate: normalized.pubDate,
        guid: normalized.id // For backwards compatibility
      };
    });

    res.json({ posts });
  } catch (err) {
    console.error("Error in /api/hubspot-blog:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// API: Fetch single blog post by ID
app.get("/api/hubspot-blog/post", async (req, res) => {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: "Missing id query parameter" });
  }

  try {
    const items = await fetchHubspotRss();
    let target = null;

    for (const item of items) {
      const normalized = normalizeItem(item);
      if (normalized.id === id || normalized.link === id) {
        target = normalized;
        break;
      }
    }

    if (!target) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Scrape the full content from the HubSpot blog post URL
    console.log(`Fetching full content from: ${target.link}`);
    const scrapedContent = await scrapeHubSpotBlogPost(target.link);

    res.json({
      id: target.id,
      title: target.title,
      link: target.link,
      description: target.description,
      pubDate: target.pubDate,
      contentHtml: scrapedContent
    });
  } catch (err) {
    console.error("Error in /api/hubspot-blog/post:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Export for Vercel serverless
export default app;

// Start server
// Note: Vercel ignores this and uses the exported app above
// Railway and other PaaS platforms will use this
const PORT = process.env.PORT || 4000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🌊 Lighthouse Design Build Server Running!`);
    console.log(`\n📍 Server listening on http://localhost:${PORT}`);
    console.log(`📂 Serving static files from: ${STATIC_DIR}`);
    console.log(`\n📄 Available Pages:`);
    console.log(`   • Home:         http://localhost:${PORT}/pages/index.html`);
    console.log(`   • Blog:         http://localhost:${PORT}/pages/blog.html`);
    console.log(`   • Portfolio:    http://localhost:${PORT}/pages/portfolio.html`);
    console.log(`   • Gallery:      http://localhost:${PORT}/pages/gallery.html`);
    console.log(`   • Consultation: http://localhost:${PORT}/pages/consultation.html`);
    console.log(`\n🔐 Admin Panel:`);
    console.log(`   • Admin Login:  http://localhost:${PORT}/admin`);
    console.log(`   • Default Login: admin /lighthouse@2026!`);
    console.log(`\n🔌 API Endpoints:`);
    console.log(`   • Blog API:     http://localhost:${PORT}/api/blog`);
    console.log(`   • Gallery API:  http://localhost:${PORT}/api/gallery`);
    console.log(`   • Auth API:     http://localhost:${PORT}/api/auth`);
    console.log(`   • Admin Blog:   http://localhost:${PORT}/api/admin/blog`);
    console.log(`   • Health:       http://localhost:${PORT}/health`);
    console.log(`\n⌨️  Press Ctrl+C to stop the server\n`);
  });
}
