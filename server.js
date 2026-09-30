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

const sourceStats = {};

function trackSource(name, ok, errMsg = null) {
  const s = sourceStats[name] || (sourceStats[name] = {
    success: 0,
    failure: 0,
    consecutiveFailures: 0,
    lastError: null,
    lastSuccessAt: null,
    lastFailureAt: null
  });

  if (ok) {
    s.success++;
    s.consecutiveFailures = 0;
    s.lastSuccessAt = new Date().toISOString();
  } else {
    s.failure++;
    s.consecutiveFailures++;
    s.lastError = errMsg;
    s.lastFailureAt = new Date().toISOString();

    if (s.consecutiveFailures === 3) {
      alertEcosystem(
        'WARN',
        `Sumber "${name}" gagal 3x berturut-turut`,
        { error: errMsg }
      );
    }
  }
}

function alertEcosystem(level, message, meta = {}) {
  const payload = {
    level,
    message,
    meta,
    timestamp: new Date().toISOString()
  };

  console.error(`[ALERT:${level}]`, JSON.stringify(payload));
}

function looksBlocked(html) {
  if (typeof html !== 'string') return false;
  return html.includes('geetest') || html.includes('cf-browser-verification');
}

const REDIRECT_PARAMS = [
  'u',
  'url',
  'r',
  'q',
  'target',
  'redirect',
  'redirecturl',
  'ru',
  'dest',
  'destination'
];

const linkCache = new Map();
const LINK_CACHE_MAX = 5000;

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

function isSearchEngineUrl(u) {
  const h = hostOf(u);

  return h === 'bing.com' ||
         h.endsWith('.bing.com') ||
         h === 'news.google.com' ||
         h === 'google.com' ||
         h === 'www.google.com';
}

function decodeBase64Url(str) {
  try {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');

    while (s.length % 4) {
      s += '=';
    }

    return Buffer.from(s, 'base64').toString('utf8');
  } catch (e) {
    return null;
  }
}

function decodeBingParam(val) {
  if (!val) return null;
  if (/^https?:\/\//i.test(val)) return val;

  for (let k = 0; k <= 3; k++) {
    const out = decodeBase64Url(val.slice(k));

    if (out && /^https?:\/\/[^\s]+$/i.test(out)) {
      return out;
    }
  }

  return null;
}

function decodeGoogleNewsArticle(link) {
  try {
    const m = new URL(link).pathname.match(/\/articles\/([^/?]+)/);

    if (!m) return null;

    const raw = Buffer
      .from(
        m[1].replace(/-/g, '+').replace(/_/g, '/'),
        'base64'
      )
      .toString('latin1');

    const found = raw.match(/https?:\/\/[\x21-\x7e]+/);

    return found ? found[0] : null;
  } catch (e) {
    return null;
  }
}

function resolveByParams(link) {
  let current = link;

  for (let hop = 0; hop < 4; hop++) {
    if (!isSearchEngineUrl(current)) {
      return current;
    }

    let next = null;

    try {
      const u = new URL(current);

      if (u.hostname === 'news.google.com') {
        next = decodeGoogleNewsArticle(current);
      }

      if (!next) {
        for (const p of REDIRECT_PARAMS) {
          const v = u.searchParams.get(p);
          const decoded = decodeBingParam(v);

          if (decoded && decoded !== current) {
            next = decoded;
            break;
          }
        }
      }
    } catch (e) {
      return current;
    }

    if (!next) {
      return current;
    }

    current = next;
  }

  return current;
}

async function resolveByHttp(link) {
  let current = link;

  for (let hop = 0; hop < 5; hop++) {
    if (!isSearchEngineUrl(current)) {
      return current;
    }

    try {
      const res = await axios.get(current, {
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,*/*;q=0.8'
        },
        timeout: 4000,
        maxRedirects: 0,
        responseType: 'text',
        maxContentLength: 512 * 1024,
        validateStatus: s => s < 400
      });

      if (res.status >= 300 && res.headers.location) {
        current = new URL(
          res.headers.location,
          current
        ).toString();

        continue;
      }

      const html = typeof res.data === 'string'
        ? res.data
        : '';

      const m =
        html.match(/http-equiv=["']refresh["'][^>]*url=([^"'>\s]+)/i) ||
        html.match(/\bvar\s+u\s*=\s*["'](https?:[^"']+)["']/i) ||
        html.match(/window\.location(?:\.href)?\s*=\s*["'](https?:[^"']+)["']/i);

      if (!m) {
        return null;
      }

      const next = m[1]
        .replace(/&amp;/g, '&')
        .replace(/\\u0026/g, '&')
        .replace(/\\\//g, '/');

      current = new URL(next, current).toString();

    } catch (e) {
      const loc = e.response?.headers?.location;

      if (loc) {
        current = new URL(loc, current).toString();
        continue;
      }

      return null;
    }
  }

  return isSearchEngineUrl(current)
    ? null
    : current;
}

async function resolveLink(link) {
  if (!link || !/^https?:\/\//i.test(link)) {
    return {
      link,
      resolved: false
    };
  }

  if (!isSearchEngineUrl(link)) {
    return {
      link,
      resolved: true
    };
  }

  if (linkCache.has(link)) {
    return linkCache.get(link);
  }

  let finalUrl = resolveByParams(link);

  if (isSearchEngineUrl(finalUrl)) {
    const viaHttp = await resolveByHttp(finalUrl);

    if (viaHttp) {
      finalUrl = viaHttp;
    }
  }

  const result = {
    link: finalUrl,
    resolved: !isSearchEngineUrl(finalUrl)
  };

  if (linkCache.size >= LINK_CACHE_MAX) {
    linkCache.delete(
      linkCache.keys().next().value
    );
  }

  linkCache.set(link, result);

  return result;
}

async function finalizeLinks(items, concurrency = 5) {
  const out = items;

  for (let i = 0; i < out.length; i += concurrency) {
    const chunk = out.slice(i, i + concurrency);

    await Promise.all(
      chunk.map(async item => {
        const original = item.link;
        const r = await resolveLink(original);

        item.link = r.link;
        item.linkResolved = r.resolved;

        if (r.link !== original) {
          try {
            item.domain = new URL(r.link)
              .hostname
              .replace(/^www\./, '');
          } catch (e) {}
        }
      })
    );
  }

  const failed = out.filter(
    i => i.linkResolved === false
  ).length;

  if (failed > 0) {
    console.warn(
      `[LINKS] ${failed}/${out.length} link belum bisa di-resolve (masih redirect mesin pencari)`
    );
  }

  return out;
}

// ==========================================
// 1. SCRAPER WEB (Bing Search)
// ==========================================
async function fetchWebResults(query, config, limit, offset) {
  try {
    const items = [];

    const firstIndex = offset > 0
      ? offset + 1
      : 1;

    const bingWebUrl =
      `https://www.bing.com/search?q=${encodeURIComponent(query)}` +
      `&setmkt=${config.mkt}` +
      `&setlang=${config.hl}` +
      `&first=${firstIndex}`;

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

    if (looksBlocked(html)) {
      throw new Error(
        'BLOCKED_CAPTCHA: Bing mendeteksi bot/minta verifikasi Captcha.'
      );
    }

    const $ = cheerio.load(html);

    $('li.b_algo').each((_, el) => {
      if (items.length >= limit) {
        return false;
      }

      const titleEl = $(el).find('h2 a').first();
      const snippetEl = $(el)
        .find('div.b_caption p, p.b_lineclamp')
        .first();

      const title = titleEl.text().trim();
      const link = titleEl.attr('href');
      const snippet = snippetEl.text().trim();

      if (
        title &&
        link &&
        link.startsWith('http')
      ) {
        let domain = '';

        try {
          domain = new URL(link)
            .hostname
            .replace(/^www\./, '');
        } catch (e) {}

        items.push({
          title,
          link,
          snippet: snippet || 'Tidak ada deskripsi.',
          domain,
          position: offset + items.length + 1
        });
      }
    });

    if (items.length === 0) {
      throw new Error(
        'EMPTY_RESULT: Selector mungkin sudah berubah, 0 item ditemukan.'
      );
    }

    trackSource('bing-web', true);

    return items;

  } catch (err) {
    trackSource(
      'bing-web',
      false,
      err.message
    );

    throw err;
  }
}

// ==========================================
// 2. SCRAPER GAMBAR
//
// Satu-satunya sumber gambar: Bing Images.
// ==========================================
const NO_EL = {
  attr: () => '',
  find: () => ({
    attr: () => ''
  })
};

function queryTokens(query) {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 3);
}

function relevanceScore(images, query) {
  const tokens = queryTokens(query);

  if (
    tokens.length === 0 ||
    images.length === 0
  ) {
    return 1;
  }

  let hits = 0;

  for (const img of images) {
    const hay =
      `${img.title} ${img.pageUrl} ${img.imageUrl}`
        .toLowerCase();

    if (
      tokens.some(t => hay.includes(t))
    ) {
      hits++;
    }
  }

  return hits / images.length;
}

function safeParseInt(val) {
  if (!val) return 0;

  const num = parseInt(
    String(val).replace(/[^\d]/g, ''),
    10
  );

  return isNaN(num) ? 0 : num;
}

function extractDimensions(mData, $el) {
  let w = safeParseInt(
    mData.tw ||
    mData.thumbWidth ||
    mData.mw ||
    mData.w ||
    mData.ow ||
    mData.width
  );

  let h = safeParseInt(
    mData.th ||
    mData.thumbHeight ||
    mData.mh ||
    mData.h ||
    mData.oh ||
    mData.height
  );

  if (!w || !h) {
    const dataDim =
      $el.attr('data-dim') ||
      $el.find('img').attr('data-dim') ||
      '';

    if (dataDim) {
      const match = dataDim.match(
        /(\d+)\s*[x×]\s*(\d+)/i
      );

      if (match) {
        if (!w) w = safeParseInt(match[1]);
        if (!h) h = safeParseInt(match[2]);
      }
    }
  }

  if ((!w || !h) && mData.murl) {
    const ratio =
      safeParseInt(mData.w) &&
      safeParseInt(mData.h)
        ? safeParseInt(mData.w) / safeParseInt(mData.h)
        : null;

    if (ratio) {
      if (w && !h) {
        h = Math.round(w / ratio);
      } else if (h && !w) {
        w = Math.round(h * ratio);
      }
    }
  }

  return {
    width: w || null,
    height: h || null
  };
}

function getImageProxy() {
  const raw = process.env.IMAGE_PROXY_URL;

  if (!raw) return null;

  try {
    const u = new URL(raw);

    return {
      protocol: u.protocol.replace(':', ''),
      host: u.hostname,
      port:
        Number(u.port) ||
        (u.protocol === 'https:' ? 443 : 80),
      ...(u.username
        ? {
            auth: {
              username: decodeURIComponent(u.username),
              password: decodeURIComponent(u.password)
            }
          }
        : {})
    };

  } catch (e) {
    console.warn(
      '[IMAGES] IMAGE_PROXY_URL tidak valid, diabaikan.'
    );

    return null;
  }
}

function decodeEntities(s) {
  return s
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, h) =>
        String.fromCharCode(
          parseInt(h, 16)
        )
    )
    .replace(
      /&#(\d+);/g,
      (_, d) =>
        String.fromCharCode(
          parseInt(d, 10)
        )
    )
    .replace(/&amp;/g, '&')
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/');
}

function buildImage(
  d,
  $el,
  offset,
  count,
  query
) {
  const imageUrl = d.murl;
  const thumbnailUrl = d.turl;
  const targetLink = d.purl;
  const title = d.t || d.desc || query;

  let domain = '';

  try {
    domain = new URL(
      targetLink || imageUrl
    )
      .hostname
      .replace(/^www\./, '');
  } catch (e) {}

  const dims = extractDimensions(
    d,
    $el || NO_EL
  );

  let rawHtml = '';

try {
  rawHtml = cheerio
    .html($el || '')
    .slice(0, 8000);
} catch (e) {
  rawHtml = '';
}

  return {
    title: String(title)
      .replace(/<[^>]+>/g, ''),
    image: imageUrl,
    imageUrl,
    thumbnail: thumbnailUrl || imageUrl,
    thumbnailUrl: thumbnailUrl || imageUrl,

    width: dims.width,
    height: dims.height,
    imageWidth: dims.width,
    imageHeight: dims.height,

    source: domain || 'bing',
    domain: domain || 'bing',
    pageUrl: targetLink || imageUrl,
    link: targetLink || imageUrl,
    position: offset + count + 1,

    _debug: {
      rawMetadata: d,
      rawHtml: rawHtml
    }
  };
}

function parseBingImagesRaw(
  html,
  limit,
  offset,
  query
) {
  const $ = cheerio.load(html);
  const images = [];
  const seen = new Set();

  $('a.iusc').each((_, el) => {
    if (images.length >= limit) return false;

    const $el = $(el);
    const rawM = $el.attr('m');

    if (!rawM) return;

    let d = null;

    try {
      d = JSON.parse(
        decodeEntities(rawM)
      );
    } catch (e) {
      try {
        d = JSON.parse(
          rawM
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&amp;/gi, '&')
        );
      } catch (e2) {
        d = null;
      }
    }

    if (!d || !d.murl) return;

    if (seen.has(d.murl)) return;

    seen.add(d.murl);

    images.push(
      buildImage(
        d,
        $el,
        offset,
        images.length,
        query
      )
    );
  });

  return images;
}

function parseBingImageCards(
  $,
  html,
  limit,
  offset,
  query
) {
  const images = [];
  const seen = new Set();

  $(
    'a.iusc, [m*="murl"], [data-m*="murl"]'
  ).each((_, el) => {
    if (images.length >= limit) {
      return false;
    }

    const $el = $(el);

    const mAttr =
      $el.attr('m') ||
      $el.attr('data-m');

    if (!mAttr) return;

    try {
      const d = JSON.parse(mAttr);

      if (
        !d.murl ||
        !d.murl.startsWith('http') ||
        seen.has(d.murl)
      ) {
        return;
      }

      seen.add(d.murl);

      images.push(
        buildImage(
          d,
          $el,
          offset,
          images.length,
          query
        )
      );

    } catch (e) {}
  });

  if (
    images.length === 0 &&
    html
  ) {
    return parseBingImagesRaw(
      html,
      limit,
      offset,
      query
    );
  }

  return images;
}

function buildImageAttempts(
  query,
  config,
  offset,
  fetchCount
) {
  const q = encodeURIComponent(query);

  const markets = [
    {
      mkt: config.mkt,
      hl: config.hl,
      cc: config.gl.toUpperCase()
    },
    {
      mkt: 'en-US',
      hl: 'en',
      cc: 'US'
    }
  ].filter(
    (m, i, arr) =>
      arr.findIndex(
        x => x.mkt === m.mkt
      ) === i
  );

  const attempts = [];

  for (const m of markets) {
    const common =
      `setmkt=${m.mkt}` +
      `&setlang=${m.hl}` +
      `&cc=${m.cc}`;

    const acceptLang =
      `${m.mkt},${m.hl};q=0.9`;

    attempts.push({
      name: `async-${m.mkt}`,
      market: m.mkt,
      acceptLang,
      url:
        `https://www.bing.com/images/async` +
        `?q=${q}` +
        `&first=${offset}` +
        `&count=${fetchCount}` +
        `&mmasync=1` +
        `&${common}`
    });

    attempts.push({
      name: `page-${m.mkt}`,
      market: m.mkt,
      acceptLang,
      url:
        `https://www.bing.com/images/search` +
        `?q=${q}` +
        `&first=${offset > 0 ? offset + 1 : 1}` +
        `&count=${fetchCount}` +
        `&${common}`
    });
  }

  return attempts;
}

const BING_UA = USER_AGENTS[0];

let bingCookie = {
  value: '',
  at: 0
};

async function getBingCookie(proxy) {
  if (
    bingCookie.value &&
    Date.now() - bingCookie.at <
      10 * 60 * 1000
  ) {
    return bingCookie.value;
  }

  try {
    const r = await axios.get(
      'https://www.bing.com/',
      {
        headers: {
          'User-Agent': BING_UA,
          'Accept-Language':
            'en-US,en;q=0.9'
        },
        timeout: 6000,
        ...(proxy ? { proxy } : {})
      }
    );

    const set =
      r.headers['set-cookie'] || [];

    bingCookie = {
      value: set
        .map(c => c.split(';')[0])
        .join('; '),
      at: Date.now()
    };

  } catch (e) {}

  return bingCookie.value;
}

async function runImageAttempt(
  attempt,
  query,
  limit,
  offset
) {
  const proxy = getImageProxy();
  const cookie = await getBingCookie(proxy);

  const res = await axios.get(
    attempt.url,
    {
      headers: {
        'User-Agent': BING_UA,
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':
          attempt.acceptLang,
        'Referer':
          `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`,
        ...(cookie
          ? { Cookie: cookie }
          : {})
      },
      timeout: 10000,
      ...(proxy ? { proxy } : {})
    }
  );

  const html =
    typeof res.data === 'string'
      ? res.data
      : '';

  const blocked = looksBlocked(html);
  const $ = cheerio.load(html);

  const images = blocked
    ? []
    : parseBingImageCards(
        $,
        html,
        limit,
        offset,
        query
      );

  const score =
    relevanceScore(
      images,
      query
    );

  const pageTitle =
    ($('title').first().text() || '')
      .trim()
      .slice(0, 80);

  const debug = {
    iusc:
      (html.match(/class="iusc"/g) || [])
        .length,
    murl:
      (html.match(/murl/g) || [])
        .length,
    challenge:
      /captcha|unusual traffic|are you a robot|geetest/i.test(html),
    cookie:
      !!bingCookie.value,
    proxy:
      !!proxy
  };

  if (images.length === 0) {
    $('script, style').remove();

    debug.bodyText =
      $('body')
        .text()
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);

    console.log(
      `[IMG-DEBUG] ${attempt.name} ` +
      `status=${res.status} ` +
      `len=${html.length} ` +
      `title="${pageTitle}" ` +
      `iusc=${debug.iusc} ` +
      `murl=${debug.murl} ` +
      `challenge=${debug.challenge} ` +
      `proxy=${debug.proxy} ` +
      `body="${debug.bodyText}"`
    );
  }

  return {
    images,
    score,
    blocked,
    status: res.status,
    htmlLength: html.length,
    pageTitle,
    debug
  };
}

async function fetchImagesBing(
  query,
  config,
  limit,
  offset
) {
  const fetchCount =
    Math.max(limit, 20);

  const attempts =
    buildImageAttempts(
      query,
      config,
      offset,
      fetchCount
    );

  let best = null;
  let bestScore = -1;
  let anyImages = false;
  const errors = [];

  for (const attempt of attempts) {
    if (
      attempt.market !== config.mkt &&
      !anyImages
    ) {
      break;
    }

    try {
      const r =
        await runImageAttempt(
          attempt,
          query,
          limit,
          offset
        );

      if (r.blocked) {
        throw new Error(
          `BLOCKED_CAPTCHA (${attempt.name})`
        );
      }

      if (r.images.length === 0) {
        throw new Error(
          `EMPTY (${attempt.name}, html ${r.htmlLength}B, title "${r.pageTitle}")`
        );
      }

      anyImages = true;

      console.log(
        `[IMAGES] "${query}" via ${attempt.name}: ` +
        `${r.images.length} gambar, relevansi ${r.score.toFixed(2)}`
      );

      if (r.score > bestScore) {
        best = r.images;
        bestScore = r.score;
      }

      if (r.score >= 0.2) {
        return r.images;
      }

    } catch (err) {
      errors.push(err.message);

      console.warn(
        `[IMAGES] Strategi "${attempt.name}" gagal: ${err.message}`
      );
    }
  }

  if (
    best &&
    bestScore < 0.1
  ) {
    throw new Error(
      `IRRELEVANT_RESULT: Bing mengembalikan gambar yang tidak berhubungan dengan "${query}".`
    );
  }

  if (!best) {
    throw new Error(
      `BING_FAILED: ${errors.join(' | ')}`
    );
  }

  best.lowRelevance = true;

  return best;
}

async function fetchImages(
  query,
  config,
  limit,
  offset
) {
  const tries = 2;
  let lastErr = null;

  for (let t = 1; t <= tries; t++) {
    try {
      const out =
        await fetchImagesBing(
          query,
          config,
          limit,
          offset
        );

      trackSource(
        'bing-images',
        true
      );

      out.provider =
        'bing-images';

      console.log(
        `[IMAGES] "${query}" berhasil via bing-images ` +
        `(percobaan ${t}): ${out.length} gambar`
      );

      return out;

    } catch (err) {
      lastErr = err;

      console.warn(
        `[IMAGES] bing-images percobaan ${t}/${tries} gagal: ${err.message}`
      );

      if (t < tries) {
        await new Promise(
          r => setTimeout(r, 600)
        );
      }
    }
  }

  trackSource(
    'bing-images',
    false,
    lastErr?.message || 'Unknown error'
  );

  throw new Error(
    `BING_IMAGE_SEARCH_FAILED: ${lastErr?.message || 'Unknown error'}`
  );
}

// ==========================================
// 3. SCRAPER BERITA — Bing News (primer) + Google RSS (fallback)
// ==========================================
function buildBingNewsCookies(config) {
  const region =
    config.gl.toUpperCase();

  const lang = config.hl;

  return `_EDGE_CD=m=${region}&u=${lang}; _EDGE_S=mkt=${region}&ui=${lang}`;
}

async function fetchNewsViaBing(
  query,
  config,
  limit,
  offset
) {
  try {
    const newsItems = [];

    const first =
      offset > 0
        ? offset + 1
        : 1;

    const bingNewsUrl =
      `https://www.bing.com/news/infinitescrollajax` +
      `?q=${encodeURIComponent(query)}` +
      `&InfiniteScroll=1` +
      `&first=${first}`;

    const res =
      await axios.get(
        bingNewsUrl,
        {
          headers: {
            'User-Agent':
              getRandomUserAgent(),
            'Accept':
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language':
              `${config.hl}-${config.gl.toUpperCase()},${config.hl};q=0.9`,
            'Referer':
              'https://www.bing.com/news',
            'Cookie':
              buildBingNewsCookies(config)
          },
          timeout: 9000
        }
      );

    const html = res.data;

    if (looksBlocked(html)) {
      throw new Error(
        'BLOCKED_CAPTCHA: Bing News mendeteksi bot/minta verifikasi Captcha.'
      );
    }

    const $ =
      cheerio.load(html);

    let cards =
      $('div[class*="newsitem"]');

    if (cards.length === 0) {
      cards =
        $('[url][class*="news"]');
    }

    cards.each((_, el) => {
      if (
        newsItems.length >= limit
      ) {
        return false;
      }

      const $el = $(el);

      const link =
        $el.attr('url') ||
        $el
          .find('a.title')
          .first()
          .attr('href');

      const title =
        $el
          .find(
            '.caption a.title, a.title'
          )
          .first()
          .text()
          .trim();

      if (
        !title ||
        !link ||
        !link.startsWith('http')
      ) {
        return;
      }

      const snippet =
        $el
          .find('.snippet')
          .first()
          .text()
          .trim();

      const sourceSpans =
        $el.find('.source span');

      const metadataText =
        sourceSpans
          .map(
            (i, s) =>
              $(s)
                .text()
                .trim()
          )
          .get()
          .join(' · ');

      const publisher =
        sourceSpans
          .first()
          .text()
          .trim();

      let thumbnail = null;

      const imgSrc =
        $el
          .find(
            'a.imagelink img'
          )
          .first()
          .attr('src');

      if (imgSrc) {
        if (
          imgSrc.startsWith('http')
        ) {
          thumbnail =
            imgSrc;
        } else {
          thumbnail =
            `https://www.bing.com${imgSrc.startsWith('/') ? '' : '/'}${imgSrc}`;
        }
      }

      let domain = '';

      try {
        domain =
          new URL(link)
            .hostname
            .replace(/^www\./, '');
      } catch (e) {}

      newsItems.push({
        title,
        link,
        snippet:
          snippet ||
          'Tidak ada deskripsi.',
        publisher:
          publisher ||
          domain ||
          'Berita',
        domain,
        thumbnailUrl:
          thumbnail,
        publishedAt:
          metadataText ||
          null,
        position:
          offset +
          newsItems.length +
          1
      });
    });

    if (
      newsItems.length === 0
    ) {
      throw new Error(
        'EMPTY_RESULT: Struktur newsitem tidak ditemukan, kemungkinan Bing ubah markup lagi.'
      );
    }

    trackSource(
      'bing-news',
      true
    );

    return newsItems;

  } catch (err) {
    trackSource(
      'bing-news',
      false,
      err.message
    );

    throw err;
  }
}

async function fetchNewsViaGoogleRss(
  query,
  config,
  limit,
  offset
) {
  try {
    const newsItems = [];

    const rssUrl =
      `https://news.google.com/rss/search` +
      `?q=${encodeURIComponent(query)}` +
      `&hl=${config.hl}-${config.gl.toUpperCase()}` +
      `&gl=${config.gl.toUpperCase()}` +
      `&ceid=${config.gl.toUpperCase()}:${config.hl}`;

    const feed =
      await rssParser.parseURL(
        rssUrl
      );

    const rawItems =
      feed.items || [];

    const pagedItems =
      rawItems.slice(
        offset,
        offset + limit
      );

    if (
      pagedItems.length === 0
    ) {
      throw new Error(
        'EMPTY_RESULT: RSS Google News kosong.'
      );
    }

    for (
      let i = 0;
      i < pagedItems.length;
      i++
    ) {
      const item =
        pagedItems[i];

      if (
        !item.title ||
        !item.link
      ) {
        continue;
      }

      let thumbnail = null;

      if (
        item.mediaThumbnail?.$?.url
      ) {
        thumbnail =
          item.mediaThumbnail.$.url;
      } else if (
        item.mediaContent?.$?.url
      ) {
        thumbnail =
          item.mediaContent.$.url;
      } else {
        thumbnail =
          extractImageFromHtml(
            item.content ||
            item.snippet ||
            item.summary
          );
      }

      let sourceName =
        item.source ||
        'Berita';

      if (
        typeof sourceName ===
        'object' &&
        sourceName._
      ) {
        sourceName =
          sourceName._;
      }

      let domain = '';

      try {
        domain =
          new URL(item.link)
            .hostname
            .replace(/^www\./, '');
      } catch (e) {}

      const cleanSnippet =
        item.contentSnippet ||
        (
          item.content
            ? cheerio
                .load(item.content)
                .text()
            : ''
        );

      newsItems.push({
        title:
          item.title.replace(
            / - [^-]+$/,
            ''
          ),
        link: item.link,
        snippet:
          cleanSnippet.trim(),
        publisher:
          sourceName,
        domain,
        thumbnailUrl:
          thumbnail,
        publishedAt:
          item.pubDate ||
          item.isoDate ||
          null,
        position:
          offset +
          newsItems.length +
          1,
        _isFallbackSource:
          true
      });
    }

    if (
      newsItems.length === 0
    ) {
      throw new Error(
        'EMPTY_RESULT: Semua item RSS cacat/kosong setelah filter.'
      );
    }

    trackSource(
      'google-news-rss',
      true
    );

    return newsItems;

  } catch (err) {
    trackSource(
      'google-news-rss',
      false,
      err.message
    );

    throw err;
  }
}

async function fetchNews(
  query,
  config,
  limit,
  offset
) {
  try {
    return await fetchNewsViaBing(
      query,
      config,
      limit,
      offset
    );

  } catch (bingErr) {
    console.warn(
      `[FALLBACK] Bing News gagal ("${bingErr.message}"), mencoba Google News RSS...`
    );

    try {
      return await fetchNewsViaGoogleRss(
        query,
        config,
        limit,
        offset
      );

    } catch (rssErr) {
      alertEcosystem(
        'FATAL',
        'Semua sumber berita (Bing + Google RSS) gagal total',
        {
          bingError:
            bingErr.message,
          rssError:
            rssErr.message,
          query
        }
      );

      throw new Error(
        `ALL_NEWS_SOURCES_FAILED: Bing(${bingErr.message}) | RSS(${rssErr.message})`
      );
    }
  }
}

// ==========================================
// MAIN ROUTE API (/api/search)
// ==========================================
app.get(
  '/api/search',
  async (req, res) => {
    const startTime =
      Date.now();

    const query =
      req.query.q;

    const searchType =
      (
        req.query.type ||
        'search'
      ).toLowerCase();

    if (!query) {
      return res
        .status(400)
        .json({
          status: 'error',
          message:
            'Parameter "q" wajib diisi.'
        });
    }

    let defaultLimit = 10;

    if (
      searchType === 'images'
    ) {
      defaultLimit = 20;
    }

    if (
      searchType === 'news'
    ) {
      defaultLimit = 15;
    }

    const limit =
      parseInt(
        req.query.num,
        10
      ) || defaultLimit;

    let offset =
      parseInt(
        req.query.start,
        10
      ) || 0;

    if (
      !req.query.start &&
      req.query.page
    ) {
      const page =
        parseInt(
          req.query.page,
          10
        ) || 1;

      offset =
        (page - 1) * limit;
    }

    const config =
      resolveLanguageConfig(
        req.query,
        req.headers[
          'accept-language'
        ]
      );

    const cacheKey =
      `${searchType}_${query.toLowerCase().trim()}_${config.hl}_${config.gl}_${limit}_start${offset}`;

    const staleEntry =
      cache.get(cacheKey) ||
      null;

    if (
      staleEntry &&
      Date.now() -
        staleEntry.timestamp <
        CACHE_TTL
    ) {
      return res.json(
        staleEntry.data
      );
    }

    try {
      let results = [];

      if (
        searchType === 'images'
      ) {
        results =
          await fetchImages(
            query,
            config,
            limit,
            offset
          );

      } else if (
        searchType === 'news'
      ) {
        results =
          await fetchNews(
            query,
            config,
            limit,
            offset
          );

      } else {
        results =
          await fetchWebResults(
            query,
            config,
            limit,
            offset
          );
      }

      if (
        searchType !== 'images' &&
        results.length > 0
      ) {
        results =
          await finalizeLinks(
            results
          );
      }

      if (
        results.length === 0
      ) {
        return res
          .status(502)
          .json({
            status: 'error',
            message:
              'Hasil pencarian kosong. IP Server hosting kemungkinan diblokir oleh Bing / HTML berubah.',
            searchParameters: {
              q: query,
              type: searchType,
              start: offset
            }
          });
      }

      const searchTime =
        (
          (Date.now() -
            startTime) /
          1000
        ).toFixed(2);

      const responsePayload = {
        status: 'success',

        searchParameters: {
          q: query,
          type: searchType,
          hl: config.hl,
          gl: config.gl,
          num: limit,
          start: offset,
          page:
            Math.floor(
              offset / limit
            ) + 1
        },

        searchInformation: {
          formattedSearchTime:
            searchTime,
          totalResults:
            results.length
        },

        provider:
          results.provider ||
          undefined,

        results,

        images:
          searchType === 'images'
            ? results
            : undefined,

        items:
          searchType === 'search'
            ? results
            : undefined,

        news:
          searchType === 'news'
            ? results
            : undefined
      };

      if (
        !results.lowRelevance
      ) {
        if (
          cache.size >= 500
        ) {
          cache.delete(
            cache.keys()
              .next()
              .value
          );
        }

        cache.set(
          cacheKey,
          {
            timestamp:
              Date.now(),
            data:
              responsePayload
          }
        );
      }

      return res.json(
        responsePayload
      );

    } catch (error) {
      console.error(
        `[API ERROR] Type=${searchType}:`,
        error.message
      );

      if (staleEntry) {
        return res.json({
          ...staleEntry.data,
          stale: true
        });
      }

      let statusCode = 500;

      let customMessage =
        'Terjadi kesalahan pada server backend.';

      if (
        error.message.startsWith(
          'BING_IMAGE_SEARCH_FAILED'
        ) ||
        error.message.startsWith(
          'IRRELEVANT_RESULT'
        )
      ) {
        statusCode = 502;

        customMessage =
          'Bing Images gagal mengembalikan hasil gambar yang valid saat ini. Coba lagi beberapa saat.';
      } else if (
        error.message.startsWith(
          'ALL_NEWS_SOURCES_FAILED'
        )
      ) {
        statusCode = 502;

        customMessage =
          'Semua sumber berita (primer & fallback) gagal.';
      } else if (
        error.code ===
          'ECONNABORTED' ||
        error.message.includes(
          'timeout'
        )
      ) {
        statusCode = 504;

        customMessage =
          'Koneksi timeout ke mesin pencari Bing/Google. Jaringan lambat/terputus.';
      } else if (
        error.message.includes(
          'BLOCKED_CAPTCHA'
        )
      ) {
        statusCode = 429;

        customMessage =
          'IP Server Railway terdeteksi bot/terblokir Captcha oleh Bing.';
      } else if (
        error.response
      ) {
        statusCode =
          error.response.status;

        customMessage =
          `Penyedia pencarian mengembalikan status error ${error.response.status}.`;
      }

      return res
        .status(statusCode)
        .json({
          status: 'error',
          message:
            customMessage,
          error_detail:
            error.message
        });
    }
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Server API berjalan di http://localhost:${PORT}`
    );
  }
);
