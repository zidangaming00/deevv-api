import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;

// Helper: Dekode URL Bing Redirect ke URL Asli
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
    return res.status(400).json({ status: 'error', message: 'Parameter "q" wajib diisi.' });
  }

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

    // 1. Instant Answer / Knowledge Box (Jika Ada)
    let instantAnswer = null;
    const answerNode = $('.b_ans, .b_entityTP, .b_promowidget').first();
    if (answerNode.length) {
      const title = answerNode.find('h2, .b_entityTitle').first().text().trim();
      const snippet = answerNode.find('.b_caption, .b_entityDesc, .rwrl').first().text().trim();
      if (title || snippet) {
        instantAnswer = { title, snippet };
      }
    }

    // 2. Hasil Pencarian Organik
    const organicResults = [];
    $('#b_results .b_algo').each((index, element) => {
      const titleEl = $(element).find('h2 a');
      const snippetEl = $(element).find('.b_caption p, .b_algoDesc, .b_lineclamp2');

      const title = titleEl.text().trim();
      const rawLink = titleEl.attr('href');
      const directLink = decodeBingUrl(rawLink);
      const snippet = snippetEl.text().trim();

      // Mengambil favicon menggunakan Google Favicon API berdasarkan domain asli
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

    // 3. Related Searches (Pencarian Terkait)
    const relatedSearches = [];
    $('.b_rs a, #b_results .b_vList li a').each((i, el) => {
      const text = $(el).text().trim();
      if (text && !relatedSearches.includes(text)) {
        relatedSearches.push(text);
      }
    });

    // Response JSON Lengkap
    res.json({
      status: 'success',
      source: 'bing',
      query,
      instant_answer: instantAnswer,
      total_results: organicResults.length,
      organic: organicResults,
      related_searches: relatedSearches
    });

  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => console.log(`Server aktif di port ${PORT}`));
