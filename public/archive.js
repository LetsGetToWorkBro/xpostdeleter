/**
 * X archive reader — zero dependencies, runs entirely in the browser.
 *
 * Why this exists: `GET /2/users/:id/tweets` only reaches roughly your most
 * recent 3,200 posts. If you have a decade of history, the official data
 * archive is the *only* complete list of your post IDs — and reading it costs
 * nothing and hits no rate limit.
 *
 * Why it runs client-side: your archive contains DMs, your email address, your
 * IP history and your phone number. None of that should ever be uploaded to a
 * server. We parse it in the tab, extract nothing but post IDs plus a short
 * excerpt, and send only those.
 *
 * Implements just enough of PKZIP (including Zip64, because heavy archives blow
 * past 4 GB) to pull `data/tweets*.js` out without inflating the whole file.
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

async function sliceBuffer(file, start, length) {
  return new DataView(await file.slice(start, start + length).arrayBuffer());
}

function readU32(view, offset) {
  return view.getUint32(offset, true);
}
function readU16(view, offset) {
  return view.getUint16(offset, true);
}
function readU64(view, offset) {
  // Sizes here never exceed Number.MAX_SAFE_INTEGER in practice.
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return hi * 0x100000000 + lo;
}

/** Locate the End Of Central Directory record by scanning the tail. */
async function findEocd(file) {
  const maxComment = 0xffff;
  const scanLength = Math.min(file.size, maxComment + 22);
  const view = await sliceBuffer(file, file.size - scanLength, scanLength);
  for (let i = scanLength - 22; i >= 0; i--) {
    if (readU32(view, i) === SIG_EOCD) {
      return { view, offsetInScan: i, scanStart: file.size - scanLength };
    }
  }
  throw new Error('This does not look like a .zip file (no end-of-archive record found).');
}

async function readCentralDirectoryMeta(file) {
  const { view, offsetInScan, scanStart } = await findEocd(file);
  let entries = readU16(view, offsetInScan + 10);
  let cdSize = readU32(view, offsetInScan + 12);
  let cdOffset = readU32(view, offsetInScan + 16);

  // Zip64: the 32-bit fields are saturated and the real values live earlier.
  const needsZip64 = entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  if (needsZip64) {
    const locatorOffset = offsetInScan - 20;
    if (locatorOffset >= 0 && readU32(view, locatorOffset) === SIG_EOCD64_LOCATOR) {
      const eocd64Offset = readU64(view, locatorOffset + 8);
      const z = await sliceBuffer(file, eocd64Offset, 56);
      if (readU32(z, 0) === SIG_EOCD64) {
        entries = readU64(z, 32);
        cdSize = readU64(z, 40);
        cdOffset = readU64(z, 48);
      }
    }
  }
  return { entries, cdSize, cdOffset, scanStart };
}

/** All entries in the central directory, with names and data locations. */
async function listEntries(file) {
  const { entries, cdSize, cdOffset } = await readCentralDirectoryMeta(file);
  const cd = await sliceBuffer(file, cdOffset, cdSize);
  const decoder = new TextDecoder('utf-8');
  const out = [];
  let pos = 0;

  for (let i = 0; i < entries && pos + 46 <= cd.byteLength; i++) {
    if (readU32(cd, pos) !== SIG_CENTRAL) break;
    const method = readU16(cd, pos + 10);
    let compressedSize = readU32(cd, pos + 20);
    let uncompressedSize = readU32(cd, pos + 24);
    const nameLen = readU16(cd, pos + 28);
    const extraLen = readU16(cd, pos + 30);
    const commentLen = readU16(cd, pos + 32);
    let localOffset = readU32(cd, pos + 42);

    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + pos + 46, nameLen);
    const name = decoder.decode(nameBytes);

    // Zip64 extended information extra field.
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let ex = pos + 46 + nameLen;
      const exEnd = ex + extraLen;
      while (ex + 4 <= exEnd) {
        const headerId = readU16(cd, ex);
        const dataSize = readU16(cd, ex + 2);
        if (headerId === 0x0001) {
          let cursor = ex + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = readU64(cd, cursor); cursor += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = readU64(cd, cursor); cursor += 8; }
          if (localOffset === 0xffffffff) { localOffset = readU64(cd, cursor); cursor += 8; }
          break;
        }
        ex += 4 + dataSize;
      }
    }

    out.push({ name, method, compressedSize, uncompressedSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateEntry(file, entry) {
  // The local header repeats the name/extra lengths, and they can differ from
  // the central directory — always read them from the local header.
  const local = await sliceBuffer(file, entry.localOffset, 30);
  if (readU32(local, 0) !== SIG_LOCAL) throw new Error(`Corrupt entry in archive: ${entry.name}`);
  const nameLen = readU16(local, 26);
  const extraLen = readU16(local, 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;

  const blob = file.slice(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return new Uint8Array(await blob.arrayBuffer());
  if (entry.method !== 8) throw new Error(`Unsupported compression in archive (method ${entry.method}).`);

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Your browser cannot unzip files. Please upload the tweets.js file directly instead.');
  }
  const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* -------------------------------------------------------------------------- */
/* X archive JS files                                                          */
/* -------------------------------------------------------------------------- */

/** Archive files are `window.YTD.<name>.part0 = [ ... ]` — strip and parse. */
export function parseYtdFile(source) {
  const eq = source.indexOf('=');
  const start = source.indexOf('[', eq === -1 ? 0 : eq);
  if (start === -1) throw new Error('Unexpected archive file format.');
  const jsonText = source.slice(start).trim().replace(/;\s*$/, '');
  return JSON.parse(jsonText);
}

function parseTwitterDate(value) {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** One archive tweet record → the minimal shape PostCleaner sends to the API. */
export function normalizeTweet(entry) {
  const t = entry?.tweet ?? entry;
  if (!t) return null;
  const id = t.id_str ?? (t.id != null ? String(t.id) : null);
  if (!id) return null;

  const text = typeof t.full_text === 'string' ? t.full_text : (t.text ?? '');
  const media = t.extended_entities?.media ?? t.entities?.media ?? [];

  return {
    id,
    createdAt: parseTwitterDate(t.created_at),
    text: text.slice(0, 160),
    likes: Number(t.favorite_count ?? 0) || 0,
    retweets: Number(t.retweet_count ?? 0) || 0,
    hasMedia: media.length > 0,
    isReply: Boolean(t.in_reply_to_status_id_str || t.in_reply_to_user_id_str),
    isRetweet: Boolean(t.retweeted_status) || /^RT @/.test(text),
  };
}

export function normalizeLike(entry) {
  const l = entry?.like ?? entry;
  if (!l) return null;
  const id = l.tweetId ?? l.tweet_id ?? null;
  if (!id) return null;
  return {
    id: String(id),
    text: typeof l.fullText === 'string' ? l.fullText.slice(0, 160) : undefined,
    // The archive does not record *when* you liked something.
    createdAt: undefined,
  };
}

const TWEET_FILE = /(^|\/)(data\/)?tweets(-part\d+)?\.js$/i;
const LEGACY_TWEET_FILE = /(^|\/)(data\/)?tweet(-part\d+)?\.js$/i;
const LIKE_FILE = /(^|\/)(data\/)?like(-part\d+)?\.js$/i;
const ACCOUNT_FILE = /(^|\/)(data\/)?account\.js$/i;

/**
 * Read an X archive.
 *
 * Accepts either the whole `twitter-<date>-<hash>.zip` or a bare
 * `tweets.js` / `like.js` that the user extracted themselves.
 *
 * `onProgress({phase, detail, percent})` is called so the UI can stay honest
 * about what is happening on a 6 GB file.
 */
export async function readArchive(file, { want = 'tweets', onProgress = () => {} } = {}) {
  const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip';
  const decoder = new TextDecoder('utf-8');

  const matcher = want === 'likes' ? LIKE_FILE : TWEET_FILE;
  const fallbackMatcher = want === 'likes' ? null : LEGACY_TWEET_FILE;

  let sources = [];
  let account = null;

  if (isZip) {
    onProgress({ phase: 'scan', detail: 'Reading archive index…', percent: 0 });
    const entries = await listEntries(file);

    let matches = entries.filter((e) => matcher.test(e.name));
    if (!matches.length && fallbackMatcher) matches = entries.filter((e) => fallbackMatcher.test(e.name));
    if (!matches.length) {
      const hint = want === 'likes' ? 'like.js' : 'tweets.js';
      throw new Error(
        `Could not find ${hint} inside that archive. Make sure you selected the .zip that X emailed you (it contains a "data" folder).`,
      );
    }
    matches.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const accountEntry = entries.find((e) => ACCOUNT_FILE.test(e.name));
    if (accountEntry) {
      try {
        const raw = decoder.decode(await inflateEntry(file, accountEntry));
        const parsed = parseYtdFile(raw)[0]?.account;
        if (parsed) account = { username: parsed.username, displayName: parsed.accountDisplayName, id: parsed.accountId };
      } catch {
        /* account.js is a nicety, not a requirement */
      }
    }

    for (let i = 0; i < matches.length; i++) {
      onProgress({
        phase: 'extract',
        detail: `Extracting ${matches[i].name}…`,
        percent: Math.round((i / matches.length) * 60),
      });
      sources.push(decoder.decode(await inflateEntry(file, matches[i])));
    }
  } else {
    onProgress({ phase: 'extract', detail: 'Reading file…', percent: 10 });
    sources.push(await file.text());
  }

  onProgress({ phase: 'parse', detail: 'Parsing posts…', percent: 65 });
  const normalize = want === 'likes' ? normalizeLike : normalizeTweet;
  const items = [];
  const seen = new Set();

  for (const source of sources) {
    let records;
    try {
      records = parseYtdFile(source);
    } catch {
      throw new Error('That file is not a valid X archive file. Expected something like tweets.js from the data folder.');
    }
    for (const record of records) {
      const item = normalize(record);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  onProgress({ phase: 'done', detail: `Found ${items.length.toLocaleString()} items`, percent: 100 });

  // Newest first — matches what people expect when they scan the preview.
  items.sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    return 0;
  });

  return { items, account };
}

/* -------------------------------------------------------------------------- */
/* Facebook "Download Your Information" analyser                               */
/* -------------------------------------------------------------------------- */

const FB_POST_FILE = /your_(posts|uncategorized_photos)[^/]*\.json$/i;
const FB_COMMENT_FILE = /(comments|your_comments)[^/]*\.json$/i;

function fbDecodeMojibake(value) {
  // Meta exports UTF-8 bytes re-encoded as latin-1; this reverses that.
  if (typeof value !== 'string' || !/[Â-Ã]/.test(value)) return value;
  try {
    return new TextDecoder('utf-8').decode(Uint8Array.from(value, (c) => c.charCodeAt(0) & 0xff));
  } catch {
    return value;
  }
}

function collectFbEntries(node, out, kind) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const child of node) collectFbEntries(child, out, kind);
    return;
  }
  if (typeof node !== 'object') return;

  const timestamp = node.timestamp ?? node.created_timestamp;
  if (typeof timestamp === 'number') {
    let text = '';
    const data = Array.isArray(node.data) ? node.data : [];
    for (const d of data) {
      if (typeof d?.post === 'string') text = d.post;
      else if (typeof d?.comment?.comment === 'string') text = d.comment.comment;
    }
    if (!text && typeof node.title === 'string') text = node.title;
    out.push({ kind, timestamp: timestamp * 1000, text: fbDecodeMojibake(text).slice(0, 200) });
    return;
  }
  for (const value of Object.values(node)) collectFbEntries(value, out, kind);
}

/**
 * Reads a Facebook DYI export (JSON format) and produces a per-year breakdown.
 *
 * Facebook does not expose a delete API for personal timelines, so this is
 * deliberately read-only: it tells you exactly how much there is and which
 * years to attack first in Activity Log, and exports a CSV you can tick off.
 */
export async function analyzeFacebookExport(file, { onProgress = () => {} } = {}) {
  if (!/\.zip$/i.test(file.name)) {
    throw new Error('Please select the .zip that Facebook produced ("Download your information", format: JSON).');
  }
  onProgress({ phase: 'scan', detail: 'Reading archive index…', percent: 0 });
  const entries = await listEntries(file);
  const targets = entries.filter((e) => FB_POST_FILE.test(e.name) || FB_COMMENT_FILE.test(e.name));

  if (!targets.length) {
    throw new Error(
      'No posts or comments found. Make sure you chose JSON (not HTML) when requesting the download, and included "Posts" and "Comments".',
    );
  }

  const decoder = new TextDecoder('utf-8');
  const records = [];
  for (let i = 0; i < targets.length; i++) {
    onProgress({
      phase: 'extract',
      detail: `Reading ${targets[i].name.split('/').pop()}…`,
      percent: Math.round((i / targets.length) * 90),
    });
    try {
      const parsed = JSON.parse(decoder.decode(await inflateEntry(file, targets[i])));
      collectFbEntries(parsed, records, FB_POST_FILE.test(targets[i].name) ? 'post' : 'comment');
    } catch {
      /* skip unreadable member, keep going */
    }
  }

  const byYear = new Map();
  for (const r of records) {
    const year = new Date(r.timestamp).getUTCFullYear();
    const bucket = byYear.get(year) ?? { year, posts: 0, comments: 0 };
    if (r.kind === 'comment') bucket.comments += 1;
    else bucket.posts += 1;
    byYear.set(year, bucket);
  }

  onProgress({ phase: 'done', detail: `Analysed ${records.length.toLocaleString()} items`, percent: 100 });

  return {
    total: records.length,
    posts: records.filter((r) => r.kind === 'post').length,
    comments: records.filter((r) => r.kind === 'comment').length,
    years: [...byYear.values()].sort((a, b) => a.year - b.year),
    records,
  };
}
