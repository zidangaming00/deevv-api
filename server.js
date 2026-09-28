import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import NodeCache from 'node-cache';

const app = express();
const PORT = process.env.PORT || 3000;

// Inisialisasi Cache dengan TTL 24 Jam (86400 detik)
const myCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// Helper Function: Decode URL Redirect Bing ke URL Domain Asli
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

// Endpoint Utama API Pencarian
app.get('/api/search', async (req, res) => {
  const query = req.query.q;

  if (!query) {
    return res.status(400).json({
      status: 'error',
      message: 'Parameter query "q" wajib diisi. Contoh: /api/search?q=minecraft'
    });
  }

  const cacheKey = query.toLowerCase().trim();

  // 1. CEK CACHE: Jika kata kunci pernah dicari dalam 24 jam terakhir
  const cachedData = myCache.get(cacheKey);
  if (cachedData) {
    return res.json({
      ...cachedData,
      cached: true // Penanda bahwa data disajikan dari memori cache
    });
  }

  // 2. SCRAPING BING: Jika belum ada di cache
  try {
    const targetUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=id`;
    
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);

    // A. Instant Answer / Knowledge Card
    let instantAnswer = null;
    const answerNode = $('.b_ans, .b_entityTP, .b_promowidget').first();
    if (answerNode.length) {
      const title = answerNode.find('h2, .b_entityTitle').first().text().trim();
      const snippet = answerNode.find('.b_caption, .b_entityDesc, .rwrl').first().text().trim();
      if (title || snippet) {
        instantAnswer = { title, snippet };
      }
    }

    // B. Related Videos
    const videos = [];
    $('.b_videolist .mc_vtvc, .b_vlist li, .vcard').each((_, el) => {
      const vTitle = $(el).find('.mc_vtvc_title, .b_promtext, h8').text().trim();
      const rawVLink = $(el).find('a').attr('href');
      const vLink = decodeBingUrl(rawVLink);
      
      if (vTitle && vLink) {
        videos.push({ title: vTitle, link: vLink });
      }
    });

    // C. Hasil Organik + Direct Link + Favicon
    const organicResults = [];
    $('#b_results .b_algo').each((_, element) => {
      const titleEl = $(element).find('h2 a');
      const snippetEl = $(element).find('.b_caption p, .b_algoDesc, .b_lineclamp2');

      const title = titleEl.text().trim();
      const rawLink = titleEl.attr('href');
      const directLink = decodeBingUrl(rawLink);
      const snippet = snippetEl.text().trim();

      // Dapatkan Favicon menggunakan domain asli
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

    // D. Related Searches
    const relatedSearches = [];
    $('.b_rs a, #b_results .b_vList li a').each((_, el) => {
      const text = $(el).text().trim();
      if (text && !relatedSearches.includes(text)) {
        relatedSearches.push(text);
      }
    });

    // Format Response JSON
    const responseData = {
      status: 'success',
      source: 'bing',
      query,
      instant_answer: instantAnswer,
      videos,
      total_results: organicResults.length,
      organic: organicResults,
      related_searches: relatedSearches
    };

    // 3. SIMPAN KE CACHE: Simpan respon ini selama 24 jam
    myCache.set(cacheKey, responseData);

    res.json({
      ...responseData,
      cached: false
    });

  } catch (error) {
    console.error('Scraping Error:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Gagal mengambil data dari Bing.',
      error: error.message
    });
  }
});

// Root Endpoint
app.get('/', (req, res) => {
  res.send('API Aktif! Gunakan endpoint /api/search?q=kata_kunci');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
