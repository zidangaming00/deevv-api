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

  // Named entities
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
      );

  // Hex entities
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

  // Decimal entities
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
      /\\u0026/gi,
      '&'
    )
    .replace(
      /\\u002f/gi,
      '/'
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

  // HTML entities terlebih dahulu
  s =
    decodeEntities(s);

  // Kalau value merupakan JSON string,
  // biarkan JSON.parse yang menangani escape.
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
    );
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

  // RAW ATTRIBUTE m
  if (
    (!width || !height) &&
    rawM
  ) {
    const raw =
      decodeEntities(
        String(rawM)
      );

    const widthMatch =
      raw.match(
        /["'](?:ow|originalWidth|imageWidth|width)["']\s*:\s*["']?(\d{2,6})/i
      );

    const heightMatch =
      raw.match(
        /["'](?:oh|originalHeight|imageHeight|height)["']\s*:\s*["']?(\d{2,6})/i
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

  // HTML ATTRIBUTE
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

  // CAPTION
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

  // THUMBNAIL SIZE
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

  const candidates = [
    String(raw),
    decodeEntities(
      String(raw)
    ),
    String(raw)
      .replace(
        /\\"/g,
        '"'
      )
      .replace(
        /\\'/g,
        "'"
      ),
    decodeJsonStringValue(
      raw
    )
  ];

  for (
    const candidate
    of candidates
  ) {
    if (!candidate) {
      continue;
    }

    try {
      const parsed =
        JSON.parse(candidate);

      if (
        parsed &&
        typeof parsed ===
          'object' &&
        (
          parsed.murl ||
          parsed.purl ||
          parsed.turl
        )
      ) {
        return parsed;
      }
    } catch (e) {}
  }

  return null;
}

// ==========================================
// JSON OBJECT EXTRACTOR
//
// Tidak lagi memakai regex:
//   /{[^{}]*"murl".../
//
// Karena regex tersebut gagal ketika
// object memiliki nested object/array.
//
// Fungsi ini mencari object JSON dari posisi
// tertentu sambil menghitung brace depth dan
// mengabaikan { } yang berada di dalam string.
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

  // Cari { terdekat.
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
        ch === '"'
      ) {
        inString = false;
      }

      continue;
    }

    if (
      ch === '"'
    ) {
      inString = true;
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
// CARI SEMUA JSON OBJECT YANG MENGANDUNG MURL
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

  const decoded =
    decodeEntities(
      rawHtml
    );

  const results = [];
  const seenRanges =
    new Set();

  // Variasi:
  // "murl"
  // 'murl'
  // &quot;murl&quot; sudah didecode
  const markerRegex =
    /["']murl["']\s*:/gi;

  let marker;

  while (
    (
      marker =
        markerRegex.exec(
          decoded
        )
    ) &&
    results.length <
      limit
  ) {
    const markerIndex =
      marker.index;

    // Cari { sebelum "murl".
    // Biasanya object tidak jauh dari marker.
    const searchStart =
      Math.max(
        0,
        markerIndex - 20000
      );

    let objectStart =
      decoded.lastIndexOf(
        '{',
        markerIndex
      );

    if (
      objectStart <
      searchStart
    ) {
      objectStart =
        decoded.indexOf(
          '{',
          markerIndex
        );
    }

    if (
      objectStart < 0
    ) {
      continue;
    }

    const objectText =
      extractBalancedJsonObject(
        decoded,
        objectStart
      );

    if (!objectText) {
      continue;
    }

    const rangeKey =
      `${objectStart}:${objectText.length}`;

    if (
      seenRanges.has(
        rangeKey
      )
    ) {
      continue;
    }

    seenRanges.add(
      rangeKey
    );

    const parsed =
      parseImageMetadata(
        objectText
      );

    if (
      parsed &&
      parsed.murl
    ) {
      results.push({
        data: parsed,
        raw: objectText
      });
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
    'data-item'
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
        parsed.purl ||
        parsed.turl
      )
    ) {
      return {
        data: parsed,
        raw
      };
    }

    // Attribute mungkin berisi JSON
    // nested/escaped yang perlu diekstrak.
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
      d.contentUrl
    );

  const thumbnailUrl =
    normalizeUrl(
      d.turl ||
      d.thumbnailUrl ||
      d.thumbnail
    );

  const targetLink =
    normalizeUrl(
      d.purl ||
      d.pageUrl ||
      d.sourceUrl
    );

  if (!imageUrl) {
    return null;
  }

  const title =
    d.t ||
    d.title ||
    d.name ||
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
// BING CLASSIC:
// <a class="iusc" m="{...}">
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

  // Jangan hanya bergantung pada a.iusc.
  // Ambil semua element yang punya kemungkinan
  // metadata Bing.
  const selectors = [
    'a.iusc',
    '[m]',
    '[data-m]',
    '[data-metadata]',
    '[data-image]',
    '[data-json]',
    '[data-meta]',
    '[data-item]'
  ];

  const selector =
    selectors.join(',');

  $(selector).each(
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
          d.contentUrl
        );

      if (
        !imageUrl ||
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
// JSON OBJECT LANGSUNG DARI RAW HTML
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
        limit * 3,
        60
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

    if (
      !d ||
      !d.murl
    ) {
      continue;
    }

    const url =
      normalizeUrl(
        d.murl
      );

    if (
      !url ||
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
// CARI DATA DARI SCRIPT / JSON-LIKE HTML
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
        !/murl/i.test(
          content
        )
      ) {
        return;
      }

      const objects =
        extractMurlObjects(
          content,
          Math.max(
            limit * 2,
            40
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

        if (
          !d ||
          !d.murl
        ) {
          continue;
        }

        const url =
          normalizeUrl(
            d.murl
          );

        if (
          !url ||
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
// CARI URL IMAGE DARI ATTRIBUTE / JSON
// YANG TIDAK BERBENTUK OBJECT STANDAR
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

  $('a, img, div, li').each(
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
          typeof value !==
          'string'
        ) {
          continue;
        }

        if (
          !/murl|image|metadata|json|data/i.test(
            key
          )
        ) {
          continue;
        }

        const decoded =
          decodeEntities(
            value
          );

        const extracted =
          extractMurlObjects(
            decoded,
            5
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

          if (
            !d ||
            !d.murl
          ) {
            continue;
          }

          const url =
            normalizeUrl(
              d.murl
            );

          if (
            !url ||
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
      }
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
        seen.has(url)
      ) {
        continue;
      }

      seen.add(url);
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

  if (
    all.length >= limit
  ) {
    return all;
  }

  // 2. Raw HTML.
  append(
    parseMurlFallback(
      html,
      limit,
      offset,
      query
    )
  );

  if (
    all.length >= limit
  ) {
    return all;
  }

  // 3. Script JSON.
  append(
    parseBingScriptMetadata(
      html,
      limit,
      offset,
      query
    )
  );

  if (
    all.length >= limit
  ) {
    return all;
  }

  // 4. Loose metadata.
  append(
    parseLooseImageMetadata(
      html,
      limit,
      offset,
      query
    )
  );

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

    // --------------------------------------
    // A. Async endpoint
    // --------------------------------------

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
        `&${common}`
    });

    // --------------------------------------
    // B. Full image page
    // --------------------------------------

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
              'id-ID,id;q=0.9,en;q=0.7'
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
  // DEBUG DATA
  // ========================================

  if (
    images.length === 0
  ) {
    $('script, style')
      .remove();

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
          /class=["'][^"']*\biusc\b[^"']*["']/gi
        ) || []
      ).length;

    const murlCount =
      (
        html.match(
          /["']murl["']\s*:/gi
        ) || []
      ).length;

    const turlCount =
      (
        html.match(
          /["']turl["']\s*:/gi
        ) || []
      ).length;

    const purlCount =
      (
        html.match(
          /["']purl["']\s*:/gi
        ) || []
      ).length;

    console.log(
      `[IMG-DEBUG] ${attempt.name} ` +
      `status=${res.status} ` +
      `len=${html.length} ` +
      `title="${pageTitle}" ` +
      `iusc=${iuscCount} ` +
      `murl=${murlCount} ` +
      `turl=${turlCount} ` +
      `purl=${purlCount} ` +
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

      // Jangan terlalu ketat.
      // Jika Bing memang mengembalikan image card
      // yang valid, langsung pakai.
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
// Bing News primer + Google News RSS fallback
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
// GET /api/search
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
// GET /api/status
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
