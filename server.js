import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import NodeCache from 'node-cache';
import LanguageDetect from 'languagedetect';

const app = express();
const PORT = process.env.PORT || 3000;

const lngDetector = new LanguageDetect();
const myCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// Helper: Decode Redirect URL Bing
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

// Deteksi Bahasa Dinamis menggunakan Statistical Model
function resolveLanguageConfig(reqQuery, acceptLanguageHeader) {
  // 1. Opsi A: Jika Klien Mengirimkan Parameter Lang Secara Eksplisit (/api/search?q=...&lang=id)
  if (reqQuery.lang) {
    const customLang = reqQuery.lang.toLowerCase();
    return {
      lang: customLang,
      mkt: customLang === 'id' ? 'id-ID' : 'en-US',
      acceptLang: customLang === 'id' ? 'id-ID,id;q=0.9' : 'en-US,en;q=0.9'
    };
  }

  // 2. Opsi B: Statistical N-Gram Language Detection pada Query
  const detected = lngDetector.detect(reqQuery.q, 1); // Ambil 1 hasil teratas
  const detectedLang = detected.length > 0 ? detected[0][0].toLowerCase() : '';

  if (detectedLang === 'indonesian') {
    return {
      lang: 'id',
      mkt: 'id-ID',
      acceptLang: 'id-ID,id;q=0.9,en-US;q=0.8'
    };
  }

  // 3. Opsi C: Fallback ke Header Accept-Language dari Pengguna jika Bahasa Tidak Terdeteksi
  if (acceptLanguageHeader && acceptLanguageHeader.includes('id')) {
    return {
      lang: 'id',
      mkt: 'id-ID',
      acceptLang: acceptLanguageHeader
    };
  }

  // Default Fallback Global/English
  return {
    lang: 'en',
    mkt: 'en-US',
    acceptLang: 'en-US,en;q=0.9'
  };
}

app.get('/api/search', async (req, res) => {
  const query = req.query.q;

  if (!query) {
    return res.status(400).json({ status: 'error', message: 'Parameter "q" wajib diisi.' });
  }

  const cacheKey = `${query.toLowerCase().trim()}_${req.query.lang || 'auto'}`;
  const cachedData = myCache.get(cacheKey);
  if (cachedData) {
    return res.json({ ...cachedData, cached: true });
  }

  // Deteksi Konfigurasi Bahasa Tanpa Hardcode
  const config = resolveLanguageConfig(req.query, req.headers['accept-language']);

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': config.acceptLang,
      'Cookie': 'SRCHHPGUSR=PR=1&ADLT=OFF&NRSLT=10; MUID=1234567890;'
    };

    const [webRes, newsRes, imgRes] = await Promise.allSettled([
      axios.get(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=${config.mkt}&setlang=${config.lang}`, { headers, timeout: 8000 }),
      axios.get(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${config.lang}&gl=${config.lang.toUpperCase()}&ceid=${config.lang.toUpperCase()}:${config.lang}`, { timeout: 8000 }),
      axios.get(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&setmkt=${config.mkt}`, { headers, timeout: 8000 })
    ]);

    const organicResults = [];
    let instantAnswer = null;
    const relatedSearches = [];

    if (webRes.status === 'fulfilled') {
      const $ = cheerio.load(webRes.value.data);

      const answerNode = $('.b_ans, .b_entityTP, .b_promowidget, .b_rich').first();
      if (answerNode.length) {
        const title = answerNode.find('h2, .b_entityTitle, .b_focusTextExtra').first().text().trim();
        const snippet = answerNode.find('.b_caption, .b_entityDesc, .rwrl, .b_focusTextMedium').first().text().trim();
        if (title || snippet) instantAnswer = { title, snippet };
      }

      $('#b_results .b_algo').each((_, element) => {
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
          organicResults.push({
            position: organicResults.length + 1,
            title,
            link: directLink,
            favicon,
            snippet: snippet || 'Deskripsi tidak tersedia.'
          });
        }
      });

      $('.b_rs a, #b_results .b_vList li a, .b_ans .b_rs li a').each((_, el) => {
        const text = $(el).text().trim();
        if (text && !relatedSearches.includes(text)) relatedSearches.push(text);
      });
    }

    const newsResults = [];
    if (newsRes.status === 'fulfilled') {
      const $news = cheerio.load(newsRes.value.data, { xmlMode: true });$news('item').slice(0, 5).each((_, el) => {
        const title = $news(el).find('title').text().trim();
        const link = $news(el).find('link').text().trim();
        const pubDate = $news(el).find('pubDate').text().trim();
        const source = $news(el).find('source').text().trim();

        if (title && link) newsResults.push({ title, link, pubDate, source });
      });
    }

    const imagesResults = [];
    if (imgRes.status === 'fulfilled') {
      const $img = cheerio.load(imgRes.value.data);$img('a.iusc').slice(0, 6).each((_, el) => {
        try {
          const mData = JSON.parse($(el).attr('m') || '{}');
          if (mData.murl && mData.t) {
            imagesResults.push({
              title: mData.t,
              image_url: mData.murl,
              source_url: mData.purl
            });
          }
        } catch (e) {}
      });
    }

    const responseData = {
      status: 'success',
      query,
      active_language: config.lang,
      instant_answer: instantAnswer,
      news: newsResults,
      images: imagesResults,
      total_organic: organicResults.length,
      organic: organicResults,
      related_searches: relatedSearches
    };

    if (organicResults.length > 0) {
      myCache.set(cacheKey, responseData);
    }

    res.json({ ...responseData, cached: false });

  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
