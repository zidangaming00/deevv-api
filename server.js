import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import NodeCache from 'node-cache';
import LanguageDetect from 'languagedetect';

const app = express();
const PORT = process.env.PORT || 3000;

const lngDetector = new LanguageDetect();
const myCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// Helper: Dekode Redirect URL Bing (&u=a1...)
function decodeBingUrl(bingUrl) {
  if (!bingUrl) return '';
  if (bingUrl.includes('&u=a1')) {
    try {
      const match = bingUrl.match(/&u=a1([^&]+)/);
      if (match && match[1]) {
        let base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        return Buffer.from(base64, 'base64').toString('utf-8');
      }
    } catch (e) {
      return bingUrl;
    }
  }
  return bingUrl;
}

// Helper: Penentuan Bahasa & Wilayah Dinamis
function resolveLanguageConfig(reqQuery, acceptLanguageHeader) {
  // 1. Jika dikirim eksplisit via query param, utamakan param tersebut
  if (reqQuery.hl || reqQuery.gl) {
    const hl = (reqQuery.hl || 'en').toLowerCase();
    const gl = (reqQuery.gl || (hl === 'id' ? 'id' : 'us')).toLowerCase();
    return { hl, gl, mkt: `${hl}-${gl.toUpperCase()}` };
  }

  const query = (reqQuery.q || '').trim();
  const words = query.split(/\s+/);

  // 2. Kueri 1 kata netral (misal: "Minecraft", "Indonesia") di-fallback ke Global (en-US)
  if (words.length === 1) {
    return { hl: 'en', gl: 'us', mkt: 'en-US' };
  }

  // 3. Hanya set ke ID jika terdeteksi kuat Bahasa Indonesia pada kueri multi-kata
  const detected = lngDetector.detect(query, 1);
  const detectedLang = detected.length > 0 ? detected[0][0].toLowerCase() : '';

  if (detectedLang === 'indonesian') {
    return { hl: 'id', gl: 'id', mkt: 'id-ID' };
  }

  // Fallback default jika header mengandung ID dan kueri multi-kata
  if (acceptLanguageHeader && acceptLanguageHeader.includes('id')) {
    return { hl: 'id', gl: 'id', mkt: 'id-ID' };
  }

  return { hl: 'en', gl: 'us', mkt: 'en-US' };
}

// Handler Khusus Scraping Gambar dengan Ekstraksi Dimensi Multi-Source
async function fetchImages(query, config, limit, headers) {
  const images = [];
  const fetchCount = Math.max(limit, 20);
  const bingImgUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&setmkt=${config.mkt}&setlang=${config.hl}&count=${fetchCount}&first=1`;

  const res = await axios.get(bingImgUrl, { headers, timeout: 8000 });
  const $ = cheerio.load(res.data);

  $('a.iusc').each((_, el) => {
    if (images.length >= limit) return false;

    try {
      const rawMData = $(el).attr('m');
      if (!rawMData) return;

      const mData = JSON.parse(rawMData);
      const imageUrl = mData.murl;
      const targetLink = mData.purl || mData.murl;

      if (!imageUrl) return;

      // 1. Ambil Dimensi Gambar Utama
      let imageWidth = parseInt(mData.mw || mData.w, 10) || null;
      let imageHeight = parseInt(mData.mh || mData.h, 10) || null;

      if (!imageWidth || !imageHeight) {
        const dimAttr = $(el).attr('data-dim') || $(el).parent().find('.imgpt, .infobadge, .b_dataText').text();
        if (dimAttr) {
          const match = dimAttr.match(/(\d+)\s*[\|x×:]\s*(\d+)/i);
          if (match) {
            imageWidth = parseInt(match[1], 10);
            imageHeight = parseInt(match[2], 10);
          }
        }
      }

      // 2. Ambil Dimensi Thumbnail
      let thumbnailWidth = parseInt(mData.tw || mData.twid, 10) || null;
      let thumbnailHeight = parseInt(mData.th || mData.thid, 10) || null;

      if (mData.turl && (!thumbnailWidth || !thumbnailHeight)) {
        const wMatch = mData.turl.match(/[?&]w=(\d+)/);
        const hMatch = mData.turl.match(/[?&]h=(\d+)/);
        if (wMatch) thumbnailWidth = parseInt(wMatch[1], 10);
        if (hMatch) thumbnailHeight = parseInt(hMatch[2], 10);
      }

      let domain = '';
      try {
        domain = new URL(targetLink).hostname;
      } catch (e) {
        domain = '';
      }

      images.push({
        title: mData.t || query,
        imageUrl,
        imageWidth,
        imageHeight,
        thumbnailUrl: mData.turl || imageUrl,
        thumbnailWidth,
        thumbnailHeight,
        source: domain ? domain.replace(/^www\./, '') : 'unknown',
        domain: domain || 'unknown',
        link: targetLink,
        googleUrl: `https://www.google.com/imgres?imgurl=${encodeURIComponent(imageUrl)}`,
        position: images.length + 1
      });
    } catch (e) {
      // Abaikan node jika gagal diparsing
    }
  });

  return images;
}

// Main API Route
app.get('/api/search', async (req, res) => {
  const startTime = Date.now();
  const query = req.query.q;
  const searchType = (req.query.type || 'search').toLowerCase();
  
  const defaultLimit = searchType === 'images' ? 20 : 10;
  const limit = parseInt(req.query.num, 10) || defaultLimit;

  if (!query) {
    return res.status(400).json({ status: 'error', message: 'Parameter "q" wajib diisi.' });
  }

  const config = resolveLanguageConfig(req.query, req.headers['accept-language']);
  const cacheKey = `${searchType}_${query.toLowerCase().trim()}_${config.hl}_${config.gl}_${limit}`;

  const cachedData = myCache.get(cacheKey);
  if (cachedData) {
    return res.json({ ...cachedData, cached: true });
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': `${config.hl}-${config.gl.toUpperCase()},${config.hl};q=0.9`,
    'Cookie': 'SRCHHPGUSR=PR=1&ADLT=OFF&NRSLT=50; MUID=1234567890;'
  };

  try {
    const responsePayload = {
      searchParameters: {
        q: query,
        type: searchType,
        engine: searchType === 'images' ? 'bing_images' : 'bing',
        gl: config.gl,
        hl: config.hl,
        num: limit
      }
    };

    // 1. MODE: IMAGES ONLY
    if (searchType === 'images') {
      responsePayload.images = await fetchImages(query, config, limit, headers);
    }

    // 2. MODE: NEWS ONLY
    else if (searchType === 'news') {
      const newsRes = await axios.get(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&setmkt=${config.mkt}`, { headers, timeout: 8000 });
      const $ = cheerio.load(newsRes.data);
      const news = [];

      $('.news-card, .newsitem').slice(0, limit).each((idx, el) => {
        const titleEl = $(el).find('a.title');
        const title = titleEl.text().trim();
        const link = decodeBingUrl(titleEl.attr('href'));
        const source = $(el).find('.source, .provider').text().trim();
        const snippet = $(el).find('.snippet, .caption').text().trim();
        const date = $(el).find('span[aria-label], .time').text().trim();

        if (title && link) {
          news.push({ position: idx + 1, title, link, snippet, source, date });
        }
      });

      responsePayload.news = news;
    }

    // 3. MODE: SEARCH DEFAULT (Organik Only)
    else {
      const webRes = await axios.get(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=${config.mkt}&setlang=${config.hl}`, { headers, timeout: 8000 });
      const $ = cheerio.load(webRes.data);

      const organic = [];
      let instantAnswer = null;
      const relatedSearches = [];

      const answerNode = $('.b_ans, .b_entityTP, .b_promowidget, .b_rich').first();
      if (answerNode.length) {
        const title = answerNode.find('h2, .b_entityTitle, .b_focusTextExtra').first().text().trim();
        const snippet = answerNode.find('.b_caption, .b_entityDesc, .rwrl, .b_focusTextMedium').first().text().trim();
        if (title || snippet) instantAnswer = { title, snippet };
      }

      $('#b_results .b_algo').slice(0, limit).each((_, element) => {
        const titleEl = $(element).find('h2 a');
        const snippetEl = $(element).find('.b_caption p, .b_algoDesc, .b_lineclamp2');

        const title = titleEl.text().trim();
        const directLink = decodeBingUrl(titleEl.attr('href'));
        const snippet = snippetEl.text().trim();

        let favicon = null;
        if (directLink) {
          try {
            const domain = new URL(directLink).hostname;
            favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
          } catch (e) {}
        }

        if (title && directLink) {
          organic.push({
            position: organic.length + 1,
            title,
            link: directLink,
            favicon,
            snippet: snippet || 'Deskripsi tidak tersedia.'
          });
        }
      });

      $('.b_rs a, #b_results .b_vList li a').each((_, el) => {
        const text = $(el).text().trim();
        if (text && !relatedSearches.includes(text)) relatedSearches.push(text);
      });

      if (instantAnswer) responsePayload.instantAnswer = instantAnswer;
      responsePayload.organic = organic;
      responsePayload.relatedSearches = relatedSearches;
    }

    responsePayload.credits = 1;
    responsePayload.duration = `${Date.now() - startTime}ms`;

    myCache.set(cacheKey, responsePayload);
    return res.json({ ...responsePayload, cached: false });

  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
