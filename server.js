import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import NodeCache from 'node-cache';
import LanguageDetect from 'languagedetect';

const app = express();
const PORT = process.env.PORT || 3000;

const lngDetector = new LanguageDetect();
const myCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// Helper: Dekode Redirect URL Bing
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

// Deteksi Bahasa & Wilayah Dinamis
function resolveLanguageConfig(reqQuery, acceptLanguageHeader) {
  if (reqQuery.hl) {
    const hl = reqQuery.hl.toLowerCase();
    const gl = (reqQuery.gl || (hl === 'id' ? 'id' : 'us')).toLowerCase();
    return { hl, gl, mkt: `${hl}-${gl.toUpperCase()}` };
  }

  const detected = lngDetector.detect(reqQuery.q, 1);
  const detectedLang = detected.length > 0 ? detected[0][0].toLowerCase() : '';

  if (detectedLang === 'indonesian' || (acceptLanguageHeader && acceptLanguageHeader.includes('id'))) {
    return { hl: 'id', gl: 'id', mkt: 'id-ID' };
  }

  return { hl: 'en', gl: 'us', mkt: 'en-US' };
}

app.get('/api/search', async (req, res) => {
  const startTime = Date.now();
  const query = req.query.q;
  const searchType = (req.query.type || 'search').toLowerCase(); // 'search', 'images', atau 'news'
  const limit = parseInt(req.query.num) || 10;

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
    'Cookie': 'SRCHHPGUSR=PR=1&ADLT=OFF&NRSLT=10; MUID=1234567890;'
  };

  try {
    const responsePayload = {
      searchParameters: {
        q: query,
        type: searchType,
        engine: searchType === 'images' ? 'google_images' : 'bing',
        gl: config.gl,
        hl: config.hl,
        num: limit
      }
    };

    // ==========================================
    // 1. MODE: GOOGLE IMAGES (tbm=isch)
    // ==========================================
    if (searchType === 'images') {
      const googleImgUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&gl=${config.gl}&hl=${config.hl}`;
      const imgRes = await axios.get(googleImgUrl, { headers, timeout: 8000 });
      const $ = cheerio.load(imgRes.value ? imgRes.value.data : imgRes.data);
      
      const images = [];
      
      // Extraction JSON Script Data yang di-inject Google Images
      const scripts = $('script').toArray();
      for (const script of scripts) {
        const content = $(script).html() || '';
        if (content.includes('AF_initDataCallback') && content.includes('thumbnailUrl')) {
          // Parsing fallback via regex visual element
        }
      }

      // Parsing Standar DOM / Meta Bing & Google Images Fallback
      $('table.M4A3ed, .rg_i, img.DS19ne, .islrc div.v4g3de').slice(0, limit).each((idx, el) => {
        const imgEl = $(el).find('img');
        const src = imgEl.attr('src') || imgEl.attr('data-src');
        if (src && src.startsWith('http')) {
          images.push({
            title: $(el).find('span').text().trim() || query,
            imageUrl: src,
            thumbnailUrl: src,
            source: 'Google Images',
            domain: 'google.com',
            link: `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch`,
            position: idx + 1
          });
        }
      });

      // Jika Google memblokir IP Cloud, Fallback Parsing Murni Bing Images dengan Metadata Lengkap
      if (images.length === 0) {
        const bingImgRes = await axios.get(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&setmkt=${config.mkt}`, { headers, timeout: 8000 });
        const $b = cheerio.load(bingImgRes.data);$b('a.iusc').slice(0, limit).each((idx, el) => {
          try {
            const mData = JSON.parse($b(el).attr('m') || '{}');
            if (mData.murl) {
              let domainName = '';
              try { domainName = new URL(mData.purl || mData.murl).hostname; } catch(e){}

              images.push({
                title: mData.t || query,
                imageUrl: mData.murl,
                imageWidth: mData.mw || null,
                imageHeight: mData.mh || null,
                thumbnailUrl: mData.turl || mData.murl,
                source: domainName.replace('www.', ''),
                domain: domainName,
                link: mData.purl || mData.murl,
                googleUrl: `https://www.google.com/imgres?imgurl=${encodeURIComponent(mData.murl)}`,
                position: idx + 1
              });
            }
          } catch (e) {}
        });
      }

      responsePayload.images = images;
    } 

    // ==========================================
    // 2. MODE: NEWS ONLY
    // ==========================================
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

    // ==========================================
    // 3. MODE: SEARCH DEFAULT (Organik Only)
    // ==========================================
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

    // Tambahkan Metrik Performa
    responsePayload.credits = 1;
    responsePayload.duration = `${Date.now() - startTime}ms`;

    myCache.set(cacheKey, responsePayload);
    return res.json({ ...responsePayload, cached: false });

  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
