
import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import RssParser from 'rss-parser';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  );
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// ==========================================
// KONFIGURASI
// ==========================================

const rssParser = new RssParser({
  timeout: 10000,
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail']
    ]
  }
});

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 500;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

const BING_UA = USER_AGENTS[0];

function getRandomUserAgent() {
  return USER_AGENTS[
    Math.floor(Math.random() * USER_AGENTS.length)
  ];
}

function resolveLanguageConfig() {
  return {
    hl: 'id',
    gl: 'id',
    mkt: 'id-ID'
  };
}

function normalizeUrl(
  url,
  base = 'https://www.bing.com'
) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  const value = url.trim();

  try {
    return new URL(value, base).toString();
  } catch (e) {
    return null;
  }
}

function extractImageFromHtml(htmlSnippet) {
  if (!htmlSnippet) return null;

  try {
    const $ = cheerio.load(htmlSnippet);
    const img = $('img').first();

    return normalizeUrl(
      img.attr('src') ||
      img.attr('data-src') ||
      img.attr('data-original')
    );
  } catch (e) {
    return null;
  }
}

// ==========================================
// SOURCE STATISTICS
// ==========================================

const sourceStats = {};

function alertEcosystem(level, message, meta = {}) {
  const payload = {
    level,
    message,
    meta,
    timestamp: new Date().toISOString()
  };

  console.error(
    `[ALERT:${level}]`,
    JSON.stringify(payload)
  );
}

function trackSource(name, ok, errMsg = null) {
  const s = sourceStats[name] || (
    sourceStats[name] = {
      success: 0,
      failure: 0,
      consecutiveFailures: 0,
      lastError: null,
      lastSuccessAt: null,
      lastFailureAt: null
    }
  );

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

// ==========================================
// DETEKSI CAPTCHA / BLOCK
// ==========================================

function looksBlocked(html) {
  if (typeof html !== 'string') return false;

  return /captcha|unusual traffic|are you a robot|verify you are human|robot check|geetest|cf-browser-verification|challenge-platform|bingbot|automated queries|suspicious activity/i.test(
    html
  );
}

// ==========================================
// LINK RESOLVER
// ==========================================

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

  return (
    h === 'bing.com' ||
    h.endsWith('.bing.com') ||
    h === 'news.google.com' ||
    h === 'google.com' ||
    h.endsWith('.google.com')
  );
}

function decodeBase64Url(str) {
  try {
    let s = String(str)
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    while (s.length % 4) {
      s += '=';
    }

    return Buffer
      .from(s, 'base64')
      .toString('utf8');
  } catch (e) {
    return null;
  }
}

function decodeBingParam(val) {
  if (!val) return null;

  if (/^https?:\/\//i.test(val)) {
    return val;
  }

  for (let k = 0; k <= 3; k++) {
    const out = decodeBase64Url(val.slice(k));

    if (
      out &&
      /^https?:\/\/[^\s]+$/i.test(out)
    ) {
      return out;
    }
  }

  return null;
}

function decodeGoogleNewsArticle(link) {
  try {
    const pathname = new URL(link).pathname;
    const m = pathname.match(
      /\/articles\/([^/?]+)/
    );

    if (!m) return null;

    const encoded = m[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    let padded = encoded;

    while (padded.length % 4) {
      padded += '=';
    }

    const raw = Buffer
      .from(padded, 'base64')
      .toString('latin1');

    const found = raw.match(
      /https?:\/\/[\x21-\x7e]+/
    );

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

          if (
            decoded &&
            decoded !== current
          ) {
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
      const res = await axios.get(
        current,
        {
          headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'text/html,*/*;q=0.8'
          },
          timeout: 5000,
          maxRedirects: 0,
          responseType: 'text',
          maxContentLength: 512 * 1024,
          validateStatus: s => s < 400
        }
      );

      if (
        res.status >= 300 &&
        res.headers.location
      ) {
        current = new URL(
          res.headers.location,
          current
        ).toString();

        continue;
      }

      const html =
        typeof res.data === 'string'
          ? res.data
          : '';

      const m =
        html.match(
          /http-equiv=["']refresh["'][^>]*url=([^"'>\s]+)/i
        ) ||
        html.match(
          /\bvar\s+u\s*=\s*["'](https?:[^"']+)["']/i
        ) ||
        html.match(
          /window\.location(?:\.href)?\s*=\s*["'](https?:[^"']+)["']/i
        );

      if (!m) {
        return null;
      }

      const next = m[1]
        .replace(/&amp;/g, '&')
        .replace(/\\u0026/g, '&')
        .replace(/\\\//g, '/');

      current = new URL(
        next,
        current
      ).toString();
    } catch (e) {
      const loc =
        e.response?.headers?.location;

      if (loc) {
        current = new URL(
          loc,
          current
        ).toString();

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
  if (
    !link ||
    !/^https?:\/\//i.test(link)
  ) {
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
    const viaHttp =
      await resolveByHttp(finalUrl);

    if (viaHttp) {
      finalUrl = viaHttp;
    }
  }

  const result = {
    link: finalUrl,
    resolved: !isSearchEngineUrl(finalUrl)
  };

  if (linkCache.size >= LINK_CACHE_MAX) {
    const oldest =
      linkCache.keys().next().value;

    if (oldest) {
      linkCache.delete(oldest);
    }
  }

  linkCache.set(link, result);

  return result;
}

async function finalizeLinks(
  items,
  concurrency = 5
) {
  const out = items;

  for (
    let i = 0;
    i < out.length;
    i += concurrency
  ) {
    const chunk = out.slice(
      i,
      i + concurrency
    );

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
      `[LINKS] ${failed}/${out.length} link belum bisa di-resolve`
    );
  }

  return out;
}

// ==========================================
// 1. SCRAPER WEB — BING SEARCH
// ==========================================

async function fetchWebResults(
  query,
  config,
  limit,
  offset
) {
  try {
    const items = [];

    const firstIndex = offset + 1;

    const bingWebUrl =
      `https://www.bing.com/search?q=${encodeURIComponent(query)}` +
      `&setmkt=${config.mkt}` +
      `&setlang=${config.hl}` +
      `&first=${firstIndex}`;

    const res = await axios.get(
      bingWebUrl,
      {
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language':
            'id-ID,id;q=0.9,en;q=0.7',
          'Referer':
            'https://www.bing.com/'
        },
        timeout: 10000,
        maxContentLength:
          5 * 1024 * 1024
      }
    );

    const html =
      typeof res.data === 'string'
        ? res.data
        : '';

    if (looksBlocked(html)) {
      throw new Error(
        'BLOCKED_CAPTCHA: Bing meminta verifikasi atau mendeteksi trafik otomatis.'
      );
    }

    const $ = cheerio.load(html);

    $('li.b_algo').each((_, el) => {
      if (items.length >= limit) {
        return false;
      }

      const titleEl =
        $(el).find('h2 a').first();

      const snippetEl = $(el)
        .find(
          'div.b_caption p, p.b_lineclamp'
        )
        .first();

      const title =
        titleEl.text().trim();

      const link = normalizeUrl(
        titleEl.attr('href')
      );

      const snippet =
        snippetEl.text().trim();

      if (!title || !link) {
        return;
      }

      let domain = '';

      try {
        domain = new URL(link)
          .hostname
          .replace(/^www\./, '');
      } catch (e) {}

      items.push({
        title,
        link,
        snippet:
          snippet ||
          'Tidak ada deskripsi.',
        domain,
        position:
          offset + items.length + 1
      });
    });

    if (items.length === 0) {
      throw new Error(
        'EMPTY_RESULT: Tidak ada hasil web yang berhasil diparsing.'
      );
    }

    trackSource(
      'bing-web',
      true
    );

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
// 2. SCRAPER GAMBAR — BING IMAGES
// ==========================================

const NO_EL = {
  attr: () => '',
  find: () => ({
    attr: () => '',
    first: () => ({
      attr: () => '',
      text: () => ''
    })
  }),
  closest: () => ({
    find: () => ({
      first: () => ({
        text: () => ''
      })
    })
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
  if (
    val === undefined ||
    val === null ||
    val === ''
  ) {
    return 0;
  }

  const match =
    String(val).match(/\d+/);

  if (!match) return 0;

  const num = parseInt(match[0], 10);

  return Number.isFinite(num)
    ? num
    : 0;
}

// ==========================================
// ADVANCED HTML / JSON DECODER
// ==========================================

function decodeEntities(s) {
  if (!s) return '';

  return String(s)
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(
        parseInt(h, 16)
      )
    )
    .replace(/&#(\d+);/g, (_, d) =>
      String.fromCodePoint(
        parseInt(d, 10)
      )
    )
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&colon;/gi, ':')
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0027/gi, "'")
    .replace(/\\u003a/gi, ':')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/');
}

function decodeJsonStringLayers(input) {
  if (typeof input !== 'string') {
    return [];
  }

  const results = [];
  const seen = new Set();

  function add(value) {
    if (
      typeof value !== 'string' ||
      !value ||
      seen.has(value)
    ) {
      return;
    }

    seen.add(value);
    results.push(value);
  }

  add(input);

  const decoded = decodeEntities(input);
  add(decoded);

  add(
    decoded
      .replace(/\\\\u0022/gi, '"')
      .replace(/\\\\u0026/gi, '&')
      .replace(/\\\\u002f/gi, '/')
      .replace(/\\\\\//g, '/')
  );

  add(
    decoded
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\')
  );

  add(
    decoded
      .replace(/\\x22/gi, '"')
      .replace(/\\x27/gi, "'")
      .replace(/\\x3a/gi, ':')
      .replace(/\\x2f/gi, '/')
  );

  // Mengurai string JSON yang berisi JSON lain.
  for (const candidate of [...results]) {
    try {
      const parsed = JSON.parse(candidate);

      if (typeof parsed === 'string') {
        add(parsed);
        add(decodeEntities(parsed));
      }
    } catch (e) {}
  }

  return results;
}

// ==========================================
// JSON BALANCED SCANNER
// Mendukung nested object dan array
// ==========================================

function extractBalancedJson(text, start) {
  if (
    typeof text !== 'string' ||
    text[start] !== '{'
  ) {
    return null;
  }

  const stack = [];

  let inString = false;
  let escaped = false;

  for (
    let i = start;
    i < text.length;
    i++
  ) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (
      char === '{' ||
      char === '['
    ) {
      stack.push(char);
      continue;
    }

    if (
      char === '}' ||
      char === ']'
    ) {
      const last = stack.pop();

      if (
        (char === '}' && last !== '{') ||
        (char === ']' && last !== '[')
      ) {
        return null;
      }

      if (stack.length === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

// ==========================================
// MENEMUKAN JSON DARI SELURUH HTML
// ==========================================

function extractJsonCandidates(raw) {
  if (!raw) return [];

  const candidates = [];
  const seen = new Set();

  function add(value) {
    if (
      typeof value !== 'string' ||
      !value ||
      seen.has(value)
    ) {
      return;
    }

    seen.add(value);
    candidates.push(value);
  }

  const variants =
    decodeJsonStringLayers(String(raw));

  for (const text of variants) {
    // Temukan objek JSON berdasarkan struktur.
    let inString = false;
    let escaped = false;

    for (
      let i = 0;
      i < text.length;
      i++
    ) {
      const char = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === '\\') {
          escaped = true;
          continue;
        }

        if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        const object =
          extractBalancedJson(text, i);

        if (object) {
          add(object);
        }
      }
    }

    // Regex fleksibel untuk kandidat objek yang
    // mengandung metadata gambar.
    const keyRegex =
      /\\*["']?\s*(?:murl|mediaUrl|imageUrl|image_url|originalUrl|contentUrl)\s*\\*["']?\s*:/gi;

    let match;

    while (
      (match = keyRegex.exec(text)) !== null
    ) {
      const keyPosition = match.index;

      const start = text.lastIndexOf(
        '{',
        keyPosition
      );

      if (start < 0) continue;

      const object =
        extractBalancedJson(text, start);

      if (object) {
        add(object);
      }
    }

    // Format JSON array yang berisi object.
    const arrayRegex = /\[/g;

    while (
      (match = arrayRegex.exec(text)) !== null
    ) {
      const start = match.index;
      let depth = 0;
      let string = false;
      let escape = false;

      for (
        let i = start;
        i < text.length;
        i++
      ) {
        const c = text[i];

        if (string) {
          if (escape) {
            escape = false;
            continue;
          }

          if (c === '\\') {
            escape = true;
            continue;
          }

          if (c === '"') {
            string = false;
          }

          continue;
        }

        if (c === '"') {
          string = true;
          continue;
        }

        if (c === '[') depth++;

        if (c === ']') {
          depth--;

          if (depth === 0) {
            const array =
              text.slice(start, i + 1);

            if (/murl|mediaUrl|imageUrl/i.test(array)) {
              add(array);
            }

            break;
          }
        }
      }
    }
  }

  return candidates;
}

// ==========================================
// NORMALISASI METADATA GAMBAR
// ==========================================

function getObjectValue(obj, names) {
  if (
    !obj ||
    typeof obj !== 'object'
  ) {
    return undefined;
  }

  const entries = Object.entries(obj);

  for (const name of names) {
    const found = entries.find(
      ([key]) =>
        key.toLowerCase() ===
        name.toLowerCase()
    );

    if (
      found &&
      found[1] !== undefined &&
      found[1] !== null &&
      found[1] !== ''
    ) {
      return found[1];
    }
  }

  return undefined;
}

function findNestedValue(
  obj,
  names,
  depth = 0
) {
  if (
    !obj ||
    typeof obj !== 'object' ||
    depth > 6
  ) {
    return undefined;
  }

  const direct =
    getObjectValue(obj, names);

  if (direct !== undefined) {
    return direct;
  }

  for (const value of Object.values(obj)) {
    if (
      value &&
      typeof value === 'object'
    ) {
      const result =
        findNestedValue(
          value,
          names,
          depth + 1
        );

      if (result !== undefined) {
        return result;
      }
    }
  }

  return undefined;
}

function normalizeImageMetadata(obj) {
  if (
    !obj ||
    typeof obj !== 'object'
  ) {
    return null;
  }

  const murl = findNestedValue(obj, [
    'murl',
    'mediaUrl',
    'imageUrl',
    'image_url',
    'originalUrl',
    'originalImage',
    'contentUrl',
    'fullImageUrl'
  ]);

  if (
    !murl ||
    typeof murl !== 'string'
  ) {
    return null;
  }

  const turl = findNestedValue(obj, [
    'turl',
    'thumbnailUrl',
    'thumbnail',
    'thumbUrl',
    'thumbnail_url'
  ]);

  const purl = findNestedValue(obj, [
    'purl',
    'pageUrl',
    'page_url',
    'sourceUrl',
    'webpageUrl'
  ]);

  const title = findNestedValue(obj, [
    't',
    'title',
    'name',
    'caption',
    'description',
    'desc'
  ]);

  const width = findNestedValue(obj, [
    'ow',
    'originalWidth',
    'original_width',
    'imageWidth',
    'image_width',
    'width',
    'w'
  ]);

  const height = findNestedValue(obj, [
    'oh',
    'originalHeight',
    'original_height',
    'imageHeight',
    'image_height',
    'height',
    'h'
  ]);

  const dimensions = findNestedValue(obj, [
    'dim',
    'dimensions',
    'resolution',
    'imageSize',
    'imageDimensions'
  ]);

  return {
    ...obj,
    murl: String(murl),
    turl: turl ? String(turl) : '',
    purl: purl ? String(purl) : '',
    t: title ? String(title) : '',
    ow: width,
    oh: height,
    dim: dimensions
  };
}

// ==========================================
// PARSER JSON METADATA ADVANCED
// ==========================================

function parseImageMetadata(raw) {
  if (!raw) return null;

  const variants =
    decodeJsonStringLayers(String(raw));

  for (const candidate of variants) {
    try {
      const parsed =
        JSON.parse(candidate);

      if (
        parsed &&
        typeof parsed === 'object'
      ) {
        const normalized =
          normalizeImageMetadata(parsed);

        if (normalized) {
          return normalized;
        }
      }
    } catch (e) {}
  }

  // Coba mengambil object dari teks yang
  // mengandung prefix/suffix non-JSON.
  for (const candidate of variants) {
    const objects =
      extractJsonCandidates(candidate);

    for (const object of objects) {
      try {
        const parsed =
          JSON.parse(object);

        const normalized =
          normalizeImageMetadata(parsed);

        if (normalized) {
          return normalized;
        }
      } catch (e) {}
    }
  }

  return null;
}

// ==========================================
// DIMENSIONS EXTRACTOR
// ==========================================

function extractDimensions(
  mData,
  $el,
  rawM = ''
) {
  let width = 0;
  let height = 0;

  const originalWidthFields = [
    mData?.ow,
    mData?.originalWidth,
    mData?.original_width,
    mData?.imageWidth,
    mData?.image_width
  ];

  const originalHeightFields = [
    mData?.oh,
    mData?.originalHeight,
    mData?.original_height,
    mData?.imageHeight,
    mData?.image_height
  ];

  for (const value of originalWidthFields) {
    const n = safeParseInt(value);

    if (n > 0) {
      width = n;
      break;
    }
  }

  for (const value of originalHeightFields) {
    const n = safeParseInt(value);

    if (n > 0) {
      height = n;
      break;
    }
  }

  if (!width) {
    const fields = [
      mData?.w,
      mData?.width,
      mData?.image?.width,
      mData?.imageInfo?.width,
      mData?.metadata?.width
    ];

    for (const value of fields) {
      const n = safeParseInt(value);

      if (n > 0) {
        width = n;
        break;
      }
    }
  }

  if (!height) {
    const fields = [
      mData?.h,
      mData?.height,
      mData?.image?.height,
      mData?.imageInfo?.height,
      mData?.metadata?.height
    ];

    for (const value of fields) {
      const n = safeParseInt(value);

      if (n > 0) {
        height = n;
        break;
      }
    }
  }

  if (!width || !height) {
    const sources = [
      mData?.dim,
      mData?.dimensions,
      mData?.size,
      mData?.resolution,
      mData?.imageSize,
      mData?.imageDimensions
    ];

    for (const value of sources) {
      if (!value) continue;

      const match = String(value).match(
        /(\d{2,6})\s*[x×]\s*(\d{2,6})/i
      );

      if (match) {
        if (!width) {
          width = parseInt(match[1], 10);
        }

        if (!height) {
          height = parseInt(match[2], 10);
        }

        if (width && height) break;
      }
    }
  }

  if (
    (!width || !height) &&
    rawM
  ) {
    const variants =
      decodeJsonStringLayers(String(rawM));

    for (const raw of variants) {
      const widthMatch = raw.match(
        /["'](?:ow|originalWidth|imageWidth|width)["']\s*:\s*["']?(\d{2,6})/i
      );

      const heightMatch = raw.match(
        /["'](?:oh|originalHeight|imageHeight|height)["']\s*:\s*["']?(\d{2,6})/i
      );

      if (!width && widthMatch) {
        width = parseInt(widthMatch[1], 10);
      }

      if (!height && heightMatch) {
        height = parseInt(heightMatch[1], 10);
      }

      if (!width || !height) {
        const dimMatch = raw.match(
          /(?:dimensions?|resolution|size|imageSize|dim)["']?\s*[:=]\s*["']?(\d{2,6})\s*[x×]\s*(\d{2,6})/i
        );

        if (dimMatch) {
          if (!width) {
            width = parseInt(dimMatch[1], 10);
          }

          if (!height) {
            height = parseInt(dimMatch[2], 10);
          }
        }
      }

      if (width && height) break;
    }
  }

  if (
    $el &&
    typeof $el.attr === 'function'
  ) {
    const attrs = [
      $el.attr('data-dim'),
      $el.attr('data-size'),
      $el.attr('data-resolution'),
      $el.attr('data-image-dim'),
      $el.attr('data-image-size')
    ];

    const img = $el.find('img').first();

    attrs.push(
      img.attr('data-dim'),
      img.attr('data-size'),
      img.attr('data-resolution'),
      img.attr('data-image-dim'),
      img.attr('data-image-size')
    );

    for (const value of attrs) {
      if (!value) continue;

      const match = String(value).match(
        /(\d{2,6})\s*[x×]\s*(\d{2,6})/i
      );

      if (match) {
        if (!width) {
          width = parseInt(match[1], 10);
        }

        if (!height) {
          height = parseInt(match[2], 10);
        }

        if (width && height) break;
      }
    }
  }

  if (
    (!width || !height) &&
    $el &&
    typeof $el.closest === 'function'
  ) {
    try {
      const container = $el.closest('li');

      const captionText = container.find(
        '.img_info .nowrap, .img_info, .imgpt .nowrap'
      )
        .first()
        .text() || '';

      const match = captionText.match(
        /(\d{2,6})\s*[x×]\s*(\d{2,6})/i
      );

      if (match) {
        if (!width) {
          width = parseInt(match[1], 10);
        }

        if (!height) {
          height = parseInt(match[2], 10);
        }
      }
    } catch (e) {}
  }

  if (
    (!width || !height) &&
    $el &&
    typeof $el.find === 'function'
  ) {
    try {
      const thumb = $el.find('img').first();

      const tw = safeParseInt(
        thumb.attr('width')
      );

      const th = safeParseInt(
        thumb.attr('height')
      );

      if (tw > 0 && th > 0) {
        width = width || tw;
        height = height || th;
      }
    } catch (e) {}
  }

  return {
    width: width || null,
    height: height || null
  };
}

// ==========================================
// IMAGE PROXY
// ==========================================

function getImageProxy() {
  const raw = process.env.IMAGE_PROXY_URL;

  if (!raw) return null;

  try {
    const u = new URL(raw);

    if (
      !['http:', 'https:'].includes(u.protocol)
    ) {
      return null;
    }

    return {
      protocol: u.protocol.replace(':', ''),
      host: u.hostname,
      port:
        Number(u.port) ||
        (
          u.protocol === 'https:'
            ? 443
            : 80
        ),
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

// ==========================================
// BUILD IMAGE
// ==========================================

function buildImage(
  d,
  $el,
  offset,
  count,
  query,
  rawM = ''
) {
  d = normalizeImageMetadata(d);

  if (!d) return null;

  const imageUrl = normalizeUrl(d.murl);

  const thumbnailUrl =
    normalizeUrl(d.turl);

  const targetLink =
    normalizeUrl(d.purl);

  if (!imageUrl) {
    return null;
  }

  const title =
    d.t ||
    d.desc ||
    query;

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
    $el || NO_EL,
    rawM
  );

  return {
    title: String(title)
      .replace(/<[^>]+>/g, '')
      .trim(),

    image: imageUrl,
    imageUrl,

    thumbnail:
      thumbnailUrl || imageUrl,

    thumbnailUrl:
      thumbnailUrl || imageUrl,

    width: dims.width,
    height: dims.height,

    source: domain || '',
    domain: domain || '',

    pageUrl:
      targetLink || imageUrl,

    link:
      targetLink || imageUrl,

    position:
      offset + count + 1
  };
}

// ==========================================
// EXTRACT METADATA DARI HTML ATTRIBUTES
// ==========================================

function collectImageMetadataFromElement(
  $,
  el
) {
  const $el = $(el);

  const attributes = [
    'm',
    'data-m',
    'data-bm',
    'data-json',
    'data-metadata',
    'data-image',
    'data-image-data',
    'data-item',
    'data-info'
  ];

  const values = [];

  for (const attr of attributes) {
    const value = $el.attr(attr);

    if (value) {
      values.push(value);
    }
  }

  const img = $el.find('img').first();

  if (img.length) {
    for (const attr of attributes) {
      const value = img.attr(attr);

      if (value) {
        values.push(value);
      }
    }

    const imageAttrs = [
      'src',
      'data-src',
      'data-original',
      'data-full',
      'data-image',
      'data-image-url',
      'data-original-src'
    ];

    for (const attr of imageAttrs) {
      const value = img.attr(attr);

      if (
        value &&
        /^https?:\/\//i.test(value)
      ) {
        values.push(
          JSON.stringify({
            murl: value
          })
        );
      }
    }
  }

  return values;
}

// ==========================================
// ADVANCED HTML IMAGE PARSER
// ==========================================

function parseBingImageCards(
  $,
  html,
  limit,
  offset,
  query
) {
  const images = [];
  const seen = new Set();

  const selectors = [
    'a.iusc',
    '[m]',
    '[data-m]',
    '[data-bm]',
    '[data-json]',
    '[data-metadata]',
    '[data-image-data]',
    '[data-item]'
  ].join(',');

  $(selectors).each((_, el) => {
    if (images.length >= limit) {
      return false;
    }

    const $el = $(el);

    const rawValues =
      collectImageMetadataFromElement($, el);

    for (const raw of rawValues) {
      const d = parseImageMetadata(raw);

      if (!d || !d.murl) continue;

      const imageUrl = normalizeUrl(d.murl);

      if (
        !imageUrl ||
        seen.has(imageUrl)
      ) {
        continue;
      }

      const built = buildImage(
        d,
        $el,
        offset,
        images.length,
        query,
        raw
      );

      if (!built) continue;

      seen.add(imageUrl);
      images.push(built);

      if (images.length >= limit) {
        return false;
      }
    }
  });

  return images;
}

// ==========================================
// RAW JSON FALLBACK
// ==========================================

function parseMurlFallback(
  html,
  limit,
  offset,
  query
) {
  if (!html) return [];

  const candidates =
    extractJsonCandidates(html);

  const images = [];
  const seen = new Set();

  function addMetadata(d, raw) {
    if (
      !d ||
      images.length >= limit
    ) {
      return;
    }

    const normalized =
      normalizeImageMetadata(d);

    if (!normalized) return;

    const url =
      normalizeUrl(normalized.murl);

    if (
      !url ||
      seen.has(url)
    ) {
      return;
    }

    const built = buildImage(
      normalized,
      null,
      offset,
      images.length,
      query,
      raw
    );

    if (!built) return;

    seen.add(url);
    images.push(built);
  }

  for (const candidate of candidates) {
    if (images.length >= limit) break;

    try {
      const parsed = JSON.parse(candidate);

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (images.length >= limit) break;

          addMetadata(item, candidate);
        }
      } else {
        addMetadata(parsed, candidate);
      }
    } catch (e) {}
  }

  // Regex tambahan untuk metadata yang
  // tidak memiliki pembungkus JSON standar.
  if (images.length < limit) {
    const variants =
      decodeJsonStringLayers(String(html));

    for (const text of variants) {
      if (images.length >= limit) break;

      const keyRegex =
        /\\*["']?\s*(?:murl|mediaUrl|imageUrl|image_url|originalUrl|contentUrl)\s*\\*["']?\s*:/gi;

      let match;

      while (
        (match = keyRegex.exec(text)) !== null &&
        images.length < limit
      ) {
        const start = text.lastIndexOf(
          '{',
          match.index
        );

        if (start < 0) continue;

        const object =
          extractBalancedJson(text, start);

        if (!object) continue;

        try {
          const parsed = JSON.parse(object);

          addMetadata(parsed, object);
        } catch (e) {}
      }
    }
  }

  return images;
}

// ==========================================
// SCRIPT DATA EXTRACTOR
// ==========================================

function parseImagesFromScripts(
  $,
  limit,
  offset,
  query
) {
  const images = [];
  const seen = new Set();

  $('script').each((_, el) => {
    if (images.length >= limit) {
      return false;
    }

    const content =
      $(el).html() || '';

    if (
      !/murl|mediaUrl|imageUrl|originalUrl|contentUrl/i.test(content)
    ) {
      return;
    }

    const parsed =
      parseMurlFallback(
        content,
        limit - images.length,
        offset + images.length,
        query
      );

    for (const item of parsed) {
      if (images.length >= limit) break;

      if (seen.has(item.imageUrl)) continue;

      seen.add(item.imageUrl);

      item.position =
        offset + images.length + 1;

      images.push(item);
    }
  });

  return images;
}

// ==========================================
// BING IMAGE ATTEMPTS
// ==========================================

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
        `&relp=${fetchCount}` +
        `&tsc=ImageBasicHover` +
        `&datsrc=I` +
        `&layout=RowBased` +
        `&mmasync=1` +
        `&adlt=off` +
        `&${common}`
    });

    attempts.push({
      name: `page-${m.mkt}`,
      market: m.mkt,
      acceptLang,
      url:
        `https://www.bing.com/images/search` +
        `?q=${q}` +
        `&first=${offset + 1}` +
        `&count=${fetchCount}` +
        `&${common}`
    });
  }

  return attempts;
}

// ==========================================
// COOKIE BING
// ==========================================

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
            'id-ID,id;q=0.9,en;q=0.7'
        },
        timeout: 7000,
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
  } catch (e) {
    console.warn(
      `[IMAGES] Gagal mengambil cookie Bing: ${e.message}`
    );
  }

  return bingCookie.value;
}

// ==========================================
// IMAGE REQUEST
// ==========================================

async function runImageAttempt(
  attempt,
  query,
  limit,
  offset
) {
  const proxy = getImageProxy();

  const cookie =
    await getBingCookie(proxy);

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
        ...(cookie ? { Cookie: cookie } : {})
      },
      timeout: 12000,
      maxContentLength: 8 * 1024 * 1024,
      ...(proxy ? { proxy } : {})
    }
  );

  const html =
    typeof res.data === 'string'
      ? res.data
      : '';

  const blocked =
    looksBlocked(html);

  const $ = cheerio.load(html);

  let images = [];

  if (!blocked) {
    // Tahap 1: Metadata dari HTML elements.
    images = parseBingImageCards(
      $,
      html,
      limit,
      offset,
      query
    );

    // Tahap 2: Metadata dari seluruh HTML mentah.
    if (images.length < limit) {
      const fallback =
        parseMurlFallback(
          html,
          limit,
          offset,
          query
        );

      const seen = new Set(
        images.map(i => i.imageUrl)
      );

      for (const item of fallback) {
        if (images.length >= limit) break;

        if (seen.has(item.imageUrl)) continue;

        seen.add(item.imageUrl);

        item.position =
          offset + images.length + 1;

        images.push(item);
      }
    }

    // Tahap 3: Data di dalam script.
    if (images.length < limit) {
      const scriptImages =
        parseImagesFromScripts(
          $,
          limit - images.length,
          offset + images.length,
          query
        );

      const seen = new Set(
        images.map(i => i.imageUrl)
      );

      for (const item of scriptImages) {
        if (images.length >= limit) break;

        if (seen.has(item.imageUrl)) continue;

        seen.add(item.imageUrl);

        item.position =
          offset + images.length + 1;

        images.push(item);
      }
    }
  }

  const score =
    relevanceScore(images, query);

  const pageTitle =
    (
      $('title').first().text() || ''
    )
      .trim()
      .slice(0, 80);

  if (images.length === 0) {
    $('script, style').remove();

    const bodyText =
      $('body')
        .text()
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);

    const iuscCount =
      (
        html.match(
          /class=["'][^"']*\biusc\b[^"']*["']/g
        ) || []
      ).length;

    const murlCount =
      (
        html.match(
          /murl|mediaUrl|imageUrl|originalUrl|contentUrl/gi
        ) || []
      ).length;

    console.log(
      `[IMG-DEBUG] ${attempt.name} ` +
      `status=${res.status} ` +
      `len=${html.length} ` +
      `title="${pageTitle}" ` +
      `iusc=${iuscCount} ` +
      `metadataKeys=${murlCount} ` +
      `challenge=${blocked} ` +
      `proxy=${!!proxy} ` +
      `body="${bodyText}"`
    );
  }

  return {
    images,
    score,
    blocked,
    status: res.status,
    htmlLength: html.length,
    pageTitle
  };
}

// ==========================================
// FETCH BING IMAGES
// ==========================================

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

  const errors = [];

  for (const attempt of attempts) {
    try {
      const r = await runImageAttempt(
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
          `EMPTY (${attempt.name}, HTML ${r.htmlLength}B, title "${r.pageTitle}")`
        );
      }

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
      `IRRELEVANT_RESULT: Bing mengembalikan gambar yang tidak cukup relevan dengan "${query}".`
    );
  }

  if (!best) {
    throw new Error(
      `BING_FAILED: ${errors.join(' | ')}`
    );
  }

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

  for (
    let t = 1;
    t <= tries;
    t++
  ) {
    try {
      const out = await fetchImagesBing(
        query,
        config,
        limit,
        offset
      );

      trackSource(
        'bing-images',
        true
      );

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
        bingCookie = {
          value: '',
          at: 0
        };

        await new Promise(
          r => setTimeout(r, 700)
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
// 3. SCRAPER BERITA
// Bing News primer + Google News RSS fallback
// ==========================================

function buildBingNewsCookies(config) {
  const region = config.gl.toUpperCase();
  const lang = config.hl;

  return (
    `_EDGE_CD=m=${region}&u=${lang}; ` +
    `_EDGE_S=mkt=${region}&ui=${lang}`
  );
}

async function fetchNewsViaBing(
  query,
  config,
  limit,
  offset
) {
  try {
    const newsItems = [];

    const first = offset + 1;

    const bingNewsUrl =
      `https://www.bing.com/news/infinitescrollajax` +
      `?q=${encodeURIComponent(query)}` +
      `&InfiniteScroll=1` +
      `&first=${first}`;

    const res = await axios.get(
      bingNewsUrl,
      {
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language':
            'id-ID,id;q=0.9,en;q=0.7',
          'Referer':
            'https://www.bing.com/news',
          'Cookie':
            buildBingNewsCookies(config)
        },
        timeout: 10000,
        maxContentLength: 5 * 1024 * 1024
      }
    );

    const html =
      typeof res.data === 'string'
        ? res.data
        : '';

    if (looksBlocked(html)) {
      throw new Error(
        'BLOCKED_CAPTCHA: Bing News meminta verifikasi atau mendeteksi trafik otomatis.'
      );
    }

    const $ = cheerio.load(html);

    let cards = $('div[class*="newsitem"]');

    if (cards.length === 0) {
      cards = $('[url][class*="news"]');
    }

    cards.each((_, el) => {
      if (newsItems.length >= limit) {
        return false;
      }

      const $el = $(el);

      const link = normalizeUrl(
        $el.attr('url') ||
        $el.find('a.title').first().attr('href')
      );

      const title = $el
        .find('.caption a.title, a.title')
        .first()
        .text()
        .trim();

      if (!title || !link) return;

      const snippet = $el
        .find('.snippet')
        .first()
        .text()
        .trim();

      const sourceSpans = $el.find('.source span');

      const metadataText = sourceSpans
        .map((i, s) =>
          $(s).text().trim()
        )
        .get()
        .filter(Boolean)
        .join(' · ');

      const publisher = sourceSpans
        .first()
        .text()
        .trim();

      const img = $el
        .find('a.imagelink img, img')
        .first();

      const thumbnail = normalizeUrl(
        img.attr('src') ||
        img.attr('data-src') ||
        img.attr('data-original')
      );

      let domain = '';

      try {
        domain = new URL(link)
          .hostname
          .replace(/^www\./, '');
      } catch (e) {}

      newsItems.push({
        title,
        link,
        snippet:
          snippet || 'Tidak ada deskripsi.',
        publisher:
          publisher || domain || 'Berita',
        domain,
        thumbnailUrl: thumbnail,
        publishedAt: metadataText || null,
        position: offset + newsItems.length + 1
      });
    });

    if (newsItems.length === 0) {
      throw new Error(
        'EMPTY_RESULT: Struktur berita Bing tidak ditemukan atau markup berubah.'
      );
    }

    trackSource('bing-news', true);

    return newsItems;
  } catch (err) {
    trackSource('bing-news', false, err.message);
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

    const response = await axios.get(
      rssUrl,
      {
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept':
            'application/rss+xml, application/xml, text/xml, */*'
        },
        timeout: 12000,
        responseType: 'text',
        maxContentLength: 5 * 1024 * 1024
      }
    );

    const feed = await rssParser.parseString(
      response.data
    );

    const rawItems = feed.items || [];

    const pagedItems = rawItems.slice(
      offset,
      offset + limit
    );

    if (pagedItems.length === 0) {
      throw new Error(
        'EMPTY_RESULT: RSS Google News kosong.'
      );
    }

    for (const item of pagedItems) {
      if (!item.title || !item.link) continue;

      let thumbnail = null;

      if (item.mediaThumbnail?.$?.url) {
        thumbnail = item.mediaThumbnail.$.url;
      } else if (item.mediaContent?.$?.url) {
        thumbnail = item.mediaContent.$.url;
      } else {
        thumbnail = extractImageFromHtml(
          item.content ||
          item.snippet ||
          item.summary
        );
      }

      let sourceName = item.source || 'Berita';

      if (
        typeof sourceName === 'object' &&
        sourceName._
      ) {
        sourceName = sourceName._;
      }

      let domain = '';

      try {
        domain = new URL(item.link)
          .hostname
          .replace(/^www\./, '');
      } catch (e) {}

      const cleanSnippet =
        item.contentSnippet ||
        (
          item.content
            ? cheerio.load(item.content).text()
            : ''
        );

      newsItems.push({
        title: item.title.replace(/ - [^-]+$/, ''),
        link: item.link,
        snippet: cleanSnippet.trim(),
        publisher: sourceName,
        domain,
        thumbnailUrl: thumbnail,
        publishedAt:
          item.pubDate || item.isoDate || null,
        position: offset + newsItems.length + 1
      });
    }

    if (newsItems.length === 0) {
      throw new Error(
        'EMPTY_RESULT: Semua item RSS kosong setelah filter.'
      );
    }

    trackSource('google-news-rss', true);

    return newsItems;
  } catch (err) {
    trackSource('google-news-rss', false, err.message);
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
      `[FALLBACK] Bing News gagal (${bingErr.message}), mencoba Google News RSS...`
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
          bingError: bingErr.message,
          rssError: rssErr.message,
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
// 4. CACHE HELPERS
// ==========================================

function getCache(key) {
  const entry = cache.get(key);

  if (!entry) return null;

  if (
    Date.now() - entry.timestamp >= CACHE_TTL
  ) {
    cache.delete(key);
    return null;
  }

  return entry;
}

function setCache(key, data) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;

    if (oldest) {
      cache.delete(oldest);
    }
  }

  cache.set(key, {
    timestamp: Date.now(),
    data
  });
}

// ==========================================
// 5. MAIN ROUTE API
// GET /api/search
// ==========================================

app.get(
  '/api/search',
  async (req, res) => {
    const startTime = Date.now();

    const query =
      typeof req.query.q === 'string'
        ? req.query.q.trim()
        : '';

    const searchType = (
      typeof req.query.type === 'string'
        ? req.query.type
        : 'search'
    ).toLowerCase();

    if (!query) {
      return res.status(400).json({
        status: 'error',
        message: 'Parameter "q" wajib diisi.'
      });
    }

    if (query.length > 500) {
      return res.status(400).json({
        status: 'error',
        message:
          'Query terlalu panjang. Maksimal 500 karakter.'
      });
    }

    if (
      !['search', 'images', 'news'].includes(searchType)
    ) {
      return res.status(400).json({
        status: 'error',
        message:
          'Parameter type hanya mendukung search, images, atau news.'
      });
    }

    const defaultLimit = {
      search: 10,
      images: 20,
      news: 15
    };

    const limit = defaultLimit[searchType];

    let offset = 0;

    if (req.query.start !== undefined) {
      offset = Math.max(
        0,
        parseInt(req.query.start, 10) || 0
      );
    } else if (req.query.page !== undefined) {
      const page = Math.max(
        1,
        parseInt(req.query.page, 10) || 1
      );

      offset = (page - 1) * limit;
    }

    offset = Math.min(offset, 10000);

    const config = resolveLanguageConfig();

    const cacheKey =
      `${searchType}_${query.toLowerCase()}_` +
      `${config.hl}_${config.gl}_${limit}_start${offset}`;

    const staleEntry = getCache(cacheKey);

    if (staleEntry) {
      return res.json(staleEntry.data);
    }

    try {
      let results = [];

      if (searchType === 'images') {
        results = await fetchImages(
          query,
          config,
          limit,
          offset
        );
      } else if (searchType === 'news') {
        results = await fetchNews(
          query,
          config,
          limit,
          offset
        );
      } else {
        results = await fetchWebResults(
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
        results = await finalizeLinks(results);
      }

      if (results.length === 0) {
        return res.status(502).json({
          status: 'error',
          message:
            'Hasil pencarian kosong. Server mungkin diblokir penyedia pencarian atau struktur HTML berubah.',
          searchParameters: {
            q: query,
            type: searchType,
            start: offset
          }
        });
      }

      const searchTime = (
        (Date.now() - startTime) / 1000
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
          page: Math.floor(offset / limit) + 1
        },

        searchInformation: {
          formattedSearchTime: searchTime,
          totalResults: results.length
        },

        provider: results.provider || undefined,

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

      setCache(cacheKey, responsePayload);

      return res.json(responsePayload);
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
          'Semua sumber berita (primer dan fallback) gagal.';
      } else if (
        error.code === 'ECONNABORTED' ||
        error.message.toLowerCase().includes('timeout')
      ) {
        statusCode = 504;

        customMessage =
          'Koneksi timeout ke mesin pencari Bing/Google. Jaringan lambat atau terputus.';
      } else if (
        error.message.includes('BLOCKED_CAPTCHA')
      ) {
        statusCode = 429;

        customMessage =
          'IP server terdeteksi sebagai trafik otomatis atau diminta verifikasi oleh Bing.';
      } else if (error.response) {
        statusCode = error.response.status || 502;

        customMessage =
          `Penyedia pencarian mengembalikan status error ${statusCode}.`;
      }

      return res.status(statusCode).json({
        status: 'error',
        message: customMessage,
        error_detail: error.message
      });
    }
  }
);

// ==========================================
// 6. SOURCE STATUS
// GET /api/status
// ==========================================

app.get(
  '/api/status',
  (req, res) => {
    res.json({
      status: 'success',

      uptime: process.uptime(),

      timestamp: new Date().toISOString(),

      sources: sourceStats,

      cache: {
        entries: cache.size,
        maxEntries: CACHE_MAX,
        ttlMs: CACHE_TTL
      },

      linkCache: {
        entries: linkCache.size,
        maxEntries: LINK_CACHE_MAX
      }
    });
  }
);

// ==========================================
// 7. ROOT
// ==========================================

app.get(
  '/',
  (req, res) => {
    res.json({
      name: 'Search API',
      status: 'online',

      endpoints: {
        search: '/api/search?q=Google',

        images:
          '/api/search?q=kucing&type=images',

        news:
          '/api/search?q=teknologi&type=news',

        status: '/api/status'
      }
    });
  }
);

// ==========================================
// START SERVER
// ==========================================

app.listen(
  PORT,
  () => {
    console.log(
      `Server API berjalan di http://localhost:${PORT}`
    );

    console.log(
      '[CONFIG] Bahasa default: Indonesia (id-ID)'
    );

    console.log(
      '[CONFIG] Limit: search=10, images=20, news=15'
    );

    console.log(
      '[CONFIG] Parameter num, hl, gl tidak diperlukan.'
    );

    console.log(
      '[IMAGES] Advanced nested JSON parser aktif.'
    );
  }
);
