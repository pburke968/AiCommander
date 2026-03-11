/**
 * api.js — Scryfall API Layer
 * Handles all card data fetching with rate limiting, caching, and error handling.
 * Max 10 requests/second per Scryfall policy.
 */

const ScryfallAPI = (() => {
  const BASE = 'https://api.scryfall.com';
  const MIN_DELAY_MS = 100; // 10 req/s max
  const CARD_BACK = 'https://backs.scryfall.dev/large/back.jpg';

  // Simple in-memory cache for this session
  const _cache = new Map();

  // Request queue
  let _queue = [];
  let _processing = false;
  let _lastRequestTime = 0;

  // ── Queue processor ──────────────────────
  async function _processQueue() {
    if (_processing || _queue.length === 0) return;
    _processing = true;

    while (_queue.length > 0) {
      const { url, resolve, reject } = _queue.shift();

      // Enforce rate limit
      const now = Date.now();
      const elapsed = now - _lastRequestTime;
      if (elapsed < MIN_DELAY_MS) {
        await _sleep(MIN_DELAY_MS - elapsed);
      }

      try {
        if (_cache.has(url)) {
          resolve(_cache.get(url));
        } else {
          const resp = await fetch(url);
          _lastRequestTime = Date.now();

          if (resp.status === 404) {
            resolve(null); // Card not found
          } else if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            reject(new Error(err.details || `HTTP ${resp.status}`));
          } else {
            const data = await resp.json();
            _cache.set(url, data);
            resolve(data);
          }
        }
      } catch (err) {
        reject(err);
      }
    }

    _processing = false;
  }

  function _enqueue(url) {
    return new Promise((resolve, reject) => {
      _queue.push({ url, resolve, reject });
      _processQueue();
    });
  }

  function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── Public API ───────────────────────────

  /**
   * Fetch a card by exact name. Returns Scryfall card object or null.
   */
  async function getCardByName(name) {
    const url = `${BASE}/cards/named?exact=${encodeURIComponent(name)}`;
    try {
      return await _enqueue(url);
    } catch (e) {
      console.warn(`[API] Failed to fetch "${name}":`, e.message);
      return null;
    }
  }

  /**
   * Fuzzy search — useful for import parsing with slight typos.
   */
  async function getCardFuzzy(name) {
    const url = `${BASE}/cards/named?fuzzy=${encodeURIComponent(name)}`;
    try {
      return await _enqueue(url);
    } catch (e) {
      console.warn(`[API] Fuzzy fetch "${name}" failed:`, e.message);
      return null;
    }
  }

  /**
   * Fetch a token by name.
   */
  async function getToken(name) {
    const url = `${BASE}/cards/search?q=t%3Atoken+!"${encodeURIComponent(name)}"&unique=cards`;
    try {
      const data = await _enqueue(url);
      return data && data.data && data.data.length > 0 ? data.data[0] : null;
    } catch (e) {
      console.warn(`[API] Token fetch "${name}" failed:`, e.message);
      return null;
    }
  }

  /**
   * Batch-fetch an array of card names, returning a map of name -> card data.
   * Reports progress via optional onProgress(done, total) callback.
   */
  async function batchFetchCards(names, onProgress) {
    const results = new Map();
    const unique = [...new Set(names)];
    let done = 0;

    await Promise.all(unique.map(async (name) => {
      const card = await getCardByName(name);
      results.set(name, card);
      done++;
      if (onProgress) onProgress(done, unique.length);
    }));

    return results;
  }

  /**
   * Get the image URL for a card face. Handles DFCs.
   * Returns { front, back } — back may be null for single-faced cards.
   */
  function getCardImageUrls(cardData) {
    if (!cardData) return { front: CARD_BACK, back: null };

    // Single-faced
    if (cardData.image_uris) {
      return { front: cardData.image_uris.normal, back: null };
    }

    // Double-faced / MDFC / Transforming
    if (cardData.card_faces && cardData.card_faces.length >= 2) {
      const frontFace = cardData.card_faces[0];
      const backFace  = cardData.card_faces[1];
      return {
        front: frontFace.image_uris ? frontFace.image_uris.normal : CARD_BACK,
        back:  backFace.image_uris  ? backFace.image_uris.normal  : CARD_BACK,
        frontFace,
        backFace,
      };
    }

    return { front: CARD_BACK, back: null };
  }

  /**
   * Parse oracle text / keywords from a card to determine automation category.
   * Returns { automatable: string[], manual: string[] }
   */
  function categorizeKeywords(cardData) {
    if (!cardData) return { automatable: [], manual: [] };

    const AUTO_KEYWORDS = new Set([
      'Haste', 'Vigilance', 'Deathtouch', 'Lifelink', 'Flying',
      'First strike', 'Double strike', 'Trample', 'Reach', 'Hexproof',
      'Shroud', 'Indestructible', 'Menace', 'Flash', 'Ward',
      'Defender', 'Protection', 'Skulk', 'Unblockable',
    ]);
    const MANUAL_KEYWORDS = new Set([
      'Morph', 'Megamorph', 'Foretell', 'Suspend', 'Cascade',
      'Miracle', 'Cipher', 'Bestow', 'Emerge', 'Dash', 'Evoke',
      'Madness', 'Overload', 'Replicate', 'Splice', 'Transmute',
      'Unearth', 'Delve', 'Convoke', 'Improvise', 'Affinity',
      'Phyrexian', 'Ninjutsu', 'Offering', 'Channel', 'Entwine',
      'Kicker', 'Multikicker', 'Escalate', 'Fuse', 'Flashback',
    ]);

    const keywords = cardData.keywords || [];
    const automatable = [];
    const manual = [];

    for (const kw of keywords) {
      if (AUTO_KEYWORDS.has(kw)) automatable.push(kw);
      else if (MANUAL_KEYWORDS.has(kw)) manual.push(kw);
    }

    return { automatable, manual };
  }

  /**
   * Determine mana produced by a permanent from oracle text.
   * Returns an object like { W:1, U:0, B:0, R:0, G:1, C:0 } or null if not a mana producer.
   */
  function parseManaProduction(cardData) {
    if (!cardData) return null;

    const oracle = (cardData.oracle_text || '').toLowerCase();
    const faces = cardData.card_faces || [];

    const allText = [oracle, ...faces.map(f => (f.oracle_text || '').toLowerCase())].join(' ');

    // Look for "add {X}" patterns
    const addPattern = /add\s+(\{[WUBRGC0-9X/]+\}(?:\s*(?:and|or)\s*\{[WUBRGC0-9X/]+\})*)/gi;
    const matches = [...allText.matchAll(addPattern)];

    if (matches.length === 0) return null;

    const production = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    let anyMana = false;

    for (const match of matches) {
      const manaStr = match[1];
      const pips = [...manaStr.matchAll(/\{([WUBRGC0-9X/]+)\}/gi)];
      for (const pip of pips) {
        const sym = pip[1].toUpperCase();
        if (production.hasOwnProperty(sym)) {
          production[sym]++;
          anyMana = true;
        } else if (sym === 'X' || /^\d+$/.test(sym)) {
          // Generic mana production — mark as colorless
          production.C++;
          anyMana = true;
        } else if (sym.includes('/')) {
          // Hybrid — treat as both colors
          anyMana = true;
        }
      }
    }

    return anyMana ? production : null;
  }

  /**
   * Parse mana cost string like "{2}{G}{G}" into an object.
   */
  function parseManaCost(costString) {
    if (!costString) return null;
    const cost = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, generic: 0 };
    const pips = [...costString.matchAll(/\{([WUBRGCXS0-9/]+)\}/gi)];
    for (const pip of pips) {
      const sym = pip[1].toUpperCase();
      if (cost.hasOwnProperty(sym)) cost[sym]++;
      else if (/^\d+$/.test(sym)) cost.generic += parseInt(sym);
      else if (sym === 'X') {} // X costs handled separately
    }
    return cost;
  }

  /**
   * Check if a card is a land that can be tapped for mana.
   */
  function isLand(cardData) {
    if (!cardData) return false;
    const types = (cardData.type_line || '').toLowerCase();
    return types.includes('land');
  }

  /**
   * Return the default card-back URL.
   */
  function cardBackUrl() {
    return CARD_BACK;
  }

  /**
   * Clear the session cache.
   */
  function clearCache() {
    _cache.clear();
  }

  return {
    getCardByName,
    getCardFuzzy,
    getToken,
    batchFetchCards,
    getCardImageUrls,
    categorizeKeywords,
    parseManaProduction,
    parseManaCost,
    isLand,
    cardBackUrl,
    clearCache,
  };
})();
