/**
 * validation.js — Deck Import & Validation Module
 * Parses Moxfield, Archidekt, and MTGO text formats.
 * Validates Commander legality: 100 cards, singleton, color identity.
 */

const DeckValidator = (() => {

  /**
   * Parse a raw deck list string into { commander, cards[] }.
   * Supports Moxfield/Archidekt (sections) and MTGO (plain list) formats.
   * Returns { commander: string|null, cards: [{qty, name}], errors: string[] }
   */
  function parseDecklist(raw) {
    const errors = [];
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    const entries = [];
    let commander = null;
    let currentSection = null;

    // Regex: optional qty, optional set/collector, card name
    // Handles: "1 Card Name", "1x Card Name", "1 Card Name (SET) 123"
    const lineRe = /^(\d+)x?\s+(.+?)(?:\s+\([A-Z0-9]+\)\s*\d*)?(?:\s+\*[A-Z]+\*)?$/i;

    for (const line of lines) {
      // Section headers (Archidekt / Moxfield)
      if (line.startsWith('//') || line.startsWith('#')) {
        const headerText = line.replace(/^[/#]+\s*/, '').toLowerCase();
        currentSection = headerText;
        continue;
      }

      // Empty lines just reset section flow
      if (line === '') { currentSection = null; continue; }

      // Detect commander tag variants
      const isCommanderLine =
        /\(commander\)/i.test(line) ||
        currentSection === 'commander' ||
        currentSection === 'commanders';

      const cleanLine = line.replace(/\s*\(Commander\)/i, '').trim();
      const match = cleanLine.match(lineRe);

      if (!match) {
        // Try simpler format: just a name (1 copy assumed)
        const simpleName = cleanLine.replace(/^\d+x?\s*/, '');
        if (simpleName.length > 0) {
          if (isCommanderLine && !commander) {
            commander = simpleName;
          } else {
            const qty = parseInt(cleanLine.match(/^\d+/)?.[0] || '1', 10);
            entries.push({ qty: isNaN(qty) ? 1 : qty, name: simpleName });
          }
        }
        continue;
      }

      const qty = parseInt(match[1], 10);
      const name = match[2].trim();

      if (isCommanderLine && !commander) {
        commander = name;
        // Commander still counts as 1 of the 100
        entries.push({ qty: 1, name });
      } else {
        entries.push({ qty, name });
      }
    }

    // If no commander found via section/tag, try first card
    if (!commander && entries.length > 0) {
      // Leave it null — we'll try to detect after Scryfall fetch
    }

    return { commander, cards: entries, errors };
  }

  /**
   * Given parsed entries and a Map of name->scryfallData,
   * perform full Commander legality validation.
   *
   * Returns { valid: bool, errors: string[], warnings: string[], commanderName: string }
   */
  function validateCommander(parsedDeck, cardDataMap) {
    const errors = [];
    const warnings = [];
    const { cards } = parsedDeck;
    let commanderName = parsedDeck.commander;

    // ── Step 1: Verify all cards resolved ──
    const unresolved = [];
    for (const entry of cards) {
      if (!cardDataMap.has(entry.name) || cardDataMap.get(entry.name) === null) {
        unresolved.push(entry.name);
      }
    }
    if (unresolved.length > 0) {
      for (const name of unresolved) {
        errors.push(`Card not found: "${name}" — check spelling or remove it.`);
      }
      return { valid: false, errors, warnings, commanderName };
    }

    // ── Step 2: Identify commander ──
    if (!commanderName) {
      // Auto-detect: find a legendary creature
      for (const entry of cards) {
        const data = cardDataMap.get(entry.name);
        if (data && isLegendaryCreatureOrPlaneswalker(data)) {
          commanderName = entry.name;
          warnings.push(`No commander tagged — auto-detected "${commanderName}" as commander.`);
          break;
        }
      }
    }

    if (!commanderName) {
      errors.push('No commander found. Tag your commander with "(Commander)" or list it in a [Commander] section.');
      return { valid: false, errors, warnings, commanderName };
    }

    const commanderData = cardDataMap.get(commanderName);
    if (!commanderData) {
      errors.push(`Commander "${commanderName}" could not be found on Scryfall.`);
      return { valid: false, errors, warnings, commanderName };
    }

    if (!isLegendaryCreatureOrPlaneswalker(commanderData)) {
      errors.push(`"${commanderName}" is not a legendary creature or planeswalker and cannot be your commander.`);
    }

    // ── Step 3: Commander legality format check ──
    if (!isLegalInCommander(commanderData)) {
      errors.push(`"${commanderName}" is not legal in Commander format.`);
    }

    // ── Step 4: Color identity ──
    const commanderIdentity = getColorIdentity(commanderData);

    // ── Step 5: Card count ──
    let totalCards = 0;
    const nameCounts = new Map();

    for (const entry of cards) {
      totalCards += entry.qty;
      const count = (nameCounts.get(entry.name) || 0) + entry.qty;
      nameCounts.set(entry.name, count);
    }

    if (totalCards !== 100) {
      errors.push(`Deck has ${totalCards} cards — Commander requires exactly 100 (including the commander).`);
    }

    // ── Step 6: Singleton rule ──
    const BASIC_LANDS = new Set([
      'Plains', 'Island', 'Swamp', 'Mountain', 'Forest',
      'Wastes', 'Snow-Covered Plains', 'Snow-Covered Island',
      'Snow-Covered Swamp', 'Snow-Covered Mountain', 'Snow-Covered Forest',
    ]);
    const allowedDuplicates = new Set([
      ...BASIC_LANDS,
      'Relentless Rats', 'Rat Colony', 'Shadowborn Apostle',
      'Seven Dwarves', 'Dragon\'s Approach',
    ]);

    for (const [name, count] of nameCounts.entries()) {
      if (count > 1 && !allowedDuplicates.has(name)) {
        errors.push(`Singleton violation: "${name}" appears ${count} times. Only basic lands and certain cards may be duplicated.`);
      }
    }

    // ── Step 7: Color identity for all cards ──
    for (const entry of cards) {
      if (entry.name === commanderName) continue;
      const data = cardDataMap.get(entry.name);
      if (!data) continue;

      const cardIdentity = getColorIdentity(data);
      const illegal = cardIdentity.filter(c => !commanderIdentity.includes(c));
      if (illegal.length > 0) {
        errors.push(`Color identity violation: "${entry.name}" contains {${illegal.join('}{')}} which is outside your commander's identity (${commanderIdentity.join('')}).`);
      }
    }

    // ── Step 8: Format legality ──
    for (const entry of cards) {
      if (entry.name === commanderName) continue;
      const data = cardDataMap.get(entry.name);
      if (!data) continue;

      if (!isLegalInCommander(data)) {
        errors.push(`Not legal in Commander: "${entry.name}" is banned or not legal in this format.`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      commanderName,
      commanderIdentity,
    };
  }

  // ── Helpers ────────────────────────────────

  function isLegendaryCreatureOrPlaneswalker(data) {
    const type = (data.type_line || '').toLowerCase();
    const isLegendary = type.includes('legendary');
    const isCreatureOrPW = type.includes('creature') || type.includes('planeswalker');
    // Check card_faces for MDFCs
    if (!isLegendary || !isCreatureOrPW) {
      if (data.card_faces) {
        return data.card_faces.some(face => {
          const t = (face.type_line || '').toLowerCase();
          return t.includes('legendary') && (t.includes('creature') || t.includes('planeswalker'));
        });
      }
    }
    return isLegendary && isCreatureOrPW;
  }

  function isLegalInCommander(data) {
    const legalities = data.legalities || {};
    const status = legalities.commander;
    // "not_legal" or "banned" => illegal; "legal" or "restricted" => ok
    return status === 'legal' || status === 'restricted' || !status;
  }

  function getColorIdentity(data) {
    // Scryfall provides color_identity as an array
    return data.color_identity || [];
  }

  /**
   * Format a deck list summary for display.
   */
  function summarizeDeck(cards, cardDataMap) {
    const counts = { creature: 0, instant: 0, sorcery: 0, enchantment: 0, artifact: 0, planeswalker: 0, land: 0, other: 0 };
    for (const entry of cards) {
      const data = cardDataMap.get(entry.name);
      if (!data) continue;
      const type = (data.type_line || '').toLowerCase();
      if (type.includes('creature')) counts.creature += entry.qty;
      else if (type.includes('instant')) counts.instant += entry.qty;
      else if (type.includes('sorcery')) counts.sorcery += entry.qty;
      else if (type.includes('enchantment')) counts.enchantment += entry.qty;
      else if (type.includes('artifact')) counts.artifact += entry.qty;
      else if (type.includes('planeswalker')) counts.planeswalker += entry.qty;
      else if (type.includes('land')) counts.land += entry.qty;
      else counts.other += entry.qty;
    }
    return counts;
  }

  return {
    parseDecklist,
    validateCommander,
    summarizeDeck,
    getColorIdentity,
    isLegalInCommander,
  };
})();
