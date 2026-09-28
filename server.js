import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import NodeCache from 'node-cache';

const app = express();
const PORT = process.env.PORT || 3000;

// Cache TTL 24 jam (86400 detik)
const myCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// Helper: Decode Bing Redirect URL
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

app.get('/api/search', async (req, res) => {
  const query = req.query.q;

  if (!query) {
    return res.status(400).json({
      status: 'error',
      message: 'Parameter "q" wajib diisi.'
    });
  }

  const cacheKey = query.toLowerCase().trim();

  // 1. Cek Cache
  const cachedData = myCache.get(cacheKey);
  if (cachedData) {
    return res.json({
      ...cachedData,
      cached: true
    });
  }

  try {
    const targetUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=id`;
    
    // PERBAIKAN UTAMA: Paksa Desktop View dengan User-Agent & Cookie Khusus
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cookie': 'SRCHHPGUSR=PR=1; MUID=1234567890;' // Mencegah Bing me-redirect ke m.bing.com
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);

    // A. Instant Answer / Entity Panel
    let instantAnswer = null;
    const answerNode = $('.b_ans, .b_entityTP, .b_promowidget, .b_rich').first();
    if (answerNode.length) {
      const title = answerNode.find('h2, .b_entityTitle, .b_focusTextExtra').first().text().trim();
      const snippet = answerNode.find('.b_caption, .b_entityDesc, .rwrl, .b_focusTextMedium').first().text().trim();
      if (title || snippet) {
        instantAnswer = { title, snippet };
      }
    }

    // B. Related Videos (Mencakup beberapa selector layout Bing)
    const videos = [];
    $('.b_videolist .mc_vtvc, .b_vlist li, .vcard, .b_vidCard').each((_, el) => {
      const vTitle = $(el).find('.mc_vtvc_title, .b_promtext, h8, .title').text().trim();
      const rawVLink = $(el).find('a').attr('href');
      const vLink = decodeBingUrl(rawVLink);
      
      if (vTitle && vLink && !videos.some(v => v.link === vLink)) {
        videos.push({ title: vTitle, link: vLink });
      }
    });

    // C. Hasil Organik
    const organicResults = [];
    $('#b_results .b_algo').each((_, element) => {
      const titleEl = $(element).find('h2 a');
      const snippetEl = $(element).find('.b_caption p, .b_algoDesc, .b_lineclamp2');

      const title = titleEl.text().trim();
      const rawLink = titleEl.attr('href');
      const directLink = decodeBingUrl(rawLink);
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

    // D. Related Searches (Mencakup selector Desktop + Mobile)
    const relatedSearches = [];
    $('.b_rs a, #b_results .b_vList li a, .b_ans .b_rs li a, [data-tag="relatedsearch"] a').each((_, el) => {
      const text = $(el).text().trim();
      if (text && !relatedSearches.includes(text) && !text.toLowerCase().includes('selengkapnya')) {
        relatedSearches.push(text);
      }
    });

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

    // Simpan ke Cache 24 jam jika ada hasilnya
    if (organicResults.length > 0) {
      myCache.set(cacheKey, responseData);
    }

    res.json({
      ...responseData,
      cached: false
    });

  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Gagal melakukan scraping ke Bing.',
      error: error.message
    });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
