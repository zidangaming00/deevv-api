import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import RssParser from 'rss-parser';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Enable CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const rssParser = new RssParser({
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail']
    ]
  }
});

// Cache sederhana di memory
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 menit

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML/ Laver: Chrome) Chrome/124.0.0.0 Safari/537.36';

// Helper Bahasa & Wilayah
function resolveLanguageConfig(queryParams, acceptLanguageHeader) {
  const hl = queryParams.hl || (acceptLanguageHeader ? acceptLanguageHeader.split(',')[0].slice(0, 2) : 'id');
  const gl = queryParams.gl || (hl === 'id' ? 'id' : 'us');
  const mkt = `${hl}-${gl.toUpperCase()}`;
  return { hl, gl, mkt };
}

// Helper Dekode Redirect Google News ke Direct Link Original
function extractDirectNewsUrl(googleNewsUrl) {
  if (!googleNewsUrl) return '';
  try {
    const urlObj = new URL(googleNewsUrl);
    // Google News RSS memberikan URL bertipe /rss/articles/... atau artikel ber-param url=
    const directParam = urlObj.searchParams.get('url');
    if (directParam) return directParam;

    // Jika URL mengandung encoded string Google News, coba ekstrak dari query jika ada
    return googleNewsUrl;
  } catch (err) {
    return googleNewsUrl;
  }
}

// Helper Ekstrak Gambar dari Deskripsi RSS
function extractImageFromHtml(htmlSnippet) {
  if (!htmlSnippet) return null;
  const $ = cheerio.load(htmlSnippet);
  const imgSrc = $('img').first().attr('src');
  if (imgSrc) {
    // Normalisasi URL protocol relative (//...)
    return imgSrc.startsWith('//') ? `https:${imgSrc}` : imgSrc;
  }
  return null;
}

// ==========================================
// 1. SCRAPER WEB (Google Search)
// ==========================================
async function fetchWebResults(query, config, limit, offset, headers) {
  const items = [];
  const start = offset || 0;
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=${config.hl}&gl=${config.gl}&start=${start}&num=${limit + 5}`;

  const res = await axios.get(googleUrl, { headers, timeout: 8000 });
  const $ = cheerio.load(res.data);

  let position = start + 1;

  $('div.g, div[data-hveid]').each((_, el) => {
    if (items.length >= limit) return false;

    const titleEl = $(el).find('h3').first();
    const linkEl = $(el).find('a').first();
    const snippetEl = $(el).find('div.VwiC3b, div[style*="-webkit-line-clamp"]').first();

    const title = titleEl.text().trim();
    const link = linkEl.attr('href');
    const snippet = snippetEl.text().trim();

    if (title && link && link.startsWith('http') && !link.includes('google.com/search')) {
      let domain = '';
      try {
        domain = new URL(link).hostname.replace(/^www\./, '');
      } catch (e) {}

      items.push({
        title,
        link,
        snippet,
        domain,
        position: position++
      });
    }
  });

  return items;
}

// ==========================================
// 2. SCRAPER GAMBAR (Bing Images - Offset Support)
// ==========================================
async function fetchImages(query, config, limit, offset, headers) {
  const images = [];
  const firstIndex = offset > 0 ? offset + 1 : 1;
  const fetchCount = Math.max(limit, 20);

  const bingImgUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&setmkt=${config.mkt}&setlang=${config.hl}&count=${fetchCount}&first=${firstIndex}`;

  const res = await axios.get(bingImgUrl, { headers, timeout: 8000 });
  const $ = cheerio.load(res.data);

  $('a.iusc, a[href*="mediaurl="], a[href*="detailV2"], div.iuscp a').each((_, el) => {
    if (images.length >= limit) return false;

    const mAttr = $(el).attr('m');
    let imageUrl = '';
    let title = '';
    let thumbnailUrl = '';
    let targetLink = '';
    let imageWidth = 0;
    let imageHeight = 0;

    if (mAttr) {
      try {
        const mData = JSON.parse(mAttr);
        imageUrl = mData.murl;
        title = mData.t || mData.desc;
        thumbnailUrl = mData.turl;
        targetLink = mData.purl;
        imageWidth = mData.mw || 0;
        imageHeight = mData.mh || 0;
      } catch (e) {}
    }

    if (!imageUrl) {
      const href = $(el).attr('href') || '';
      const match = href.match(/mediaurl=([^&]+)/i);
      if (match) imageUrl = decodeURIComponent(match[1]);
    }

    if (imageUrl && imageUrl.startsWith('http')) {
      let domain = '';
      try {
        domain = new URL(targetLink || imageUrl).hostname.replace(/^www\./, '');
      } catch (e) {}

      images.push({
        title: title || query,
        imageUrl,
        imageWidth,
        imageHeight,
        thumbnailUrl: thumbnailUrl || imageUrl,
        source: domain || 'unknown',
        domain: domain || 'unknown',
        link: targetLink || imageUrl,
        googleUrl: `https://www.google.com/imgres?imgurl=${encodeURIComponent(imageUrl)}`,
        position: offset + images.length + 1
      });
    }
  });

  return images;
}

// ==========================================
// 3. SCRAPER BERITA (Google News RSS - Direct Link & Thumbnail)
// ==========================================
async function fetchNews(query, config, limit, offset) {
  const newsItems = [];
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${config.hl}-${config.gl.toUpperCase()}&gl=${config.gl.toUpperCase()}&ceid=${config.gl.toUpperCase()}:${config.hl}`;

  const feed = await rssParser.parseURL(rssUrl);
  const rawItems = feed.items || [];

  // Implementasi Manual Pagination untuk Feed RSS
  const pagedItems = rawItems.slice(offset, offset + limit);

  for (let i = 0; i < pagedItems.length; i++) {
    const item = pagedItems[i];

    // 1. Dapatkan Direct URL (Bukan link Google News jika memungkinkan)
    const originalLink = extractDirectNewsUrl(item.link);

    // 2. Dapatkan Thumbnail
    let thumbnail = null;

    if (item.mediaThumbnail && item.mediaThumbnail.$&& item.mediaThumbnail.$.url) {
      thumbnail = item.mediaThumbnail.$.url;
    } else if (item.mediaContent && item.mediaContent.$&& item.mediaContent.$.url) {
      thumbnail = item.mediaContent.$.url;
    } else {
      // Fallback: Cari Tag <img> di dalam isi deskripsi HTML RSS
      thumbnail = extractImageFromHtml(item.content || item.snippet || item.summary);
    }

    // 3. Sumber Berita / Publisher
    let sourceName = item.source || 'Berita';
    if (typeof sourceName === 'object' && sourceName._) {
      sourceName = sourceName._;
    }

    let domain = '';
    try {
      domain = new URL(originalLink).hostname.replace(/^www\./, '');
    } catch (e) {}

    // Bersihkan Snippet HTML Text
    const cleanSnippet = item.contentSnippet || (item.content ? cheerio.load(item.content).text() : '');

    newsItems.push({
      title: item.title ? item.title.replace(/ - [^-]+$/, '') : '', // Hapus nama publisher di akhir judul
      link: originalLink,
      snippet: cleanSnippet.trim(),
      publisher: sourceName,
      domain,
      thumbnailUrl: thumbnail,
      publishedAt: item.pubDate || item.isoDate || null,
      position: offset + i + 1
    });
  }

  return newsItems;
}

// ==========================================
// MAIN ROUTE API (/api/search)
// ==========================================
app.get('/api/search', async (req, res) => {
  const startTime = Date.now();
  const query = req.query.q;
  const searchType = (req.query.type || 'search').toLowerCase();

  if (!query) {
    return res.status(400).json({ status: 'error', message: 'Parameter "q" wajib diisi.' });
  }

  // Set Default Limit
  let defaultLimit = 10;
  if (searchType === 'images') defaultLimit = 20;
  if (searchType === 'news') defaultLimit = 15;

  const limit = parseInt(req.query.num, 10) || defaultLimit;

  // Mendukung Parameter 'start' ATAU 'page'
  let offset = parseInt(req.query.start, 10) || 0;
  if (!req.query.start && req.query.page) {
    const page = parseInt(req.query.page, 10) || 1;
    offset = (page - 1) * limit;
  }

  const config = resolveLanguageConfig(req.query, req.headers['accept-language']);
  const cacheKey = `${searchType}_${query.toLowerCase().trim()}_${config.hl}_${config.gl}_${limit}_start${offset}`;

  // Cek Cache
  if (cache.has(cacheKey)) {
    const cachedData = cache.get(cacheKey);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      return res.json(cachedData.data);
    }
  }

  const headers = {
    'User-Agent': USER_AGENT,
    'Accept-Language': `${config.hl}-${config.gl.toUpperCase()},${config.hl};q=0.9`
  };

  try {
    let results = [];

    if (searchType === 'images') {
      results = await fetchImages(query, config, limit, offset, headers);
    } else if (searchType === 'news') {
      results = await fetchNews(query, config, limit, offset);
    } else {
      results = await fetchWebResults(query, config, limit, offset, headers);
    }

    const searchTime = ((Date.now() - startTime) / 1000).toFixed(2);

    const responsePayload = {
      status: 'success',
      searchParameters: {
        q: query,
        type: searchType,
        hl: config.hl,
        gl: config.gl,
        num: limit,
        start: offset,
        page: Math.floor(offset / limit) + 1
      },
      searchInformation: {
        formattedSearchTime: searchTime,
        totalResults: results.length
      },
      [searchType === 'search' ? 'items' : searchType]: results
    };

    // Simpan ke Cache
    cache.set(cacheKey, { timestamp: Date.now(), data: responsePayload });

    return res.json(responsePayload);
  } catch (error) {
    console.error(`Error pada type=${searchType}:`, error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Gagal mengambil data dari penyedia pencarian.',
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server API berjalan di http://localhost:${PORT}`);
});
