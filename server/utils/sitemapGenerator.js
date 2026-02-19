import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Priority mapping for different page types
const PAGE_PRIORITIES = {
  'index': 1.0,
  'services': 0.9,
  'portfolio': 0.9,
  'gallery': 0.9,
  'blog': 0.9,
  'about': 0.9,
  'process': 0.8,
  'consultation': 0.8,
  'careers': 0.8,
  'resources': 0.8,
  'privacy': 0.6,
  'terms': 0.6,
  'sitemap': 0.6,
  'service-detail': 0.7  // For pages in /services/ subdirectory
};

// Get priority based on page name
function getPagePriority(pagePath) {
  const fileName = path.basename(pagePath, '.html');

  // Check if it's a service detail page
  if (pagePath.includes('/services/')) {
    return PAGE_PRIORITIES['service-detail'];
  }

  return PAGE_PRIORITIES[fileName] || 0.8;
}

// Scan directory recursively for HTML files
function scanPagesDirectory(dir, baseDir = dir, results = []) {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // Recurse into subdirectories
      scanPagesDirectory(filePath, baseDir, results);
    } else if (file.endsWith('.html')) {
      // Get relative path from pages directory
      const relativePath = path.relative(baseDir, filePath);
      // const urlPath = '/' + relativePath.replace(/\\/g, '/').replace('.html', '');
      const urlPath = '/pages/' + relativePath.replace(/\\/g, '/').replace('.html', '');

      // Get file modification time for lastmod
      const lastmod = stat.mtime.toISOString().split('T')[0];

      results.push({
        url: urlPath,
        lastmod: lastmod,
        priority: getPagePriority(relativePath)
      });
    }
  }

  return results;
}

// Fetch blog posts from HubSpot RSS API
async function fetchBlogPosts() {
  try {
    const response = await fetch('http://localhost:4000/api/hubspot-blog');

    if (!response.ok) {
      console.error('Failed to fetch blog posts for sitemap');
      return [];
    }

    const data = await response.json();

    return data.posts.map(post => ({
      url: `/pages/blog-post?id=${encodeURIComponent(post.url)}`,
      lastmod: new Date(post.publishDate).toISOString().split('T')[0],
      priority: 0.7
    }));
  } catch (error) {
    console.error('Error fetching blog posts for sitemap:', error);
    return [];
  }
}

// Generate XML sitemap
async function generateXMLSitemap() {
  const baseUrl = 'https://designwithlighthouse.com';

  // Scan pages directory
  const pagesDir = path.join(__dirname, '..', '..', 'pages');
  const pages = scanPagesDirectory(pagesDir);

  // Fetch blog posts
  const blogPosts = await fetchBlogPosts();

  // Combine all URLs
  const allUrls = [...pages, ...blogPosts];

  // Build XML
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  // Add home page (special case - root path)
  xml += '  <url>\n';
  xml += `    <loc>${baseUrl}/</loc>\n`;
  xml += `    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>\n`;
  xml += `    <priority>1.0</priority>\n`;
  xml += '  </url>\n';

  // Add all other pages
  for (const page of allUrls) {
    // Skip index page since we already added it as root
    if (page.url === '/index') continue;

    xml += '  <url>\n';
    xml += `    <loc>${baseUrl}${page.url}</loc>\n`;
    xml += `    <lastmod>${page.lastmod}</lastmod>\n`;
    xml += `    <priority>${page.priority}</priority>\n`;
    xml += '  </url>\n';
  }

  xml += '</urlset>';

  return xml;
}

export { generateXMLSitemap };
