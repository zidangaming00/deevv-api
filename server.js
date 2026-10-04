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
  res.header(
    'Access-Control-Allow-Methods',
    'GET, OPTIONS'
  );

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

  let value = String(url).trim();

  value = decodeEntities(value);

  for (let i = 0; i < 3; i++) {
    const before = value;

    value = value
      .replace(/\\u002f/gi, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/\\u003d/gi, '=')
      .replace(/\\u003f/gi, '?')
      .replace(/\\u0023/gi, '#')
      .replace(/\\u003a/gi, ':')
      .replace(/\\u0025/gi, '%')
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");

    if (before === value) break;
  }

  value = value.trim();

  try {
    if (
      /^https?%3A/i.test(value) ||
      /^https?%3a/i.test(value)
    ) {
      value = decodeURIComponent(value);
    }
  } catch (e) {}

  try {
    const parsed = new URL(value, base);

    if (
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'https:'
    ) {
      return null;
    }

    return parsed.toString();
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
      img.attr('data-original') ||
      img.attr('data-iurl') ||
      img.attr('data-murl')
    );
  } catch (e) {
    return null;
  }
}

// ==========================================
// SOURCE STATISTICS
// ==========================================

const sourceStats = {};

function alertEcosystem(
  level,
  message,
  meta = {}
) {
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

function trackSource(
  name,
  ok,
  errMsg = null
) {
  const s =
    sourceStats[name] ||
    (
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
    s.lastSuccessAt =
      new Date().toISOString();
  } else {
    s.failure++;
    s.consecutiveFailures++;
    s.lastError = errMsg;
    s.lastFailureAt =
      new Date().toISOString();

    if (
      s.consecutiveFailures === 3
    ) {
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
  if (typeof html !== 'string') {
    return false;
  }

  return /captcha|unusual traffic|are you a robot|verify you are human|robot check|geetest|cf-browser-verification|challenge-platform|automated queries|suspicious activity/i.test(
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
    const out =
      decodeBase64Url(val.slice(k));

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
    const pathname =
      new URL(link).pathname;

    const m =
      pathname.match(
        /\/articles\/([^/?]+)/
      );

    if (!m) return null;

    const encoded =
      m[1]
        .replace(/-/g, '+')
        .replace(/_/g, '/');

    let padded = encoded;

    while (padded.length % 4) {
      padded += '=';
    }

    const raw =
      Buffer
        .from(padded, 'base64')
        .toString('latin1');

    const found =
      raw.match(
        /https?:\/\/[\x21-\x7e]+/
      );

    return found
      ? found[0]
      : null;
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
      const u =
        new URL(current);

      if (
        u.hostname ===
        'news.google.com'
      ) {
        next =
          decodeGoogleNewsArticle(
            current
          );
      }

      if (!next) {
        for (
          const p of REDIRECT_PARAMS
        ) {
          const v =
            u.searchParams.get(p);

          const decoded =
            decodeBingParam(v);

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
      const res =
        await axios.get(
          current,
          {
            headers: {
              'User-Agent':
                getRandomUserAgent(),
              'Accept':
                'text/html,*/*;q=0.8'
            },
            timeout: 5000,
            maxRedirects: 0,
            responseType: 'text',
            maxContentLength:
              512 * 1024,
            validateStatus:
              s => s < 400
          }
        );

      if (
        res.status >= 300 &&
        res.headers.location
      ) {
        current =
          new URL(
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

      const next =
        m[1]
          .replace(/&amp;/g, '&')
          .replace(/\\u0026/g, '&')
          .replace(/\\\//g, '/');

      current =
        new URL(
          next,
          current
        ).toString();
    } catch (e) {
      const loc =
        e.response?.headers?.location;

      if (loc) {
        current =
          new URL(
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

  let finalUrl =
    resolveByParams(link);

  if (
    isSearchEngineUrl(finalUrl)
  ) {
    const viaHttp =
      await resolveByHttp(
        finalUrl
      );

    if (viaHttp) {
      finalUrl = viaHttp;
    }
  }

  const result = {
    link: finalUrl,
    resolved:
      !isSearchEngineUrl(finalUrl)
  };

  if (
    linkCache.size >=
    LINK_CACHE_MAX
  ) {
    const oldest =
      linkCache.keys().next().value;

    if (oldest) {
      linkCache.delete(oldest);
    }
  }

  linkCache.set(
    link,
    result
  );

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
    const chunk =
      out.slice(
        i,
        i + concurrency
      );

    await Promise.all(
      chunk.map(
        async item => {
          const original =
            item.link;

          const r =
            await resolveLink(
              original
            );

          item.link = r.link;
          item.linkResolved =
            r.resolved;

          if (
            r.link !== original
          ) {
            try {
              item.domain =
                new URL(r.link)
                  .hostname
                  .replace(
                    /^www\./,
                    ''
                  );
            } catch (e) {}
          }
        }
      )
    );
  }

  const failed =
    out.filter(
      i =>
        i.linkResolved === false
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

    const firstIndex =
      offset + 1;

    const bingWebUrl =
      `https://www.bing.com/search?q=${encodeURIComponent(query)}` +
      `&setmkt=${config.mkt}` +
      `&setlang=${config.hl}` +
      `&first=${firstIndex}`;

    const res =
      await axios.get(
        bingWebUrl,
        {
          headers: {
            'User-Agent':
              getRandomUserAgent(),
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

    const $ =
      cheerio.load(html);

    $('li.b_algo').each(
      (_, el) => {
        if (
          items.length >= limit
        ) {
          return false;
        }

        const titleEl =
          $(el)
            .find('h2 a')
            .first();

        const snippetEl =
          $(el)
            .find(
              'div.b_caption p, p.b_lineclamp'
            )
            .first();

        const title =
          titleEl
            .text()
            .trim();

        const link =
          normalizeUrl(
            titleEl.attr('href')
          );

        const snippet =
          snippetEl
            .text()
            .trim();

        if (
          !title ||
          !link
        ) {
          return;
        }

        let domain = '';

        try {
          domain =
            new URL(link)
              .hostname
              .replace(
                /^www\./,
                ''
              );
        } catch (e) {}

        items.push({
          title,
          link,
          snippet:
            snippet ||
            'Tidak ada deskripsi.',
          domain,
          position:
            offset +
            items.length +
            1
        });
      }
    );

    if (
      items.length === 0
    ) {
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
    attr: () => ''
  }),
  closest: () => ({
    find: () => ({
      text: () => ''
    })
  })
};

function queryTokens(query) {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      t => t.length >= 3
    );
}

function relevanceScore(
  images,
  query
) {
  const tokens =
    queryTokens(query);

  if (
    tokens.length === 0 ||
    images.length === 0
  ) {
    return 1;
  }

  let hits = 0;

  for (const img of images) {
    const hay =
      `${img.title} ${img.pageUrl} ${img.imageUrl} ${img.source}`
        .toLowerCase();

    if (
      tokens.some(
        t => hay.includes(t)
      )
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
    String(val).match(
      /\d+/
    );

  if (!match) return 0;

  const num =
    parseInt(
      match[0],
      10
    );

  return Number.isFinite(num)
    ? num
    : 0;
}

// ==========================================
// HTML ENTITY DECODER
// ==========================================

function decodeEntities(s) {
  if (!s) return '';

  let value =
    String(s);

  value =
    value
      .replace(
        /&quot;/gi,
        '"'
      )
      .replace(
        /&amp;/gi,
        '&'
      )
      .replace(
        /&apos;/gi,
        "'"
      )
      .replace(
        /&#39;/gi,
        "'"
      )
      .replace(
        /&#x27;/gi,
        "'"
      )
      .replace(
        /&lt;/gi,
        '<'
      )
      .replace(
        /&gt;/gi,
        '>'
      );

  value =
    value.replace(
      /&#x([0-9a-f]+);/gi,
      (_, h) => {
        try {
          return String.fromCodePoint(
            parseInt(h, 16)
          );
        } catch (e) {
          return _;
        }
      }
    );

  value =
    value.replace(
      /&#(\d+);/g,
      (_, d) => {
        try {
          return String.fromCodePoint(
            parseInt(d, 10)
          );
        } catch (e) {
          return _;
        }
      }
    );

  return value
    .replace(
      /\\u0022/gi,
      '"'
    )
    .replace(
      /\\u0027/gi,
      "'"
    )
    .replace(
      /\\u0026/gi,
      '&'
    )
    .replace(
      /\\u002f/gi,
      '/'
    )
    .replace(
      /\\u003d/gi,
      '='
    )
    .replace(
      /\\u003f/gi,
      '?'
    )
    .replace(
      /\\u003a/gi,
      ':'
    )
    .replace(
      /\\\//g,
      '/'
    );
}

// ==========================================
// NORMALIZE ESCAPED MARKUP
// ==========================================

function normalizeMarkupForScan(
  value
) {
  if (!value) return '';

  let s =
    decodeEntities(
      String(value)
    );

  for (
    let i = 0;
    i < 3;
    i++
  ) {
    const next =
      s.replace(
        /\\u([0-9a-f]{4})/gi,
        (_, hex) => {
          try {
            return String.fromCharCode(
              parseInt(
                hex,
                16
              )
            );
          } catch (e) {
            return _;
          }
        }
      );

    if (
      next === s
    ) {
      break;
    }

    s = next;
  }

  return s
    .replace(
      /\\"/g,
      '"'
    )
    .replace(
      /\\'/g,
      "'"
    )
    .replace(
      /\\\//g,
      '/'
    );
}

// ==========================================
// JSON STRING DECODER
// ==========================================

function decodeJsonStringValue(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return '';
  }

  let s =
    String(value);

  s =
    decodeEntities(s);

  try {
    if (
      s.length >= 2 &&
      s[0] === '"' &&
      s[s.length - 1] === '"'
    ) {
      const parsed =
        JSON.parse(s);

      if (
        typeof parsed === 'string'
      ) {
        return parsed;
      }
    }
  } catch (e) {}

  return s
    .replace(
      /\\"/g,
      '"'
    )
    .replace(
      /\\\\/g,
      '\\'
    )
    .replace(
      /\\\//g,
      '/'
    );
}

// ==========================================
// ESCAPE REGEX
// ==========================================

function escapeRegExp(
  value
) {
  return String(value)
    .replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );
}

// ==========================================
// VALIDASI IMAGE URL
// ==========================================

function isProbablyImageUrl(
  url
) {
  if (!url) return false;

  const normalized =
    normalizeUrl(url);

  if (!normalized) {
    return false;
  }

  try {
    const u =
      new URL(normalized);

    if (
      u.protocol !== 'http:' &&
      u.protocol !== 'https:'
    ) {
      return false;
    }

    const host =
      u.hostname.toLowerCase();

    const path =
      u.pathname.toLowerCase();

    if (
      host === 'bing.com' ||
      host.endsWith('.bing.com')
    ) {
      // Bing thumbnail boleh digunakan sebagai fallback.
      // Asset branding/static tetap ditolak.
      if (
        path.includes('/rp/') ||
        path.includes('/sa/simg/') ||
        path.includes('/images/branding/')
      ) {
        return false;
      }
    }

    if (
      path.includes('favicon') ||
      path.includes('logo.svg') ||
      path.includes('logo.png') ||
      path.includes('spacer.gif')
    ) {
      return false;
    }

    return true;
  } catch (e) {
    return false;
  }
}

// ==========================================
// EXTRACT FIELD DARI JSON-LIKE TEXT
// ==========================================

function extractLooseField(
  text,
  names
) {
  if (!text) return '';

  const namePattern =
    names
      .map(escapeRegExp)
      .join('|');

  const source =
    String(text);

  const patterns = [
    new RegExp(
      `["']?(?:${namePattern})["']?\\s*[:=]\\s*"((?:\\\\.|[^"\\\\])*)"`,
      'i'
    ),

    new RegExp(
      `["']?(?:${namePattern})["']?\\s*[:=]\\s*'((?:\\\\.|[^'\\\\])*)'`,
      'i'
    ),

    new RegExp(
      `["']?(?:${namePattern})["']?\\s*[:=]\\s*([^,}\\]\\s]+)`,
      'i'
    )
  ];

  for (
    const regex
    of patterns
  ) {
    const m =
      source.match(regex);

    if (!m) continue;

    const value =
      m[1];

    if (!value) continue;

    return decodeJsonStringValue(
      value
    ).trim();
  }

  return '';
}

// ==========================================
// GENERIC IMAGE FIELD NAMES
// ==========================================

const IMAGE_FIELDS = [
  'murl',
  'mediaUrl',
  'mediaURL',
  'imageUrl',
  'imageURL',
  'contentUrl',
  'contentURL',
  'originalUrl',
  'originalURL',
  'originalImageUrl',
  'originalImage',
  'imgurl',
  'imgUrl',
  'objurl',
  'objUrl'
];

const PAGE_FIELDS = [
  'purl',
  'pageUrl',
  'pageURL',
  'sourceUrl',
  'sourceURL',
  'hostPageUrl',
  'hostPageURL',
  'page'
];

const THUMB_FIELDS = [
  'turl',
  'thumbnailUrl',
  'thumbnailURL',
  'thumbnail',
  'thumbUrl',
  'thumbURL',
  'thumb'
];

const TITLE_FIELDS = [
  't',
  'title',
  'name',
  'caption',
  'alt'
];

const DESC_FIELDS = [
  'desc',
  'description'
];

// ==========================================
// PARSE LOOSE METADATA
// ==========================================

function parseLooseMetadata(
  raw
) {
  if (!raw) return null;

  const text =
    normalizeMarkupForScan(
      raw
    );

  const murl =
    extractLooseField(
      text,
      IMAGE_FIELDS
    );

  if (
    !murl ||
    !isProbablyImageUrl(murl)
  ) {
    return null;
  }

  const purl =
    extractLooseField(
      text,
      PAGE_FIELDS
    );

  const turl =
    extractLooseField(
      text,
      THUMB_FIELDS
    );

  const title =
    extractLooseField(
      text,
      TITLE_FIELDS
    );

  const desc =
    extractLooseField(
      text,
      DESC_FIELDS
    );

  const ow =
    extractLooseField(
      text,
      [
        'ow',
        'originalWidth',
        'original_width',
        'imageWidth',
        'image_width'
      ]
    );

  const oh =
    extractLooseField(
      text,
      [
        'oh',
        'originalHeight',
        'original_height',
        'imageHeight',
        'image_height'
      ]
    );

  const w =
    extractLooseField(
      text,
      [
        'w',
        'width'
      ]
    );

  const h =
    extractLooseField(
      text,
      [
        'h',
        'height'
      ]
    );

  return {
    murl,
    purl,
    turl,
    t:
      title || desc,
    title,
    desc,
    ow,
    oh,
    w,
    h
  };
}

// ==========================================
// GLOBAL LOOSE IMAGE FIELD SCANNER
//
// Ini penting kalau Bing menghilangkan
// struktur a.iusc tetapi URL gambar masih
// berada di HTML/JS.
// ==========================================

function extractLooseImageEntries(
  rawText,
  limit = 100
) {
  if (
    !rawText ||
    limit <= 0
  ) {
    return [];
  }

  const text =
    normalizeMarkupForScan(
      rawText
    );

  const fieldPattern =
    IMAGE_FIELDS
      .map(escapeRegExp)
      .join('|');

  const regex =
    new RegExp(
      `["']?(?:${fieldPattern})["']?\\s*[:=]\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|([^,}\\]\\s]+))`,
      'gi'
    );

  const results = [];
  const seen =
    new Set();

  let match;

  while (
    (
      match =
        regex.exec(text)
    ) &&
    results.length <
      limit
  ) {
    const rawUrl =
      match[1] ??
      match[2] ??
      match[3] ??
      '';

    const imageUrl =
      normalizeUrl(
        decodeJsonStringValue(
          rawUrl
        )
      );

    if (
      !imageUrl ||
      !isProbablyImageUrl(
        imageUrl
      ) ||
      seen.has(imageUrl)
    ) {
      continue;
    }

    seen.add(imageUrl);

    // Ambil metadata di sekitar URL.
    // Window sengaja cukup besar karena Bing kadang
    // menaruh purl/title sebelum murl.
    const start =
      Math.max(
        0,
        match.index - 12000
      );

    const end =
      Math.min(
        text.length,
        match.index + 16000
      );

    const windowText =
      text.slice(
        start,
        end
      );

    const data = {
      murl:
        imageUrl,

      purl:
        extractLooseField(
          windowText,
          PAGE_FIELDS
        ),

      turl:
        extractLooseField(
          windowText,
          THUMB_FIELDS
        ),

      t:
        extractLooseField(
          windowText,
          TITLE_FIELDS
        ),

      title:
        extractLooseField(
          windowText,
          TITLE_FIELDS
        ),

      desc:
        extractLooseField(
          windowText,
          DESC_FIELDS
        ),

      ow:
        extractLooseField(
          windowText,
          [
            'ow',
            'originalWidth',
            'original_width',
            'imageWidth'
          ]
        ),

      oh:
        extractLooseField(
          windowText,
          [
            'oh',
            'originalHeight',
            'original_height',
            'imageHeight'
          ]
        ),

      w:
        extractLooseField(
          windowText,
          [
            'w',
            'width'
          ]
        ),

      h:
        extractLooseField(
          windowText,
          [
            'h',
            'height'
          ]
        )
    };

    results.push({
      data,
      raw:
        windowText
    });
  }

  return results;
}

// ==========================================
// EXTRACT DIMENSIONS
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

  for (
    const value of originalWidthFields
  ) {
    const n =
      safeParseInt(value);

    if (n > 0) {
      width = n;
      break;
    }
  }

  for (
    const value of originalHeightFields
  ) {
    const n =
      safeParseInt(value);

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

    for (
      const value of fields
    ) {
      const n =
        safeParseInt(value);

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

    for (
      const value of fields
    ) {
      const n =
        safeParseInt(value);

      if (n > 0) {
        height = n;
        break;
      }
    }
  }

  if (
    !width ||
    !height
  ) {
    const sources = [
      mData?.dim,
      mData?.dimensions,
      mData?.size,
      mData?.resolution,
      mData?.imageSize,
      mData?.imageDimensions
    ];

    for (
      const value of sources
    ) {
      if (!value) continue;

      const match =
        String(value).match(
          /(\d{2,6})\s*[x×]\s*(\d{2,6})/i
        );

      if (match) {
        if (!width) {
          width =
            parseInt(
              match[1],
              10
            );
        }

        if (!height) {
          height =
            parseInt(
              match[2],
              10
            );
        }

        if (
          width &&
          height
        ) {
          break;
        }
      }
    }
  }

  if (
    (!width || !height) &&
    rawM
  ) {
    const raw =
      normalizeMarkupForScan(
        rawM
      );

    const widthMatch =
      raw.match(
        /["']?(?:ow|originalWidth|imageWidth|width)["']?\s*[:=]\s*["']?(\d{2,6})/i
      );

    const heightMatch =
      raw.match(
        /["']?(?:oh|originalHeight|imageHeight|height)["']?\s*[:=]\s*["']?(\d{2,6})/i
      );

    if (
      !width &&
      widthMatch
    ) {
      width =
        parseInt(
          widthMatch[1],
          10
        );
    }

    if (
      !height &&
      heightMatch
    ) {
      height =
        parseInt(
          heightMatch[1],
          10
        );
    }

    if (
      !width ||
      !height
    ) {
      const dimMatch =
        raw.match(
          /(?:dimensions?|resolution|size|imageSize|dim)["']?\s*[:=]\s*["']?(\d{2,6})\s*[x×]\s*(\d{2,6})/i
        );

      if (dimMatch) {
        if (!width) {
          width =
            parseInt(
              dimMatch[1],
              10
            );
        }

        if (!height) {
          height =
            parseInt(
              dimMatch[2],
              10
            );
        }
      }
    }
  }

  if (
    $el &&
    typeof $el.attr ===
      'function'
  ) {
    const attrs = [
      $el.attr('data-dim'),
      $el.attr('data-size'),
      $el.attr('data-resolution'),
      $el.attr('data-image-dim'),
      $el.attr('data-image-size')
    ];

    const img =
      $el
        .find('img')
        .first();

    attrs.push(
      img.attr('data-dim'),
      img.attr('data-size'),
      img.attr(
        'data-resolution'
      ),
      img.attr(
        'data-image-dim'
      ),
      img.attr(
        'data-image-size'
      )
    );

    for (
      const value of attrs
    ) {
      if (!value) continue;

      const match =
        String(value).match(
          /(\d{2,6})\s*[x×]\s*(\d{2,6})/i
        );

      if (match) {
        if (!width) {
          width =
            parseInt(
              match[1],
              10
            );
        }

        if (!height) {
          height =
            parseInt(
              match[2],
              10
            );
        }

        if (
          width &&
          height
        ) {
          break;
        }
      }
    }
  }

  if (
    (!width || !height) &&
    $el &&
    typeof $el.closest ===
      'function'
  ) {
    try {
      const container =
        $el.closest('li');

      const captionText =
        container
          .find(
            '.img_info .nowrap, .img_info, .imgpt .nowrap'
          )
          .first()
          .text() ||
        '';

      const match =
        captionText.match(
          /(\d{2,6})\s*[x×]\s*(\d{2,6})/i
        );

      if (match) {
        if (!width) {
          width =
            parseInt(
              match[1],
              10
            );
        }

        if (!height) {
          height =
            parseInt(
              match[2],
              10
            );
        }
      }
    } catch (e) {}
  }

  if (
    (!width || !height) &&
    $el &&
    typeof $el.find ===
      'function'
  ) {
    try {
      const thumb =
        $el
          .find('img')
          .first();

      const tw =
        safeParseInt(
          thumb.attr('width')
        );

      const th =
        safeParseInt(
          thumb.attr('height')
        );

      if (
        tw > 0 &&
        th > 0
      ) {
        width =
          width || tw;
        height =
          height || th;
      }
    } catch (e) {}
  }

  return {
    width:
      width || null,
    height:
      height || null
  };
}

// ==========================================
// IMAGE PROXY
// ==========================================

function getImageProxy() {
  const raw =
    process.env.IMAGE_PROXY_URL;

  if (!raw) return null;

  try {
    const u =
      new URL(raw);

    if (
      ![
        'http:',
        'https:'
      ].includes(
        u.protocol
      )
    ) {
      return null;
    }

    return {
      protocol:
        u.protocol.replace(
          ':',
          ''
        ),
      host:
        u.hostname,
      port:
        Number(u.port) ||
        (
          u.protocol ===
          'https:'
            ? 443
            : 80
        ),
      ...(u.username
        ? {
            auth: {
              username:
                decodeURIComponent(
                  u.username
                ),
              password:
                decodeURIComponent(
                  u.password
                )
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
// PARSE IMAGE METADATA
// ==========================================

function parseImageMetadata(raw) {
  if (!raw) return null;

  const original =
    String(raw);

  const candidates = [
    original,
    decodeEntities(original),
    normalizeMarkupForScan(original),
    original
      .replace(
        /\\"/g,
        '"'
      )
      .replace(
        /\\'/g,
        "'"
      ),
    decodeJsonStringValue(
      original
    )
  ];

  const unique =
    [...new Set(
      candidates.filter(Boolean)
    )];

  for (
    const candidate
    of unique
  ) {
    try {
      const parsed =
        JSON.parse(candidate);

      if (
        parsed &&
        typeof parsed ===
          'object' &&
        (
          parsed.murl ||
          parsed.mediaUrl ||
          parsed.imageUrl ||
          parsed.contentUrl ||
          parsed.originalUrl ||
          parsed.imgurl ||
          parsed.objurl
        )
      ) {
        return parsed;
      }
    } catch (e) {}
  }

  const loose =
    parseLooseMetadata(
      original
    );

  if (loose) {
    return loose;
  }

  return null;
}

// ==========================================
// BALANCED OBJECT EXTRACTOR
// ==========================================

function extractBalancedJsonObject(
  text,
  startIndex
) {
  if (
    !text ||
    startIndex < 0 ||
    startIndex >= text.length
  ) {
    return null;
  }

  let start =
    startIndex;

  if (
    text[start] !== '{'
  ) {
    start =
      text.indexOf(
        '{',
        start
      );
  }

  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let quote = '"';
  let escaped = false;

  for (
    let i = start;
    i < text.length;
    i++
  ) {
    const ch =
      text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (
        ch === '\\'
      ) {
        escaped = true;
        continue;
      }

      if (
        ch === quote
      ) {
        inString = false;
      }

      continue;
    }

    if (
      ch === '"' ||
      ch === "'"
    ) {
      inString = true;
      quote = ch;
      continue;
    }

    if (
      ch === '{'
    ) {
      depth++;
      continue;
    }

    if (
      ch === '}'
    ) {
      depth--;

      if (depth === 0) {
        return text.slice(
          start,
          i + 1
        );
      }
    }
  }

  return null;
}

// ==========================================
// CARI OBJECT DENGAN IMAGE FIELD
// ==========================================

function extractMurlObjects(
  rawHtml,
  limit = 50
) {
  if (
    !rawHtml ||
    limit <= 0
  ) {
    return [];
  }

  const variants = [
    String(rawHtml),
    decodeEntities(
      String(rawHtml)
    ),
    normalizeMarkupForScan(
      String(rawHtml)
    )
  ];

  const results = [];
  const seenUrls =
    new Set();

  for (
    const variant
    of variants
  ) {
    if (
      results.length >=
      limit
    ) {
      break;
    }

    const text =
      variant;

    const markerRegex =
      new RegExp(
        `["']?(?:${IMAGE_FIELDS.map(escapeRegExp).join('|')})["']?\\s*[:=]`,
        'gi'
      );

    let marker;

    while (
      (
        marker =
          markerRegex.exec(
            text
          )
      ) &&
      results.length <
        limit
    ) {
      const markerIndex =
        marker.index;

      let cursor =
        markerIndex;

      let found =
        false;

      for (
        let tries = 0;
        tries < 50;
        tries++
      ) {
        const objectStart =
          text.lastIndexOf(
            '{',
            cursor
          );

        if (
          objectStart < 0 ||
          markerIndex -
            objectStart >
            80000
        ) {
          break;
        }

        const objectText =
          extractBalancedJsonObject(
            text,
            objectStart
          );

        if (objectText) {
          const parsed =
            parseImageMetadata(
              objectText
            );

          if (
            parsed &&
            (
              parsed.murl ||
              parsed.mediaUrl ||
              parsed.imageUrl ||
              parsed.contentUrl ||
              parsed.originalUrl ||
              parsed.imgurl ||
              parsed.objurl
            )
          ) {
            const url =
              normalizeUrl(
                parsed.murl ||
                parsed.mediaUrl ||
                parsed.imageUrl ||
                parsed.contentUrl ||
                parsed.originalUrl ||
                parsed.imgurl ||
                parsed.objurl
              );

            if (
              url &&
              isProbablyImageUrl(
                url
              ) &&
              !seenUrls.has(
                url
              )
            ) {
              seenUrls.add(
                url
              );

              results.push({
                data:
                  parsed,
                raw:
                  objectText
              });

              found = true;
            }

            break;
          }
        }

        cursor =
          objectStart - 1;
      }

      if (
        !found &&
        results.length <
          limit
      ) {
        const windowStart =
          Math.max(
            0,
            markerIndex - 12000
          );

        const windowEnd =
          Math.min(
            text.length,
            markerIndex + 18000
          );

        const windowText =
          text.slice(
            windowStart,
            windowEnd
          );

        const loose =
          parseLooseMetadata(
            windowText
          );

        if (loose) {
          const url =
            normalizeUrl(
              loose.murl
            );

          if (
            url &&
            isProbablyImageUrl(
              url
            ) &&
            !seenUrls.has(
              url
            )
          ) {
            seenUrls.add(
              url
            );

            results.push({
              data:
                loose,
              raw:
                windowText
            });
          }
        }
      }
    }
  }

  // Global scanner terakhir untuk struktur yang
  // tidak mempunyai object JSON yang rapi.
  if (
    results.length <
    limit
  ) {
    const looseEntries =
      extractLooseImageEntries(
        rawHtml,
        limit -
          results.length
      );

    for (
      const item
      of looseEntries
    ) {
      const url =
        normalizeUrl(
          item.data?.murl
        );

      if (
        !url ||
        !isProbablyImageUrl(
          url
        ) ||
        seenUrls.has(url)
      ) {
        continue;
      }

      seenUrls.add(url);
      results.push(item);

      if (
        results.length >=
        limit
      ) {
        break;
      }
    }
  }

  return results;
}

// ==========================================
// PARSE ATTRIBUTE M / DATA-M
// ==========================================

function parseMetadataFromElement(
  $,
  $el
) {
  const attrs = [
    'm',
    'data-m',
    'data-metadata',
    'data-image',
    'data-json',
    'data-meta',
    'data-item',
    'data-img',
    'data-image-data',
    'data-image-metadata',
    'data-img-data',
    'data-imgurl',
    'data-murl',
    'data-iurl',
    'data-objurl',
    'data-content-url'
  ];

  for (
    const attr
    of attrs
  ) {
    const raw =
      $el.attr(attr);

    if (!raw) {
      continue;
    }

    const parsed =
      parseImageMetadata(
        raw
      );

    if (
      parsed &&
      (
        parsed.murl ||
        parsed.mediaUrl ||
        parsed.imageUrl ||
        parsed.contentUrl ||
        parsed.originalUrl ||
        parsed.imgurl ||
        parsed.objurl
      )
    ) {
      return {
        data:
          parsed,
        raw
      };
    }

    const extracted =
      extractMurlObjects(
        raw,
        1
      );

    if (
      extracted.length
    ) {
      return extracted[0];
    }
  }

  // Scan seluruh atribut.
  const rawAttrs =
    $el[0]?.attribs || {};

  for (
    const [name, value]
    of Object.entries(
      rawAttrs
    )
  ) {
    if (
      typeof value !==
      'string'
    ) {
      continue;
    }

    if (
      !/murl|image|metadata|json|media|thumbnail|content|imgurl|objurl|iurl/i.test(
        name
      ) &&
      !/murl|mediaUrl|imageUrl|contentUrl|originalUrl|imgurl|objurl/i.test(
        value
      )
    ) {
      continue;
    }

    const parsed =
      parseImageMetadata(
        value
      );

    if (
      parsed &&
      (
        parsed.murl ||
        parsed.mediaUrl ||
        parsed.imageUrl ||
        parsed.contentUrl ||
        parsed.originalUrl ||
        parsed.imgurl ||
        parsed.objurl
      )
    ) {
      return {
        data:
          parsed,
        raw:
          value
      };
    }

    const extracted =
      extractMurlObjects(
        value,
        1
      );

    if (
      extracted.length
    ) {
      return extracted[0];
    }

    const loose =
      parseLooseMetadata(
        value
      );

    if (
      loose
    ) {
      return {
        data:
          loose,
        raw:
          value
      };
    }
  }

  return null;
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
  if (
    !d ||
    typeof d !== 'object'
  ) {
    return null;
  }

  const imageUrl =
    normalizeUrl(
      d.murl ||
      d.mediaUrl ||
      d.imageUrl ||
      d.contentUrl ||
      d.originalUrl ||
      d.originalImageUrl ||
      d.originalImage ||
      d.imgurl ||
      d.objurl
    );

  const thumbnailUrl =
    normalizeUrl(
      d.turl ||
      d.thumbnailUrl ||
      d.thumbnail ||
      d.thumbUrl
    );

  const targetLink =
    normalizeUrl(
      d.purl ||
      d.pageUrl ||
      d.sourceUrl ||
      d.hostPageUrl
    );

  if (
    !imageUrl ||
    !isProbablyImageUrl(
      imageUrl
    )
  ) {
    return null;
  }

  const title =
    d.t ||
    d.title ||
    d.name ||
    d.caption ||
    d.alt ||
    d.desc ||
    query;

  let domain = '';

  try {
    domain =
      new URL(
        targetLink ||
        imageUrl
      )
        .hostname
        .replace(
          /^www\./,
          ''
        );
  } catch (e) {}

  const dims =
    extractDimensions(
      d,
      $el || NO_EL,
      rawM
    );

  return {
    title:
      String(title)
        .replace(
          /<[^>]+>/g,
          ''
        )
        .replace(
          /\s+/g,
          ' '
        )
        .trim(),

    image:
      imageUrl,

    imageUrl:
      imageUrl,

    thumbnail:
      thumbnailUrl ||
      imageUrl,

    thumbnailUrl:
      thumbnailUrl ||
      imageUrl,

    width:
      dims.width,

    height:
      dims.height,

    source:
      domain || '',

    domain:
      domain || '',

    pageUrl:
      targetLink ||
      imageUrl,

    link:
      targetLink ||
      imageUrl,

    position:
      offset +
      count +
      1
  };
}

// ==========================================
// PARSER #1
// BING CLASSIC / IUSC
// ==========================================

function parseBingImageCards(
  $,
  html,
  limit,
  offset,
  query
) {
  const images = [];
  const seen =
    new Set();

  const selectors = [
    'a.iusc',
    '[m]',
    '[data-m]',
    '[data-metadata]',
    '[data-image]',
    '[data-json]',
    '[data-meta]',
    '[data-item]',
    '[data-img]',
    '[data-image-data]',
    '[data-image-metadata]',
    '[data-img-data]',
    '[data-murl]',
    '[data-imgurl]',
    '[data-iurl]',
    '[data-objurl]'
  ];

  $(selectors.join(','))
    .each(
      (_, el) => {
        if (
          images.length >=
          limit
        ) {
          return false;
        }

        const $el =
          $(el);

        const parsed =
          parseMetadataFromElement(
            $,
            $el
          );

        if (
          !parsed ||
          !parsed.data
        ) {
          return;
        }

        const d =
          parsed.data;

        const imageUrl =
          normalizeUrl(
            d.murl ||
            d.mediaUrl ||
            d.imageUrl ||
            d.contentUrl ||
            d.originalUrl ||
            d.imgurl ||
            d.objurl
          );

        if (
          !imageUrl ||
          !isProbablyImageUrl(
            imageUrl
          ) ||
          seen.has(
            imageUrl
          )
        ) {
          return;
        }

        seen.add(
          imageUrl
        );

        const built =
          buildImage(
            d,
            $el,
            offset,
            images.length,
            query,
            parsed.raw
          );

        if (built) {
          images.push(
            built
          );
        }
      }
    );

  return images;
}

// ==========================================
// PARSER #2
// RAW HTML / JSON-LIKE
// ==========================================

function parseMurlFallback(
  html,
  limit,
  offset,
  query
) {
  if (!html) {
    return [];
  }

  const objects =
    extractMurlObjects(
      html,
      Math.max(
        limit * 5,
        100
      )
    );

  const images = [];
  const seen =
    new Set();

  for (
    const item
    of objects
  ) {
    if (
      images.length >=
      limit
    ) {
      break;
    }

    const d =
      item.data;

    if (!d) {
      continue;
    }

    const url =
      normalizeUrl(
        d.murl ||
        d.mediaUrl ||
        d.imageUrl ||
        d.contentUrl ||
        d.originalUrl ||
        d.imgurl ||
        d.objurl
      );

    if (
      !url ||
      !isProbablyImageUrl(
        url
      ) ||
      seen.has(url)
    ) {
      continue;
    }

    seen.add(url);

    const built =
      buildImage(
        d,
        null,
        offset,
        images.length,
        query,
        item.raw
      );

    if (built) {
      images.push(
        built
      );
    }
  }

  return images;
}

// ==========================================
// PARSER #3
// SCRIPT
// ==========================================

function parseBingScriptMetadata(
  html,
  limit,
  offset,
  query
) {
  if (!html) {
    return [];
  }

  const $ =
    cheerio.load(
      html
    );

  const images = [];
  const seen =
    new Set();

  $('script').each(
    (_, script) => {
      if (
        images.length >=
        limit
      ) {
        return false;
      }

      const content =
        $(script).html() ||
        '';

      if (
        !/murl|mediaUrl|imageUrl|contentUrl|originalUrl|imgurl|objurl/i.test(
          content
        )
      ) {
        return;
      }

      const objects =
        extractMurlObjects(
          content,
          Math.max(
            limit * 4,
            80
          )
        );

      for (
        const item
        of objects
      ) {
        if (
          images.length >=
          limit
        ) {
          break;
        }

        const d =
          item.data;

        if (!d) {
          continue;
        }

        const url =
          normalizeUrl(
            d.murl ||
            d.mediaUrl ||
            d.imageUrl ||
            d.contentUrl ||
            d.originalUrl ||
            d.imgurl ||
            d.objurl
          );

        if (
          !url ||
          !isProbablyImageUrl(
            url
          ) ||
          seen.has(url)
        ) {
          continue;
        }

        seen.add(url);

        const built =
          buildImage(
            d,
            null,
            offset,
            images.length,
            query,
            item.raw
          );

        if (built) {
          images.push(
            built
          );
        }
      }
    }
  );

  return images;
}

// ==========================================
// PARSER #4
// LOOSE ATTRIBUTES
// ==========================================

function parseLooseImageMetadata(
  html,
  limit,
  offset,
  query
) {
  if (!html) {
    return [];
  }

  const $ =
    cheerio.load(
      html
    );

  const images = [];
  const seen =
    new Set();

  $(
    'a, img, div, li, article, figure, [class]'
  )
    .each(
      (_, el) => {
        if (
          images.length >=
          limit
        ) {
          return false;
        }

        const $el =
          $(el);

        const attrs =
          el.attribs || {};

        for (
          const [key, value]
          of Object.entries(
            attrs
          )
        ) {
          if (
            images.length >=
            limit
          ) {
            break;
          }

          if (
            typeof value !==
            'string'
          ) {
            continue;
          }

          if (
            !/murl|image|metadata|json|data|media|thumbnail|content|imgurl|objurl|iurl/i.test(
              key
            ) &&
            !/murl|mediaUrl|imageUrl|contentUrl|originalUrl|imgurl|objurl/i.test(
              value
            )
          ) {
            continue;
          }

          const extracted =
            extractMurlObjects(
              value,
              10
            );

          for (
            const item
            of extracted
          ) {
            if (
              images.length >=
              limit
            ) {
              break;
            }

            const d =
              item.data;

            const url =
              normalizeUrl(
                d?.murl ||
                d?.mediaUrl ||
                d?.imageUrl ||
                d?.contentUrl ||
                d?.originalUrl ||
                d?.imgurl ||
                d?.objurl
              );

            if (
              !url ||
              !isProbablyImageUrl(
                url
              ) ||
              seen.has(url)
            ) {
              continue;
            }

            seen.add(url);

            const built =
              buildImage(
                d,
                $el,
                offset,
                images.length,
                query,
                item.raw
              );

            if (built) {
              images.push(
                built
              );
            }
          }

          if (
            images.length <
              limit
          ) {
            const loose =
              parseLooseMetadata(
                value
              );

            if (loose) {
              const url =
                normalizeUrl(
                  loose.murl
                );

              if (
                url &&
                isProbablyImageUrl(
                  url
                ) &&
                !seen.has(url)
              ) {
                seen.add(url);

                const built =
                  buildImage(
                    loose,
                    $el,
                    offset,
                    images.length,
                    query,
                    value
                  );

                if (built) {
                  images.push(
                    built
                  );
                }
              }
            }
          }
        }
      }
    );

  return images;
}

// ==========================================
// PARSER #5
// DIRECT IMAGE ATTRIBUTES
//
// Bing bisa saja tidak memberikan JSON,
// tetapi URL asli masih berada di data-iurl,
// data-murl, data-original, srcset, dll.
// ==========================================

function parseDirectImageAttributes(
  $,
  limit,
  offset,
  query
) {
  const images = [];
  const seen =
    new Set();

  const imageAttrs = [
    'data-iurl',
    'data-murl',
    'data-image-url',
    'data-imageurl',
    'data-original',
    'data-original-src',
    'data-original-url',
    'data-full',
    'data-full-image',
    'data-src',
    'data-srcset',
    'srcset'
  ];

  $('img, source, a, figure, div')
    .each(
      (_, el) => {
        if (
          images.length >=
          limit
        ) {
          return false;
        }

        const $el =
          $(el);

        let imageUrl =
          null;

        for (
          const attr
          of imageAttrs
        ) {
          const value =
            $el.attr(attr);

          if (!value) {
            continue;
          }

          if (
            attr ===
              'srcset' ||
            attr ===
              'data-srcset'
          ) {
            const first =
              value
                .split(',')
                .map(
                  x =>
                    x
                      .trim()
                      .split(/\s+/)[0]
                )
                .find(Boolean);

            imageUrl =
              normalizeUrl(
                first
              );
          } else {
            imageUrl =
              normalizeUrl(
                value
              );
          }

          if (
            imageUrl &&
            isProbablyImageUrl(
              imageUrl
            )
          ) {
            break;
          }
        }

        if (
          !imageUrl ||
          !isProbablyImageUrl(
            imageUrl
          ) ||
          seen.has(imageUrl)
        ) {
          return;
        }

        seen.add(
          imageUrl
        );

        const href =
          normalizeUrl(
            $el.attr('href') ||
            $el.closest('a').attr('href')
          );

        const title =
          (
            $el.attr('alt') ||
            $el.attr('title') ||
            $el
              .find('img')
              .first()
              .attr('alt') ||
            query
          )
            .trim();

        let domain = '';

        try {
          domain =
            new URL(
              href ||
              imageUrl
            )
              .hostname
              .replace(
                /^www\./,
                ''
              );
        } catch (e) {}

        const dims =
          extractDimensions(
            {},
            $el,
            ''
          );

        images.push({
          title,
          image:
            imageUrl,
          imageUrl:
            imageUrl,
          thumbnail:
            imageUrl,
          thumbnailUrl:
            imageUrl,
          width:
            dims.width,
          height:
            dims.height,
          source:
            domain,
          domain,
          pageUrl:
            href ||
            imageUrl,
          link:
            href ||
            imageUrl,
          position:
            offset +
            images.length +
            1
        });
      }
    );

  return images;
}

// ==========================================
// PARSER #6
// VISIBLE BING IMAGES
// ==========================================

function parseVisibleBingImages(
  $,
  limit,
  offset,
  query
) {
  const images = [];
  const seen =
    new Set();

  $(
    'a.iusc img, img.mimg, .imgpt img, img'
  )
    .each(
      (_, el) => {
        if (
          images.length >=
          limit
        ) {
          return false;
        }

        const $img =
          $(el);

        const candidates = [
          $img.attr(
            'data-iurl'
          ),
          $img.attr(
            'data-murl'
          ),
          $img.attr(
            'data-original'
          ),
          $img.attr(
            'data-full'
          ),
          $img.attr(
            'data-src'
          ),
          $img.attr(
            'src'
          )
        ];

        let src =
          null;

        for (
          const candidate
          of candidates
        ) {
          const normalized =
            normalizeUrl(
              candidate
            );

          if (
            normalized &&
            isProbablyImageUrl(
              normalized
            )
          ) {
            src =
              normalized;
            break;
          }
        }

        if (
          !src ||
          seen.has(src)
        ) {
          return;
        }

        seen.add(src);

        const $parent =
          $img.closest(
            'a'
          );

        const href =
          normalizeUrl(
            $parent.attr(
              'href'
            )
          );

        const title =
          (
            $img.attr(
              'alt'
            ) ||
            $img.attr(
              'title'
            ) ||
            $parent.attr(
              'aria-label'
            ) ||
            query
          )
            .trim();

        let domain = '';

        try {
          domain =
            new URL(
              href ||
              src
            )
              .hostname
              .replace(
                /^www\./,
                ''
              );
        } catch (e) {}

        const dims =
          extractDimensions(
            {},
            $parent.length
              ? $parent
              : $img,
            ''
          );

        images.push({
          title,
          image:
            src,
          imageUrl:
            src,
          thumbnail:
            src,
          thumbnailUrl:
            src,
          width:
            dims.width,
          height:
            dims.height,
          source:
            domain,
          domain,
          pageUrl:
            href ||
            src,
          link:
            href ||
            src,
          position:
            offset +
            images.length +
            1
        });
      }
    );

  return images;
}

// ==========================================
// MASTER IMAGE PARSER
// ==========================================

function parseAllBingImages(
  html,
  limit,
  offset,
  query
) {
  if (!html) {
    return [];
  }

  const $ =
    cheerio.load(
      html
    );

  const all = [];
  const seen =
    new Set();

  function append(
    items
  ) {
    for (
      const item
      of items
    ) {
      if (
        all.length >=
        limit
      ) {
        break;
      }

      const url =
        normalizeUrl(
          item?.imageUrl ||
          item?.image
        );

      if (
        !url ||
        !isProbablyImageUrl(
          url
        ) ||
        seen.has(url)
      ) {
        continue;
      }

      seen.add(url);

      item.position =
        offset +
        all.length +
        1;

      all.push(item);
    }
  }

  // 1. Struktur Bing klasik.
  append(
    parseBingImageCards(
      $,
      html,
      limit,
      offset,
      query
    )
  );

  // 2. Object JSON / JSON-like.
  if (
    all.length < limit
  ) {
    append(
      parseMurlFallback(
        html,
        limit -
          all.length,
        offset,
        query
      )
    );
  }

  // 3. Script state.
  if (
    all.length < limit
  ) {
    append(
      parseBingScriptMetadata(
        html,
        limit -
          all.length,
        offset,
        query
      )
    );
  }

  // 4. Loose data attributes.
  if (
    all.length < limit
  ) {
    append(
      parseLooseImageMetadata(
        html,
        limit -
          all.length,
        offset,
        query
      )
    );
  }

  // 5. Direct data-iurl/data-original/srcset.
  if (
    all.length < limit
  ) {
    append(
      parseDirectImageAttributes(
        $,
        limit -
          all.length,
        offset,
        query
      )
    );
  }

  // 6. img src terakhir.
  if (
    all.length < limit
  ) {
    append(
      parseVisibleBingImages(
        $,
        limit -
          all.length,
        offset,
        query
      )
    );
  }

  return all;
}

// ==========================================
// BUILD IMAGE REQUEST ATTEMPTS
// ==========================================

function buildImageAttempts(
  query,
  config,
  offset,
  fetchCount
) {
  const q =
    encodeURIComponent(
      query
    );

  const markets = [
    {
      mkt: config.mkt,
      hl: config.hl,
      cc:
        config.gl.toUpperCase()
    },
    {
      mkt: 'en-US',
      hl: 'en',
      cc: 'US'
    }
  ].filter(
    (m, i, arr) =>
      arr.findIndex(
        x =>
          x.mkt ===
          m.mkt
      ) === i
  );

  const attempts = [];

  for (
    const m
    of markets
  ) {
    const common =
      `setmkt=${m.mkt}` +
      `&setlang=${m.hl}` +
      `&cc=${m.cc}`;

    const acceptLang =
      `${m.mkt},${m.hl};q=0.9`;

    attempts.push({
      name:
        `async-${m.mkt}`,

      market:
        m.mkt,

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
        `&form=HDRSC2` +
        `&${common}`
    });

    attempts.push({
      name:
        `page-${m.mkt}`,

      market:
        m.mkt,

      acceptLang,

      url:
        `https://www.bing.com/images/search` +
        `?q=${q}` +
        `&first=${offset + 1}` +
        `&count=${fetchCount}` +
        `&form=HDRSC2` +
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

async function getBingCookie(
  proxy
) {
  if (
    bingCookie.value &&
    Date.now() -
      bingCookie.at <
      10 * 60 * 1000
  ) {
    return bingCookie.value;
  }

  try {
    const r =
      await axios.get(
        'https://www.bing.com/',
        {
          headers: {
            'User-Agent':
              BING_UA,
            'Accept-Language':
              'id-ID,id;q=0.9,en;q=0.7',
            'Accept':
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          timeout: 7000,
          ...(proxy
            ? { proxy }
            : {})
        }
      );

    const set =
      r.headers[
        'set-cookie'
      ] || [];

    bingCookie = {
      value:
        set
          .map(
            c =>
              c.split(';')[0]
          )
          .join('; '),
      at:
        Date.now()
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
  const proxy =
    getImageProxy();

  const cookie =
    await getBingCookie(
      proxy
    );

  const res =
    await axios.get(
      attempt.url,
      {
        headers: {
          'User-Agent':
            BING_UA,

          'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

          'Accept-Language':
            attempt.acceptLang,

          'Referer':
            `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`,

          'Upgrade-Insecure-Requests':
            '1',

          'Sec-Fetch-Dest':
            'document',

          'Sec-Fetch-Mode':
            'navigate',

          'Sec-Fetch-Site':
            'same-origin',

          ...(cookie
            ? {
                Cookie:
                  cookie
              }
            : {})
        },

        timeout: 12000,

        maxContentLength:
          8 * 1024 * 1024,

        ...(proxy
          ? { proxy }
          : {})
      }
    );

  const html =
    typeof res.data === 'string'
      ? res.data
      : '';

  const blocked =
    looksBlocked(html);

  let images = [];

  if (!blocked) {
    images =
      parseAllBingImages(
        html,
        limit,
        offset,
        query
      );
  }

  const score =
    relevanceScore(
      images,
      query
    );

  const $ =
    cheerio.load(
      html
    );

  const pageTitle =
    (
      $('title')
        .first()
        .text() ||
      ''
    )
      .trim()
      .slice(
        0,
        120
      );

  // ========================================
  // DEBUG
  // ========================================

  if (
    images.length === 0
  ) {
    const bodyText =
      $('body')
        .text()
        .replace(
          /\s+/g,
          ' '
        )
        .trim()
        .slice(
          0,
          500
        );

    const iuscCount =
      (
        html.match(
          /class\s*=\s*["'][^"']*\biusc\b[^"']*["']/gi
        ) || []
      ).length;

    const murlCount =
      (
        html.match(
          /["']?murl["']?\s*[:=]/gi
        ) || []
      ).length;

    const turlCount =
      (
        html.match(
          /["']?turl["']?\s*[:=]/gi
        ) || []
      ).length;

    const purlCount =
      (
        html.match(
          /["']?purl["']?\s*[:=]/gi
        ) || []
      ).length;

    const imageUrlCount =
      (
        html.match(
          /["']?(?:imageUrl|mediaUrl|contentUrl|originalUrl|imgurl|objurl)["']?\s*[:=]/gi
        ) || []
      ).length;

    const dataMCount =
      (
        html.match(
          /\bdata-m\s*=/gi
        ) || []
      ).length;

    const dataIurlCount =
      (
        html.match(
          /\bdata-iurl\s*=/gi
        ) || []
      ).length;

    const imgCount =
      $('img').length;

    const scriptCount =
      $('script').length;

    console.log(
      `[IMG-DEBUG] ${attempt.name} ` +
      `status=${res.status} ` +
      `len=${html.length} ` +
      `title="${pageTitle}" ` +
      `iusc=${iuscCount} ` +
      `murl=${murlCount} ` +
      `turl=${turlCount} ` +
      `purl=${purlCount} ` +
      `imageFields=${imageUrlCount} ` +
      `data-m=${dataMCount} ` +
      `data-iurl=${dataIurlCount} ` +
      `img=${imgCount} ` +
      `script=${scriptCount} ` +
      `challenge=${blocked} ` +
      `proxy=${!!proxy} ` +
      `body="${bodyText}"`
    );
  } else {
    console.log(
      `[IMG-PARSER] ${attempt.name} ` +
      `berhasil parse ${images.length} gambar ` +
      `dari HTML ${html.length}B ` +
      `title="${pageTitle}"`
    );
  }

  return {
    images,
    score,
    blocked,
    status:
      res.status,
    htmlLength:
      html.length,
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
    Math.max(
      limit,
      20
    );

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

  for (
    const attempt
    of attempts
  ) {
    try {
      const r =
        await runImageAttempt(
          attempt,
          query,
          limit,
          offset
        );

      if (
        r.blocked
      ) {
        throw new Error(
          `BLOCKED_CAPTCHA (${attempt.name})`
        );
      }

      if (
        r.images.length ===
        0
      ) {
        throw new Error(
          `EMPTY (${attempt.name}, HTML ${r.htmlLength}B, title "${r.pageTitle}")`
        );
      }

      console.log(
        `[IMAGES] "${query}" via ${attempt.name}: ` +
        `${r.images.length} gambar, relevansi ${r.score.toFixed(2)}`
      );

      if (
        r.score >
        bestScore
      ) {
        best =
          r.images;

        bestScore =
          r.score;
      }

      if (
        r.images.length >=
        Math.min(
          limit,
          5
        )
      ) {
        return r.images;
      }
    } catch (err) {
      errors.push(
        err.message
      );

      console.warn(
        `[IMAGES] Strategi "${attempt.name}" gagal: ${err.message}`
      );
    }
  }

  if (
    best &&
    best.length > 0
  ) {
    return best;
  }

  throw new Error(
    `BING_FAILED: ${errors.join(' | ')}`
  );
}

// ==========================================
// FETCH IMAGES WITH RETRY
// ==========================================

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

      if (
        t < tries
      ) {
        bingCookie = {
          value: '',
          at: 0
        };

        await new Promise(
          r =>
            setTimeout(
              r,
              700
            )
        );
      }
    }
  }

  trackSource(
    'bing-images',
    false,
    lastErr?.message ||
      'Unknown error'
  );

  throw new Error(
    `BING_IMAGE_SEARCH_FAILED: ${lastErr?.message || 'Unknown error'}`
  );
}

// ==========================================
// 3. SCRAPER BERITA
// ==========================================

function buildBingNewsCookies(
  config
) {
  const region =
    config.gl.toUpperCase();

  const lang =
    config.hl;

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

    const first =
      offset + 1;

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
              'id-ID,id;q=0.9,en;q=0.7',

            'Referer':
              'https://www.bing.com/news',

            'Cookie':
              buildBingNewsCookies(
                config
              )
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

    if (
      looksBlocked(html)
    ) {
      throw new Error(
        'BLOCKED_CAPTCHA: Bing News meminta verifikasi atau mendeteksi trafik otomatis.'
      );
    }

    const $ =
      cheerio.load(
        html
      );

    let cards =
      $(
        'div[class*="newsitem"]'
      );

    if (
      cards.length === 0
    ) {
      cards =
        $(
          '[url][class*="news"]'
        );
    }

    cards.each(
      (_, el) => {
        if (
          newsItems.length >=
          limit
        ) {
          return false;
        }

        const $el =
          $(el);

        const link =
          normalizeUrl(
            $el.attr('url') ||
            $el
              .find(
                'a.title'
              )
              .first()
              .attr(
                'href'
              )
          );

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
          !link
        ) {
          return;
        }

        const snippet =
          $el
            .find(
              '.snippet'
            )
            .first()
            .text()
            .trim();

        const sourceSpans =
          $el.find(
            '.source span'
          );

        const metadataText =
          sourceSpans
            .map(
              (i, s) =>
                $(s)
                  .text()
                  .trim()
            )
            .get()
            .filter(Boolean)
            .join(' · ');

        const publisher =
          sourceSpans
            .first()
            .text()
            .trim();

        const img =
          $el
            .find(
              'a.imagelink img, img'
            )
            .first();

        const thumbnail =
          normalizeUrl(
            img.attr('src') ||
            img.attr(
              'data-src'
            ) ||
            img.attr(
              'data-original'
            )
          );

        let domain = '';

        try {
          domain =
            new URL(link)
              .hostname
              .replace(
                /^www\./,
                ''
              );
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
      }
    );

    if (
      newsItems.length ===
      0
    ) {
      throw new Error(
        'EMPTY_RESULT: Struktur berita Bing tidak ditemukan atau markup berubah.'
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

    const response =
      await axios.get(
        rssUrl,
        {
          headers: {
            'User-Agent':
              getRandomUserAgent(),

            'Accept':
              'application/rss+xml, application/xml, text/xml, */*'
          },

          timeout: 12000,

          responseType:
            'text',

          maxContentLength:
            5 * 1024 * 1024
        }
      );

    const feed =
      await rssParser.parseString(
        response.data
      );

    const rawItems =
      feed.items || [];

    const pagedItems =
      rawItems.slice(
        offset,
        offset + limit
      );

    if (
      pagedItems.length ===
      0
    ) {
      throw new Error(
        'EMPTY_RESULT: RSS Google News kosong.'
      );
    }

    for (
      const item
      of pagedItems
    ) {
      if (
        !item.title ||
        !item.link
      ) {
        continue;
      }

      let thumbnail =
        null;

      if (
        item
          .mediaThumbnail
          ?.$?.url
      ) {
        thumbnail =
          item
            .mediaThumbnail
            .$.
            url;
      } else if (
        item
          .mediaContent
          ?.$?.url
      ) {
        thumbnail =
          item
            .mediaContent
            .$.
            url;
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
          new URL(
            item.link
          )
            .hostname
            .replace(
              /^www\./,
              ''
            );
      } catch (e) {}

      const cleanSnippet =
        item.contentSnippet ||
        (
          item.content
            ? cheerio
                .load(
                  item.content
                )
                .text()
            : ''
        );

      newsItems.push({
        title:
          item.title.replace(
            / - [^-]+$/,
            ''
          ),

        link:
          item.link,

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
          1
      });
    }

    if (
      newsItems.length ===
      0
    ) {
      throw new Error(
        'EMPTY_RESULT: Semua item RSS kosong setelah filter.'
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
// 4. CACHE HELPERS
// ==========================================

function getCache(key) {
  const entry =
    cache.get(key);

  if (!entry) {
    return null;
  }

  if (
    Date.now() -
      entry.timestamp >=
    CACHE_TTL
  ) {
    cache.delete(key);
    return null;
  }

  return entry;
}

function setCache(
  key,
  data
) {
  if (
    cache.size >=
    CACHE_MAX
  ) {
    const oldest =
      cache.keys().next().value;

    if (oldest) {
      cache.delete(
        oldest
      );
    }
  }

  cache.set(
    key,
    {
      timestamp:
        Date.now(),
      data
    }
  );
}

// ==========================================
// 5. MAIN ROUTE API
// ==========================================

app.get(
  '/api/search',
  async (req, res) => {
    const startTime =
      Date.now();

    const query =
      typeof req.query.q ===
      'string'
        ? req.query.q.trim()
        : '';

    const searchType = (
      typeof req.query.type ===
      'string'
        ? req.query.type
        : 'search'
    ).toLowerCase();

    if (!query) {
      return res
        .status(400)
        .json({
          status:
            'error',

          message:
            'Parameter "q" wajib diisi.'
        });
    }

    if (
      query.length >
      500
    ) {
      return res
        .status(400)
        .json({
          status:
            'error',

          message:
            'Query terlalu panjang. Maksimal 500 karakter.'
        });
    }

    if (
      ![
        'search',
        'images',
        'news'
      ].includes(
        searchType
      )
    ) {
      return res
        .status(400)
        .json({
          status:
            'error',

          message:
            'Parameter type hanya mendukung search, images, atau news.'
        });
    }

    const defaultLimit = {
      search: 10,
      images: 20,
      news: 15
    };

    const limit =
      defaultLimit[
        searchType
      ];

    let offset = 0;

    if (
      req.query.start !==
      undefined
    ) {
      offset =
        Math.max(
          0,
          parseInt(
            req.query.start,
            10
          ) || 0
        );
    } else if (
      req.query.page !==
      undefined
    ) {
      const page =
        Math.max(
          1,
          parseInt(
            req.query.page,
            10
          ) || 1
        );

      offset =
        (page - 1) *
        limit;
    }

    offset =
      Math.min(
        offset,
        10000
      );

    const config =
      resolveLanguageConfig();

    const cacheKey =
      `${searchType}_${query.toLowerCase()}_` +
      `${config.hl}_${config.gl}_${limit}_start${offset}`;

    const staleEntry =
      getCache(
        cacheKey
      );

    if (staleEntry) {
      return res.json(
        staleEntry.data
      );
    }

    try {
      let results = [];

      if (
        searchType ===
        'images'
      ) {
        results =
          await fetchImages(
            query,
            config,
            limit,
            offset
          );
      } else if (
        searchType ===
        'news'
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
        searchType !==
          'images' &&
        results.length >
          0
      ) {
        results =
          await finalizeLinks(
            results
          );
      }

      if (
        results.length ===
        0
      ) {
        return res
          .status(502)
          .json({
            status:
              'error',

            message:
              'Hasil pencarian kosong. Server mungkin diblokir penyedia pencarian atau struktur HTML berubah.',

            searchParameters: {
              q: query,
              type:
                searchType,
              start:
                offset
            }
          });
      }

      const searchTime = (
        (
          Date.now() -
          startTime
        ) / 1000
      ).toFixed(2);

      const responsePayload = {
        status:
          'success',

        searchParameters: {
          q: query,
          type:
            searchType,
          hl:
            config.hl,
          gl:
            config.gl,
          num:
            limit,
          start:
            offset,
          page:
            Math.floor(
              offset /
                limit
            ) + 1
        },

        searchInformation: {
          formattedSearchTime:
            searchTime,

          totalResults:
            results.length
        },

        results,

        images:
          searchType ===
          'images'
            ? results
            : undefined,

        items:
          searchType ===
          'search'
            ? results
            : undefined,

        news:
          searchType ===
          'news'
            ? results
            : undefined
      };

      setCache(
        cacheKey,
        responsePayload
      );

      return res.json(
        responsePayload
      );
    } catch (error) {
      console.error(
        `[API ERROR] Type=${searchType}:`,
        error.message
      );

      if (
        staleEntry
      ) {
        return res.json({
          ...staleEntry.data,
          stale:
            true
        });
      }

      let statusCode =
        500;

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
        statusCode =
          502;

        customMessage =
          'Bing Images gagal mengembalikan hasil gambar yang valid saat ini. Coba lagi beberapa saat.';
      } else if (
        error.message.startsWith(
          'ALL_NEWS_SOURCES_FAILED'
        )
      ) {
        statusCode =
          502;

        customMessage =
          'Semua sumber berita (primer dan fallback) gagal.';
      } else if (
        error.code ===
          'ECONNABORTED' ||
        error.message
          .toLowerCase()
          .includes(
            'timeout'
          )
      ) {
        statusCode =
          504;

        customMessage =
          'Koneksi timeout ke mesin pencari Bing/Google. Jaringan lambat atau terputus.';
      } else if (
        error.message.includes(
          'BLOCKED_CAPTCHA'
        )
      ) {
        statusCode =
          429;

        customMessage =
          'IP server terdeteksi sebagai trafik otomatis atau diminta verifikasi oleh Bing.';
      } else if (
        error.response
      ) {
        statusCode =
          error.response.status ||
          502;

        customMessage =
          `Penyedia pencarian mengembalikan status error ${statusCode}.`;
      }

      return res
        .status(
          statusCode
        )
        .json({
          status:
            'error',

          message:
            customMessage,

          error_detail:
            error.message
        });
    }
  }
);

// ==========================================
// 6. SOURCE STATUS
// ==========================================

app.get(
  '/api/status',
  (req, res) => {
    res.json({
      status:
        'success',

      uptime:
        process.uptime(),

      timestamp:
        new Date().toISOString(),

      sources:
        sourceStats,

      cache: {
        entries:
          cache.size,

        maxEntries:
          CACHE_MAX,

        ttlMs:
          CACHE_TTL
      },

      linkCache: {
        entries:
          linkCache.size,

        maxEntries:
          LINK_CACHE_MAX
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
      name:
        'Search API',

      status:
        'online',

      endpoints: {
        search:
          '/api/search?q=Google',

        images:
          '/api/search?q=kucing&type=images',

        news:
          '/api/search?q=teknologi&type=news',

        status:
          '/api/status'
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
  }
);
