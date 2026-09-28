import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import RssParser from 'rss-parser';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function resolveLanguageConfig(queryParams, acceptLanguageHeader) {
  const hl = queryParams.hl || (acceptLanguageHeader ? acceptLanguageHeader.split(',')[0].slice(0, 2) : 'id');
  const gl = queryParams.gl || (hl === 'id' ? 'id' : 'us');
  const mkt = `${hl}-${gl.toUpperCase()}`;
  return { hl, gl, mkt };
}

function extractImageFromHtml(htmlSnippet) {
  if (!htmlSnippet) return null;
  const $ = cheerio.load(htmlSnippet);
  const imgSrc = $('img').first().attr('src');
  if (imgSrc) {
    return imgSrc.startsWith('//') ? `https:${imgSrc}` : imgSrc;
  }
  return null;
}

// ==========================================
// CIRCUIT BREAKER — mencegah sistem "keras kepala"
// terus nyoba sumber yang lagi lumpuh
// ==========================================
class CircuitBreaker {
  constructor(name, { failureThreshold = 3, cooldownMs = 5 * 60 * 1000 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.failureCount = 0;
    this.openedAt = null; // kapan breaker "terbuka" (menolak request)
  }

  isOpen() {
    if (this.openedAt === null) return false;
    // Kalau sudah lewat cooldown, coba lagi (half-open)
    if (Date.now() - this.openedAt > this.cooldownMs) {
      this.openedAt = null;
      this.failureCount = 0;
      return false;
    }
    return true;
  }

  recordSuccess() {
    this.failureCount = 0;
    this.openedAt = null;
  }

  recordFailure() {
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold && this.openedAt === null) {
      this.openedAt = Date.now();
      console.error(`[CIRCUIT BREAKER] "${this.name}" DIBUKA — dianggap lumpuh selama ${this.cooldownMs / 1000}s ke depan. Gagal ${this.failureCount}x berturut-turut.`);
    }
  }

  getStatus() {
    return {
      name: this.name,
      state: this.isOpen() ? 'OPEN (lumpuh sementara)' : 'CLOSED (normal)',
      consecutiveFailures: this.failureCount,
      reopenAt: this.openedAt ? new Date(this.openedAt + this.cooldownMs).toISOString() : null
    };
  }
}

const bingWebBreaker = new CircuitBreaker('bing-web');
const bingImageBreaker = new CircuitBreaker('bing-images');
const bingNewsBreaker = new CircuitBreaker('bing-news');
const googleNewsRssBreaker = new CircuitBreaker('google-news-rss');

// Log terstruktur biar gampang di-grep/monitor di Railway logs.
// Kalau mau notifikasi aktif (Telegram/Discord webhook dll), panggil fungsi ini
// dan tambahkan pengiriman HTTP ke webhook kamu di sini.
function alertEcosystem(level, message, meta = {}) {
  const payload = { level, message, meta, timestamp: new Date().toISOString() };
  console.error(`[ALERT:${level}]`, JSON.stringify(payload));
  // TODO opsional: kirim ke webhook Discord/Telegram/Slack di sini
  // axios.post(process.env.ALERT_WEBHOOK_URL, {...}).catch(() => {});
}

// ==========================================
// 1. SCRAPER WEB (Bing Search) — dengan circuit breaker
// ==========================================
async function fetchWebResults(query, config, limit, offset) {
  if (bingWebBreaker.isOpen()) {
    throw new Error('CIRCUIT_OPEN: Sumber web sedang di-cooldown karena gagal berulang.');
  }

  try {
    const items = [];
    const firstIndex = offset > 0 ? offset + 1 : 1;
    const bingWebUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=${config.mkt}&setlang=${config.hl}&first=${firstIndex}`;

    const res = await axios.get(bingWebUrl, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': `${config.hl}-${config.gl.toUpperCase()},${config.hl};q=0.9`,
        'Referer': 'https://www.bing.com/'
      },
      timeout: 9000
    });

    const html = res.data;
    if (html.includes('geetest') || html.includes('verify') || html.includes('cf-browser-verification')) {
      throw new Error('BLOCKED_CAPTCHA: Bing mendeteksi bot/minta verifikasi Captcha.');
    }

    const $ = cheerio.load(html);

    $('li.b_algo').each((_, el) => {
      if (items.length >= limit) return false;

      const titleEl = $(el).find('h2 a').first();
      const snippetEl = $(el).find('div.b_caption p, p.b_lineclamp').first();

      const title = titleEl.text().trim();
      const link = titleEl.attr('href');
      const snippet = snippetEl.text().trim();

      if (title && link && link.startsWith('http')) {
        let domain = '';
        try { domain = new URL(link).hostname.replace(/^www\./, ''); } catch (e) {}

        items.push({
          title, link,
          snippet: snippet || 'Tidak ada deskripsi.',
          domain,
          position: offset + items.length + 1
        });
      }
    });

    if (items.length === 0) throw new Error('EMPTY_RESULT: Selector mungkin sudah berubah, 0 item ditemukan.');

    bingWebBreaker.recordSuccess();
    return items;
  } catch (err) {
    bingWebBreaker.recordFailure();
    if (bingWebBreaker.isOpen()) {
      alertEcosystem('CRITICAL', 'Sumber web (Bing) kemungkinan lumpuh / HTML berubah', { error: err.message });
    }
    throw err;
  }
}

// ==========================================
// 2. SCRAPER GAMBAR (Bing Images) — dengan circuit breaker
// ==========================================
// Helper cookie khusus Bing Images agar pencarian tidak di-redirect ke fallback/poisoned content
function buildBingImageCookies(config) {
  const region = config.gl.toUpperCase();
  const lang = config.hl;
  return `_EDGE_CD=m=${region}&u=${lang}; _EDGE_S=mkt=${region}&ui=${lang}; SRCHHPGUSR=SRCHLANG=${lang};`;
}

// ==========================================
// 2. SCRAPER GAMBAR (Bing Images) — Fixed Poisoning Defense
// ==========================================
async function fetchImages(query, config, limit, offset) {
  if (bingImageBreaker.isOpen()) {
    throw new Error('CIRCUIT_OPEN: Sumber gambar sedang di-cooldown karena gagal berulang.');
  }

  try {
    const images = [];
    const firstIndex = offset > 0 ? offset + 1 : 1;
    const fetchCount = Math.max(limit, 20);
    
    // Gunakan URL Bing Images dengan parameter query yang bersih
    const bingImgUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=${firstIndex}&count=${fetchCount}`;

    const res = await axios.get(bingImgUrl, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': `${config.hl}-${config.gl.toUpperCase()},${config.hl};q=0.9`,
        'Referer': `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`,
        'Cookie': buildBingImageCookies(config) // <-- KUNCI PERBAIKAN: Kirim Cookie sintetis
      },
      timeout: 9000
    });

    const html = res.data;
    if (html.includes('geetest') || html.includes('verify') || html.includes('cf-browser-verification')) {
      throw new Error('BLOCKED_CAPTCHA: Request Gambar diblokir oleh sistem verifikasi Bing.');
    }

    const $ = cheerio.load(html);

    // Ambil hanya dari kontainer utama hasil pencarian `#mmComponent_images_1` 
    // jika kontainer ada, untuk menghindari gambar promo/sidebar.
    const container = $('#mmComponent_images_1').length ? $('#mmComponent_images_1') : $('body');

    container.find('a.iusc, div.iuscp a').each((_, el) => {
      if (images.length >= limit) return false;
      const mAttr = $(el).attr('m');
      if (mAttr) {
        try {
          const mData = JSON.parse(mAttr);
          const imageUrl = mData.murl;
          const thumbnailUrl = mData.turl;
          const title = mData.t || mData.desc || query;
          const targetLink = mData.purl;

          if (imageUrl && imageUrl.startsWith('http')) {
            let domain = '';
            try { domain = new URL(targetLink || imageUrl).hostname.replace(/^www\./, ''); } catch (e) {}

            images.push({
              title, 
              image: imageUrl, 
              imageUrl,
              thumbnail: thumbnailUrl || imageUrl,
              thumbnailUrl: thumbnailUrl || imageUrl,
              width: mData.mw || 0, 
              height: mData.mh || 0,
              imageWidth: mData.mw || 0, 
              imageHeight: mData.mh || 0,
              source: domain || 'bing', 
              domain: domain || 'bing',
              pageUrl: targetLink || imageUrl, 
              link: targetLink || imageUrl,
              position: offset + images.length + 1
            });
          }
        } catch (e) {}
      }
    });

    // Fallback regex jika selector DOM utama tidak mengembalikan apapun
    if (images.length === 0) {
      const regex = /&quot;murl&quot;:&quot;(.*?)&quot;.*?&quot;turl&quot;:&quot;(.*?)&quot;.*?&quot;t&quot;:&quot;(.*?)&quot;/g;
      let match;
      while ((match = regex.exec(html)) !== null && images.length < limit) {
        const imageUrl = match[1];
        const thumbnailUrl = match[2];
        const title = match[3];
        if (imageUrl && imageUrl.startsWith('http')) {
          images.push({
            title: title || query, 
            image: imageUrl, 
            imageUrl,
            thumbnail: thumbnailUrl || imageUrl, 
            thumbnailUrl: thumbnailUrl || imageUrl,
            source: 'bing', 
            domain: 'bing.com',
            pageUrl: imageUrl, 
            link: imageUrl,
            position: offset + images.length + 1
          });
        }
      }
    }

    if (images.length === 0) throw new Error('EMPTY_RESULT: Selector & regex fallback gambar sama-sama gagal.');

    bingImageBreaker.recordSuccess();
    return images;
  } catch (err) {
    bingImageBreaker.recordFailure();
    if (bingImageBreaker.isOpen()) {
      alertEcosystem('CRITICAL', 'Sumber gambar (Bing) kemungkinan lumpuh / HTML berubah', { error: err.message });
    }
    throw err;
  }
}


// ==========================================
// 3. SCRAPER BERITA — Bing News (primer) + Google RSS (fallback)
// ==========================================

// Beberapa strategi selector berurutan untuk tiap elemen.
// Kalau Bing ubah 1 class, strategi berikutnya di array ini yang dicoba.
const NEWS_CARD_SELECTORS = ['div.news-card', 'div.t_s', '.newsitem', 'div[class*="news-card"]'];

function tryFindNewsCards($) {
  for (const sel of NEWS_CARD_SELECTORS) {
    const found = $(sel);
    if (found.length > 0) return found;
  }
  return $(); // kosong kalau semua strategi gagal
}

function extractTitleAndLink($, el) {
  const strategies = ['a.title', 'a[href].title', '.title a', 'a'];
  for (const sel of strategies) {
    const cand = $(el).find(sel).first();
    const t = cand.text().trim();
    const l = cand.attr('href');
    if (t && l && l.startsWith('http')) return { title: t, link: l };
  }
  return { title: '', link: '' };
}

function extractThumbnail($, el) {
  const strategies = [
    () => $(el).find('img.rms_img').first().attr('src'),
    () => $(el).find('.imgpr img').first().attr('src'),
    () => $(el).find('img').first().attr('data-src'),
    () => $(el).find('img').first().attr('src')
  ];
  for (const strat of strategies) {
    let src = strat();
    if (src) {
      if (src.startsWith('//')) src = `https:${src}`;
      if (src.startsWith('http')) return src;
    }
  }
  return null;
}

// ==========================================
// 3. SCRAPER BERITA — Bing News (selector asli, terverifikasi dari
//    struktur endpoint infinitescrollajax milik Bing sendiri)
// ==========================================

function buildBingNewsCookies(config) {
  // Format cookie ini yang bikin Bing benar-benar mengembalikan
  // markup 'newsitem' lengkap dengan thumbnail sesuai market/bahasa.
  const region = config.gl.toUpperCase();
  const lang = config.hl;
  return `_EDGE_CD=m=${region}&u=${lang}; _EDGE_S=mkt=${region}&ui=${lang}`;
}

async function fetchNewsViaBing(query, config, limit, offset) {
  if (bingNewsBreaker.isOpen()) {
    throw new Error('CIRCUIT_OPEN: Sumber berita Bing sedang di-cooldown.');
  }

  try {
    const newsItems = [];
    const first = offset > 0 ? offset + 1 : 1;

    // Endpoint AJAX asli Bing News — bukan /news/search biasa
    const bingNewsUrl = `https://www.bing.com/news/infinitescrollajax?q=${encodeURIComponent(query)}&InfiniteScroll=1&first=${first}`;

    const res = await axios.get(bingNewsUrl, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': `${config.hl}-${config.gl.toUpperCase()},${config.hl};q=0.9`,
        'Referer': 'https://www.bing.com/news',
        'Cookie': buildBingNewsCookies(config)   // <-- kunci yang tadinya hilang
      },
      timeout: 9000
    });

    const html = res.data;
    if (html.includes('geetest') || html.includes('verify') || html.includes('cf-browser-verification')) {
      throw new Error('BLOCKED_CAPTCHA: Bing News mendeteksi bot/minta verifikasi Captcha.');
    }

    const $ = cheerio.load(html);

    // Selector utama — sesuai struktur asli Bing (class mengandung "newsitem")
    let cards = $('div[class*="newsitem"]');

    // Fallback kalau Bing sedikit ubah nama class tapi struktur intinya sama
    if (cards.length === 0) {
      cards = $('[url][class*="news"]'); // elemen apapun yang punya atribut url + class news
    }

    cards.each((_, el) => {
      if (newsItems.length >= limit) return false;

      const $el = $(el);

      // URL ada di ATRIBUT elemen, bukan di dalam <a href>
      const link = $el.attr('url') || $el.find('a.title').first().attr('href');
      const title = $el.find('.caption a.title, a.title').first().text().trim();

      if (!title || !link || !link.startsWith('http')) return; // skip item cacat

      const snippet = $el.find('.snippet').first().text().trim();

      // Metadata source biasanya berisi "Nama Media · 2 jam lalu"
      const sourceSpans = $el.find('.source span');
      const metadataText = sourceSpans.map((i, s) => $(s).text().trim()).get().join(' · ');
      const publisher = sourceSpans.first().text().trim();

      // Thumbnail: src ada di dalam a.imagelink img, formatnya path relatif
      let thumbnail = null;
      const imgSrc = $el.find('a.imagelink img').first().attr('src');
      if (imgSrc) {
        if (imgSrc.startsWith('http')) {
          thumbnail = imgSrc;
        } else {
          // gabungkan dengan domain Bing, hindari double-slash
          thumbnail = `https://www.bing.com${imgSrc.startsWith('/') ? '' : '/'}${imgSrc}`;
        }
      }

      let domain = '';
      try { domain = new URL(link).hostname.replace(/^www\./, ''); } catch (e) {}

      newsItems.push({
        title,
        link,
        snippet: snippet || 'Tidak ada deskripsi.',
        publisher: publisher || domain || 'Berita',
        domain,
        thumbnailUrl: thumbnail,
        publishedAt: metadataText || null,
        position: offset + newsItems.length + 1
      });
    });

    if (newsItems.length === 0) throw new Error('EMPTY_RESULT: Struktur newsitem tidak ditemukan, kemungkinan Bing ubah markup lagi.');

    bingNewsBreaker.recordSuccess();
    return newsItems;
  } catch (err) {
    bingNewsBreaker.recordFailure();
    if (bingNewsBreaker.isOpen()) {
      alertEcosystem('CRITICAL', 'Sumber berita Bing kemungkinan lumpuh / HTML berubah', { error: err.message });
    }
    throw err;
  }
}
async function fetchNewsViaGoogleRss(query, config, limit, offset) {
  if (googleNewsRssBreaker.isOpen()) {
    throw new Error('CIRCUIT_OPEN: Fallback Google News RSS sedang di-cooldown.');
  }

  try {
    const newsItems = [];
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${config.hl}-${config.gl.toUpperCase()}&gl=${config.gl.toUpperCase()}&ceid=${config.gl.toUpperCase()}:${config.hl}`;

    const feed = await rssParser.parseURL(rssUrl);
    const rawItems = feed.items || [];
    const pagedItems = rawItems.slice(offset, offset + limit);

    if (pagedItems.length === 0) throw new Error('EMPTY_RESULT: RSS Google News kosong.');

    for (let i = 0; i < pagedItems.length; i++) {
      const item = pagedItems[i];
      if (!item.title || !item.link) continue; // skip item cacat

      let thumbnail = null;
      if (item.mediaThumbnail?.$?.url) thumbnail = item.mediaThumbnail.$.url;
      else if (item.mediaContent?.$?.url) thumbnail = item.mediaContent.$.url;
      else thumbnail = extractImageFromHtml(item.content || item.snippet || item.summary);

      let sourceName = item.source || 'Berita';
      if (typeof sourceName === 'object' && sourceName._) sourceName = sourceName._;

      let domain = '';
      try { domain = new URL(item.link).hostname.replace(/^www\./, ''); } catch (e) {}

      const cleanSnippet = item.contentSnippet || (item.content ? cheerio.load(item.content).text() : '');

      newsItems.push({
        title: item.title.replace(/ - [^-]+$/, ''),
        link: item.link, // catatan: ini masih URL redirect Google, bukan URL asli situs
        snippet: cleanSnippet.trim(),
        publisher: sourceName,
        domain,
        thumbnailUrl: thumbnail, // biasanya null, RSS jarang punya gambar
        publishedAt: item.pubDate || item.isoDate || null,
        position: offset + newsItems.length + 1,
        _isFallbackSource: true // penanda internal: dari fallback, bukan sumber utama
      });
    }

    if (newsItems.length === 0) throw new Error('EMPTY_RESULT: Semua item RSS cacat/kosong setelah filter.');

    googleNewsRssBreaker.recordSuccess();
    return newsItems;
  } catch (err) {
    googleNewsRssBreaker.recordFailure();
    if (googleNewsRssBreaker.isOpen()) {
      alertEcosystem('CRITICAL', 'Fallback Google News RSS JUGA lumpuh — semua sumber berita down!', { error: err.message });
    }
    throw err;
  }
}

// Orkestrator: coba Bing dulu, kalau gagal baru Google RSS.
// Kalau DUA-DUANYA gagal, baru API return error ke client (bukan diam-diam kosong).
async function fetchNews(query, config, limit, offset) {
  try {
    return await fetchNewsViaBing(query, config, limit, offset);
  } catch (bingErr) {
    console.warn(`[FALLBACK] Bing News gagal ("${bingErr.message}"), mencoba Google News RSS...`);
    try {
      return await fetchNewsViaGoogleRss(query, config, limit, offset);
    } catch (rssErr) {
      // Dua-duanya gagal — ini yang benar-benar harus diketahui ekosistem kamu
      alertEcosystem('FATAL', 'Semua sumber berita (Bing + Google RSS) gagal total', {
        bingError: bingErr.message,
        rssError: rssErr.message,
        query
      });
      throw new Error(`ALL_NEWS_SOURCES_FAILED: Bing(${bingErr.message}) | RSS(${rssErr.message})`);
    }
  }
}

// ==========================================
// HEALTH CHECK — supaya kamu tahu duluan, bukan user
// ==========================================
app.get('/api/health', (req, res) => {
  const breakers = [bingWebBreaker, bingImageBreaker, bingNewsBreaker, googleNewsRssBreaker];
  const statuses = breakers.map(b => b.getStatus());
  const anyOpen = statuses.some(s => s.state.startsWith('OPEN'));

  res.status(anyOpen ? 503 : 200).json({
    status: anyOpen ? 'degraded' : 'healthy',
    breakers: statuses,
    timestamp: new Date().toISOString()
  });
});

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

  let defaultLimit = 10;
  if (searchType === 'images') defaultLimit = 20;
  if (searchType === 'news') defaultLimit = 15;

  const limit = parseInt(req.query.num, 10) || defaultLimit;

  let offset = parseInt(req.query.start, 10) || 0;
  if (!req.query.start && req.query.page) {
    const page = parseInt(req.query.page, 10) || 1;
    offset = (page - 1) * limit;
  }

  const config = resolveLanguageConfig(req.query, req.headers['accept-language']);
  const cacheKey = `${searchType}_${query.toLowerCase().trim()}_${config.hl}_${config.gl}_${limit}_start${offset}`;

  if (cache.has(cacheKey)) {
    const cachedData = cache.get(cacheKey);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      return res.json(cachedData.data);
    }
  }

  try {
    let results = [];

    if (searchType === 'images') {
      results = await fetchImages(query, config, limit, offset);
    } else if (searchType === 'news') {
      results = await fetchNews(query, config, limit, offset);
    } else {
      results = await fetchWebResults(query, config, limit, offset);
    }

    if (results.length === 0) {
      return res.status(502).json({
        status: 'error',
        message: 'Hasil pencarian kosong. IP Server hosting kemungkinan diblokir oleh Bing / HTML berubah.',
        searchParameters: { q: query, type: searchType, start: offset }
      });
    }

    const searchTime = ((Date.now() - startTime) / 1000).toFixed(2);

    const responsePayload = {
      status: 'success',
      searchParameters: {
        q: query, type: searchType, hl: config.hl, gl: config.gl,
        num: limit, start: offset, page: Math.floor(offset / limit) + 1
      },
      searchInformation: {
        formattedSearchTime: searchTime,
        totalResults: results.length
      },
      results,
      images: searchType === 'images' ? results : undefined,
      items: searchType === 'search' ? results : undefined,
      news: searchType === 'news' ? results : undefined
    };

    cache.set(cacheKey, { timestamp: Date.now(), data: responsePayload });
    return res.json(responsePayload);

  } catch (error) {
    console.error(`[API ERROR] Type=${searchType}:`, error.message);

    let statusCode = 500;
    let customMessage = 'Terjadi kesalahan pada server backend.';

    if (error.message.startsWith('CIRCUIT_OPEN')) {
      statusCode = 503;
      customMessage = 'Sumber data sedang dalam mode pemulihan otomatis (circuit breaker). Coba lagi dalam beberapa menit.';
    } else if (error.message.startsWith('ALL_NEWS_SOURCES_FAILED')) {
      statusCode = 502;
      customMessage = 'Semua sumber berita (primer & fallback) gagal. Tim sudah diberi notifikasi otomatis.';
    } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      statusCode = 504;
      customMessage = 'Koneksi timeout ke mesin pencari Bing/Google. Jaringan lambat/terputus.';
    } else if (error.message.includes('BLOCKED_CAPTCHA')) {
      statusCode = 429;
      customMessage = 'IP Server Railway terdeteksi bot/terblokir Captcha oleh Bing.';
    } else if (error.response) {
      statusCode = error.response.status;
      customMessage = `Penyedia pencarian mengembalikan status error ${error.response.status}.`;
    }

    return res.status(statusCode).json({
      status: 'error',
      message: customMessage,
      error_detail: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server API berjalan di http://localhost:${PORT}`);
});
