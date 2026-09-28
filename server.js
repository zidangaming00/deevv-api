import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;

// Endpoint Utama
app.get('/api/search', async (req, res) => {
  const query = req.query.q;

  if (!query) {
    return res.status(400).json({
      status: 'error',
      message: 'Parameter query "q" wajib diisi. Contoh: /api/search?q=belajar+javascript'
    });
  }

  try {
    // 1. Fetch HTML dari Bing Search
    const targetUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=id`;
    
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 10000 // Timeout 10 detik
    });

    // 2. Parse HTML menggunakan Cheerio
    const $ = cheerio.load(response.data);
    const organicResults = [];

    // Elemen hasil organik di Bing berada di selector '#b_results .b_algo'
    $('#b_results .b_algo').each((index, element) => {
      const titleEl = $(element).find('h2 a');
      const snippetEl = $(element).find('.b_caption p, .b_algoDesc');

      const title = titleEl.text().trim();
      const link = titleEl.attr('href');
      const snippet = snippetEl.text().trim();

      if (title && link) {
        organicResults.push({
          position: organicResults.length + 1,
          title,
          link,
          snippet: snippet || 'Deskripsi tidak tersedia.'
        });
      }
    });

    // 3. Response JSON Format
    res.json({
      status: 'success',
      source: 'bing',
      query,
      total_results: organicResults.length,
      results: organicResults
    });

  } catch (error) {
    console.error('Bing Scraping Error:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Gagal mengambil data dari Bing.',
      error: error.message
    });
  }
});

// Middleware Endpoint Default
app.get('/', (req, res) => {
  res.send('Bing SERP API Backend Aktif! Gunakan endpoint /api/search?q=kata_kunci');
});

app.listen(PORT, () => {
  console.log(`Server Bing Scraper berjalan di port ${PORT}`);
});
