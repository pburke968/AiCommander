/**
 * gameState.js — Central Game State
 * All game data: players, zones, turn structure, stack, mana pool.
 * This module is the single source of truth for the game.
 */

const GameState = (() => {

  // ── Constants ──────────────────────────────────────────────
  const PHASES = [
    { id: 'untap',           label: 'Untap',       step: true  },
    { id: 'upkeep',          label: 'Upkeep',      step: true  },
    { id: 'draw',            label: 'Draw',        step: true  },
    { id: 'main1',           label: 'Main 1',      step: false },
    { id: 'begin_combat',    label: 'Begin Combat',step: true  },
    { id: 'attackers',       label: 'Attackers',   step: true  },
    { id: 'blockers',        label: 'Blockers',    step: true  },
    { id: 'damage',          label: 'Damage',      step: true  },
    { id: 'end_combat',      label: 'End Combat',  step: true  },
    { id: 'main2',           label: 'Main 2',      step: false },
    { id: 'end',             label: 'End Step',    step: true  },
    { id: 'cleanup',         label: 'Cleanup',     step: true  },
  ];

  const STARTING_LIFE = 40;
  const COMMANDER_DAMAGE_THRESHOLD = 21;
  const MAX_HAND_SIZE = 7;

  // ── State ──────────────────────────────────────────────────
  let _state = null;

  // ── Player template factory ────────────────────────────────
  function _createPlayer(id, name, isHuman = false) {
    return {
      id,             // 'p1', 'p2', etc.
      name,
      isHuman,
      life: STARTING_LIFE,
      eliminated: false,

      // Zones
      library: [],      // Array of CardInstance
      hand: [],
      battlefield: [],
      graveyard: [],
      exile: [],
      commandZone: [],  // Commander(s)

      // Commander tracking
      commanderCastCount: {},   // commanderName -> int (for commander tax)
      commanderDamageReceived: {}, // sourcePlayerId -> int

      // Mana pool
      manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },

      // Combat state
      attackers: [],   // CardInstance IDs attacking
      blockers: {},    // blockerInstanceId -> attackerInstanceId

      // Planeswalker tracking (usedAbilityThisTurn)
      planeswalkerAbilityUsed: new Set(),

      // Has landed / played land this turn
      landPlayedThisTurn: false,

      // Turn flags
      hasAttackedThisTurn: false,
    };
  }

  // ── Card Instance factory ──────────────────────────────────
  let _instanceCounter = 0;
  function createCardInstance(scryfallData, ownerId) {
    _instanceCounter++;
    const images = ScryfallAPI.getCardImageUrls(scryfallData);
    const keywords = ScryfallAPI.categorizeKeywords(scryfallData);
    const manaProduction = ScryfallAPI.parseManaProduction(scryfallData);

    return {
      instanceId: `card_${_instanceCounter}`,
      scryfallId: scryfallData.id,
      name: scryfallData.name,
      ownerId,
      controllerId: ownerId,

      // Card data
      data: scryfallData,
      typeLine: scryfallData.type_line || '',
      manaCost: scryfallData.mana_cost || '',
      oracleText: scryfallData.oracle_text || '',
      cmc: scryfallData.cmc || 0,
      colors: scryfallData.colors || [],
      colorIdentity: scryfallData.color_identity || [],
      power: scryfallData.power ? parseInt(scryfallData.power) || scryfallData.power : null,
      toughness: scryfallData.toughness ? parseInt(scryfallData.toughness) || scryfallData.toughness : null,
      loyalty: scryfallData.loyalty ? parseInt(scryfallData.loyalty) : null,

      // Derived
      isLand: /land/i.test(scryfallData.type_line || ''),
      isCreature: /creature/i.test(scryfallData.type_line || ''),
      isPlaneswalker: /planeswalker/i.test(scryfallData.type_line || ''),
      isArtifact: /artifact/i.test(scryfallData.type_line || ''),
      isEnchantment: /enchantment/i.test(scryfallData.type_line || ''),
      isInstant: /instant/i.test(scryfallData.type_line || ''),
      isSorcery: /sorcery/i.test(scryfallData.type_line || ''),
      isDoubleFaced: !!(scryfallData.card_faces && scryfallData.card_faces.length >= 2),

      // Images
      imageUrl: images.front,
      imageUrlBack: images.back,
      currentFace: 'front', // 'front' | 'back'

      // Keywords
      automatedKeywords: keywords.automatable,
      manualKeywords: keywords.manual,
      hasManualKeywords: keywords.manual.length > 0,

      // Mana production
      manaProduction,

      // Battlefield state
      tapped: false,
      transformed: false,
      summoningSick: true,  // creatures have summoning sickness until owner's next untap
      phased: false,

      // Counters: { type: count }
      counters: {},

      // Attached auras/equipment
      attachedTo: null,     // instanceId of host permanent
      attachments: [],      // instanceIds attached to this

      // Combat
      isAttacking: false,
      isBlocking: false,
      blockingInstanceId: null,

      // Damage marked this combat
      markedDamage: 0,

      // Current stats (may differ from base due to counters/effects)
      currentPower: scryfallData.power ? parseInt(scryfallData.power) || 0 : null,
      currentToughness: scryfallData.toughness ? parseInt(scryfallData.toughness) || 0 : null,
      currentLoyalty: scryfallData.loyalty ? parseInt(scryfallData.loyalty) : null,

      // Token?
      isToken: false,

      // Zone tracking
      currentZone: null,  // 'library'|'hand'|'battlefield'|'graveyard'|'exile'|'commandZone'|'stack'
    };
  }

  // ── Initialize a new game ──────────────────────────────────
  function initGame(playerDeckData, botDeckDataArray, bracketLevel) {
    _instanceCounter = 0;

    const players = [
      _createPlayer('p1', 'You', true),
      _createPlayer('p2', botDeckDataArray[0].name, false),
      _createPlayer('p3', botDeckDataArray[1].name, false),
      _createPlayer('p4', botDeckDataArray[2].name, false),
    ];

    // Build libraries from resolved card data
    _buildLibrary(players[0], playerDeckData.cards, playerDeckData.cardDataMap, playerDeckData.commanderName);
    for (let i = 0; i < 3; i++) {
      _buildBotLibrary(players[i + 1], botDeckDataArray[i]);
    }

    _state = {
      players,
      bracket: bracketLevel,
      turnNum: 1,
      activePlayerIndex: 0,  // p1 starts
      phaseIndex: 0,
      phases: PHASES,
      priority: 'p1',        // who has priority
      passedPriority: new Set(),

      stack: [],             // Array of StackItem
      attackers: [],         // { attackerInstanceId, defendingPlayerId|planeswalkerInstanceId }
      declaredBlockers: [],  // { blockerInstanceId, attackerInstanceId }

      emblems: [],           // { ownerId, text, name }
      dungeons: [],          // { ownerId, dungeonName, currentRoom }

      gameOver: false,
      winner: null,

      // Selection state for targeting
      selectedCard: null,    // { instanceId, ownerId, zone }
      targetingMode: false,
      validTargets: [],

      // Combat mode
      combatPhase: null,     // 'attackers'|'blockers'|null
    };

    return _state;
  }

  function _buildLibrary(player, cardEntries, cardDataMap, commanderName) {
    const allCards = [];
    for (const entry of cardEntries) {
      const data = cardDataMap.get(entry.name);
      if (!data) continue;
      for (let i = 0; i < entry.qty; i++) {
        const instance = createCardInstance(data, player.id);
        if (entry.name === commanderName) {
          instance.isCommander = true;
          instance.currentZone = 'commandZone';
          player.commandZone.push(instance);
        } else {
          allCards.push(instance);
        }
      }
    }
    // Shuffle
    for (let i = allCards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allCards[i], allCards[j]] = [allCards[j], allCards[i]];
    }
    player.library = allCards.map(c => { c.currentZone = 'library'; return c; });
  }

  function _buildBotLibrary(player, deckData) {
    // Bots use pre-built decklists. We'll flag that they need Scryfall data loaded.
    // For now, store raw card names and resolve lazily.
    player._deckData = deckData;
    player._deckResolved = false;
  }

  // ── Getters ────────────────────────────────────────────────
  function getState() { return _state; }
  function getPlayer(id) { return _state.players.find(p => p.id === id); }
  function getActivePlayer() { return _state.players[_state.activePlayerIndex]; }
  function getCurrentPhase() { return _state.phases[_state.phaseIndex]; }
  function getCardInstance(instanceId) {
    for (const player of _state.players) {
      for (const zone of ['library','hand','battlefield','graveyard','exile','commandZone']) {
        const card = player[zone].find(c => c.instanceId === instanceId);
        if (card) return card;
      }
    }
    // Check stack
    const stackItem = _state.stack.find(s => s.instanceId === instanceId);
    if (stackItem) return stackItem;
    return null;
  }
  function getCardOwner(instanceId) {
    for (const player of _state.players) {
      for (const zone of ['library','hand','battlefield','graveyard','exile','commandZone']) {
        if (player[zone].find(c => c.instanceId === instanceId)) return player;
      }
    }
    return null;
  }

  // ── Zone Moves ──────────────────────────────────────────────
  function moveCard(instanceId, fromPlayerId, fromZone, toPlayerId, toZone, toTop = false) {
    const fromPlayer = getPlayer(fromPlayerId);
    const toPlayer = getPlayer(toPlayerId);
    const idx = fromPlayer[fromZone].findIndex(c => c.instanceId === instanceId);
    if (idx === -1) {
      console.warn(`[GameState] Card ${instanceId} not found in ${fromPlayerId}.${fromZone}`);
      return null;
    }

    const card = fromPlayer[fromZone].splice(idx, 1)[0];
    card.currentZone = toZone;
    card.controllerId = toPlayerId;

    // Reset combat state on zone change
    if (toZone !== 'battlefield') {
      card.tapped = false;
      card.markedDamage = 0;
      card.isAttacking = false;
      card.isBlocking = false;
      card.blockingInstanceId = null;
      card.attachedTo = null;
      card.attachments = [];
      card.summoningSick = true;
    }

    if (toTop) {
      toPlayer[toZone].unshift(card);
    } else {
      toPlayer[toZone].push(card);
    }

    return card;
  }

  function drawCard(playerId) {
    const player = getPlayer(playerId);
    if (player.library.length === 0) {
      // Draw from empty library = lose
      eliminatePlayer(playerId, 'decked');
      return null;
    }
    return moveCard(player.library[0].instanceId, playerId, 'library', playerId, 'hand');
  }

  function drawCards(playerId, count) {
    const drawn = [];
    for (let i = 0; i < count; i++) {
      const card = drawCard(playerId);
      if (!card) break;
      drawn.push(card);
    }
    return drawn;
  }

  // ── Life Tracking ──────────────────────────────────────────
  function adjustLife(playerId, delta, sourcePlayerId = null, isCommanderDamage = false) {
    const player = getPlayer(playerId);
    player.life += delta;

    if (isCommanderDamage && sourcePlayerId && delta < 0) {
      const dmg = Math.abs(delta);
      player.commanderDamageReceived[sourcePlayerId] =
        (player.commanderDamageReceived[sourcePlayerId] || 0) + dmg;

      if (player.commanderDamageReceived[sourcePlayerId] >= COMMANDER_DAMAGE_THRESHOLD) {
        eliminatePlayer(playerId, 'commanderDamage');
      }
    }

    if (player.life <= 0) {
      eliminatePlayer(playerId, 'life');
    }

    return player.life;
  }

  // ── Elimination ────────────────────────────────────────────
  function eliminatePlayer(playerId, reason) {
    const player = getPlayer(playerId);
    if (player.eliminated) return;
    player.eliminated = true;

    // Remove all permanents, hand, exile, graveyard
    player.hand = [];
    player.battlefield = [];
    player.graveyard = [];
    player.exile = [];
    player.library = [];

    console.log(`[GameState] ${player.name} eliminated by: ${reason}`);

    // Check win condition
    const alive = _state.players.filter(p => !p.eliminated);
    if (alive.length === 1) {
      _state.gameOver = true;
      _state.winner = alive[0].id;
    }
  }

  // ── Mana Pool ──────────────────────────────────────────────
  function addMana(playerId, manaObj) {
    const player = getPlayer(playerId);
    for (const [color, amount] of Object.entries(manaObj)) {
      if (player.manaPool.hasOwnProperty(color)) {
        player.manaPool[color] = (player.manaPool[color] || 0) + amount;
      }
    }
  }

  function spendMana(playerId, manaObj) {
    const player = getPlayer(playerId);
    for (const [color, amount] of Object.entries(manaObj)) {
      if (!player.manaPool.hasOwnProperty(color)) continue;
      if ((player.manaPool[color] || 0) < amount) return false; // can't afford
    }
    for (const [color, amount] of Object.entries(manaObj)) {
      player.manaPool[color] = (player.manaPool[color] || 0) - amount;
    }
    return true;
  }

  function emptyManaPool(playerId) {
    const player = getPlayer(playerId);
    player.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  }

  // ── Commander Tax ──────────────────────────────────────────
  function getCommanderTax(playerId, commanderName) {
    const player = getPlayer(playerId);
    return ((player.commanderCastCount[commanderName] || 0)) * 2;
  }

  function recordCommanderCast(playerId, commanderName) {
    const player = getPlayer(playerId);
    player.commanderCastCount[commanderName] = (player.commanderCastCount[commanderName] || 0) + 1;
  }

  // ── Stack ──────────────────────────────────────────────────
  function pushToStack(item) {
    // item: { type: 'spell'|'ability'|'trigger', instanceId, name, controllerId, effect, data }
    _state.stack.push(item);
  }

  function resolveTopOfStack() {
    if (_state.stack.length === 0) return null;
    return _state.stack.pop();
  }

  function peekStack() {
    return _state.stack.length > 0 ? _state.stack[_state.stack.length - 1] : null;
  }

  // ── Counters ───────────────────────────────────────────────
  function addCounter(instanceId, type, amount = 1) {
    const card = getCardInstance(instanceId);
    if (!card) return;
    card.counters[type] = (card.counters[type] || 0) + amount;

    // Update power/toughness for +1/+1 and -1/-1 counters
    if (type === '+1/+1' && card.isCreature) {
      card.currentPower = (card.currentPower || 0) + amount;
      card.currentToughness = (card.currentToughness || 0) + amount;
    } else if (type === '-1/-1' && card.isCreature) {
      card.currentPower = (card.currentPower || 0) - amount;
      card.currentToughness = (card.currentToughness || 0) - amount;
    }
  }

  function removeCounter(instanceId, type, amount = 1) {
    const card = getCardInstance(instanceId);
    if (!card || !card.counters[type]) return;
    card.counters[type] = Math.max(0, card.counters[type] - amount);

    if (type === '+1/+1' && card.isCreature) {
      card.currentPower = (card.currentPower || 0) - amount;
      card.currentToughness = (card.currentToughness || 0) - amount;
    } else if (type === '-1/-1' && card.isCreature) {
      card.currentPower = (card.currentPower || 0) + amount;
      card.currentToughness = (card.currentToughness || 0) + amount;
    }
  }

  // ── Turn Advancement ───────────────────────────────────────
  function advancePhase() {
    const phase = getCurrentPhase();

    // Empty mana pool at end of each phase/step
    for (const player of _state.players) {
      if (!player.eliminated) emptyManaPool(player.id);
    }

    // Reset combat flags at end of combat
    if (phase.id === 'end_combat') {
      _clearCombatState();
    }

    _state.phaseIndex++;

    if (_state.phaseIndex >= _state.phases.length) {
      // Advance to next player's turn
      _state.phaseIndex = 0;
      _advanceTurn();
    }

    // Reset priority for new phase
    _state.passedPriority = new Set();
    _state.priority = getActivePlayer().id;

    return getCurrentPhase();
  }

  function _advanceTurn() {
    // Find next non-eliminated player
    let next = (_state.activePlayerIndex + 1) % _state.players.length;
    let attempts = 0;
    while (_state.players[next].eliminated && attempts < 4) {
      next = (next + 1) % _state.players.length;
      attempts++;
    }
    _state.activePlayerIndex = next;
    _state.turnNum++;

    const newPlayer = getActivePlayer();

    // Untap all permanents for active player
    _untapAll(newPlayer.id);

    // Reset land play
    newPlayer.landPlayedThisTurn = false;
    newPlayer.hasAttackedThisTurn = false;
    newPlayer.planeswalkerAbilityUsed = new Set();

    // Remove summoning sickness from creatures that survived
    for (const card of newPlayer.battlefield) {
      if (card.isCreature) card.summoningSick = false;
    }
  }

  function _untapAll(playerId) {
    const player = getPlayer(playerId);
    for (const card of player.battlefield) {
      // Permanents with vigilance don't untap? Actually they just don't tap when attacking.
      // Everything untaps unless an effect says otherwise.
      card.tapped = false;
    }
  }

  function _clearCombatState() {
    for (const player of _state.players) {
      for (const card of player.battlefield) {
        card.isAttacking = false;
        card.isBlocking = false;
        card.blockingInstanceId = null;
        card.markedDamage = 0;
      }
    }
    _state.attackers = [];
    _state.declaredBlockers = [];
  }

  // ── State-Based Actions ────────────────────────────────────
  function checkStateBasedActions() {
    let changed = false;

    for (const player of _state.players) {
      if (player.eliminated) continue;

      // Life total <= 0
      if (player.life <= 0) {
        eliminatePlayer(player.id, 'life');
        changed = true;
        continue;
      }

      // Creatures with 0 or less toughness go to graveyard
      const toGraveyard = player.battlefield.filter(
        c => c.isCreature && c.currentToughness !== null && c.currentToughness <= 0
      );
      for (const card of toGraveyard) {
        moveCard(card.instanceId, player.id, 'battlefield', player.id, 'graveyard');
        changed = true;
      }

      // Lethal damage on creatures
      const lethal = player.battlefield.filter(
        c => c.isCreature && c.markedDamage > 0 &&
             (c.markedDamage >= (c.currentToughness || 0) ||
              c.automatedKeywords.includes('Deathtouch'))
      );
      for (const card of lethal) {
        if (card.automatedKeywords.includes('Indestructible')) continue;
        moveCard(card.instanceId, player.id, 'battlefield', player.id, 'graveyard');
        changed = true;
      }

      // Planeswalkers with 0 loyalty die
      const deadPW = player.battlefield.filter(
        c => c.isPlaneswalker && c.currentLoyalty !== null && c.currentLoyalty <= 0
      );
      for (const card of deadPW) {
        moveCard(card.instanceId, player.id, 'battlefield', player.id, 'graveyard');
        changed = true;
      }
    }

    return changed;
  }

  // ── Emblems & Dungeons ─────────────────────────────────────
  function addEmblem(ownerId, name, text) {
    _state.emblems.push({ ownerId, name, text, id: `emblem_${Date.now()}` });
  }

  function addDungeon(ownerId, dungeonName) {
    const rooms = _getDungeonRooms(dungeonName);
    _state.dungeons.push({
      ownerId, dungeonName,
      rooms, currentRoomIndex: 0,
      id: `dungeon_${Date.now()}`,
    });
  }

  function _getDungeonRooms(name) {
    const dungeons = {
      'Dungeon of the Mad Mage': [
        'Yawning Portal', 'Dungeon Level', 'Goblin Bazaar', 'Twisted Caverns',
        'Lost Level', 'Runestone Caverns', 'Muiral\'s Graveyard', 'Deep Mines',
        'Crystal Caves', 'Twisted Halls', 'Mad Wizard\'s Lair',
      ],
      'Lost Mine of Phandelver': [
        'Cave Entrance', 'Goblin Lair', 'Storeroom', 'Old Owl Well',
        'Murky Pool', 'Dark Pool', 'Temple of Dumathoin',
      ],
      'Dungeon: Undercity': [
        'Dungeon Entrance', 'Forge', 'Lost Well', 'Arena of Blood',
        'Crypt of the Fallen', 'Trap', 'Throne of the Dead Three',
      ],
    };
    return dungeons[name] || ['Room 1', 'Room 2', 'Room 3'];
  }

  function advanceDungeon(dungeonId) {
    const dungeon = _state.dungeons.find(d => d.id === dungeonId);
    if (!dungeon) return false;
    if (dungeon.currentRoomIndex < dungeon.rooms.length - 1) {
      dungeon.currentRoomIndex++;
      return true;
    }
    return false; // Already at final room
  }

  // ── Tokens ────────────────────────────────────────────────
  function createToken(ownerId, scryfallData) {
    const instance = createCardInstance(scryfallData, ownerId);
    instance.isToken = true;
    instance.summoningSick = true;
    const player = getPlayer(ownerId);
    player.battlefield.push(instance);
    instance.currentZone = 'battlefield';
    return instance;
  }

  // ── Selectors ──────────────────────────────────────────────
  function getPhases() { return PHASES; }
  function getConstants() {
    return { STARTING_LIFE, COMMANDER_DAMAGE_THRESHOLD, MAX_HAND_SIZE };
  }

  return {
    initGame,
    getState,
    getPlayer,
    getActivePlayer,
    getCurrentPhase,
    getCardInstance,
    getCardOwner,
    createCardInstance,
    moveCard,
    drawCard,
    drawCards,
    adjustLife,
    eliminatePlayer,
    addMana,
    spendMana,
    emptyManaPool,
    getCommanderTax,
    recordCommanderCast,
    pushToStack,
    resolveTopOfStack,
    peekStack,
    addCounter,
    removeCounter,
    advancePhase,
    checkStateBasedActions,
    addEmblem,
    addDungeon,
    advanceDungeon,
    createToken,
    getPhases,
    getConstants,
  };
})();
