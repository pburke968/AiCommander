/**
 * rulesEngine.js — Full MTG Rules Engine
 * Handles: phases, stack/priority, combat, SBAs, keyword automation,
 * APNAP ordering, commander-specific rules.
 */

const RulesEngine = (() => {

  // ── Phase / Step Automation ──────────────────────────────
  /**
   * Called when the active player enters a new phase.
   * Handles automatic triggers and enforced actions.
   * Returns list of events that happened (for UI feedback).
   */
  function handlePhaseEntry(phaseId, state) {
    const events = [];
    const activePlayer = GameState.getActivePlayer();

    switch (phaseId) {
      case 'untap':
        _handleUntapStep(activePlayer, state, events);
        break;
      case 'draw':
        _handleDrawStep(activePlayer, state, events);
        break;
      case 'cleanup':
        _handleCleanupStep(activePlayer, state, events);
        break;
    }

    return events;
  }

  function _handleUntapStep(player, state, events) {
    // Untap all permanents (already handled in GameState._advanceTurn, but triggers here)
    for (const card of player.battlefield) {
      card.tapped = false;
    }
    events.push({ type: 'untap', playerId: player.id });
  }

  function _handleDrawStep(player, state, events) {
    // Skip draw on turn 1 for first player (rule 103.7a)
    if (state.turnNum === 1 && state.activePlayerIndex === 0) return;

    const drawn = GameState.drawCard(player.id);
    if (drawn) {
      events.push({ type: 'draw', playerId: player.id, card: drawn });
    }
  }

  function _handleCleanupStep(player, state, events) {
    // Discard to hand size
    const maxHand = 7;
    while (player.hand.length > maxHand) {
      // Player must choose — for now queue discard prompt
      events.push({ type: 'discardRequired', playerId: player.id, count: player.hand.length - maxHand });
      break;
    }

    // Remove damage from creatures
    for (const card of player.battlefield) {
      card.markedDamage = 0;
    }

    // Remove "until end of turn" effects (placeholder)
    events.push({ type: 'cleanupEffects', playerId: player.id });
  }

  // ── Casting a Spell ──────────────────────────────────────
  /**
   * Attempt to cast a card from hand. Returns { success, error, manaRequired }.
   */
  function castSpell(playerId, instanceId, state) {
    const player = GameState.getPlayer(playerId);
    const card = player.hand.find(c => c.instanceId === instanceId);
    if (!card) return { success: false, error: 'Card not in hand.' };

    // Check phase legality
    const phase = GameState.getCurrentPhase();
    const isMainPhase = phase.id === 'main1' || phase.id === 'main2';
    const isInstantSpeed = card.isInstant || card.automatedKeywords.includes('Flash');
    const stackEmpty = state.stack.length === 0;

    if (!isInstantSpeed && !(isMainPhase && stackEmpty)) {
      return { success: false, error: 'You can only cast sorcery-speed spells during your main phase with an empty stack.' };
    }

    if (card.isLand) {
      return playLand(playerId, instanceId, state);
    }

    // Calculate mana cost (with commander tax if applicable)
    let manaCost = card.manaCost;
    let totalCost = { ...ScryfallAPI.parseManaCost(manaCost) };

    if (card.isCommander) {
      const tax = GameState.getCommanderTax(playerId, card.name);
      totalCost.generic = (totalCost.generic || 0) + tax;
    }

    // Check if player has enough mana (simplified — check total pips)
    const canPay = _canPayManaCost(player.manaPool, totalCost);
    if (!canPay) {
      return { success: false, error: 'Insufficient mana to cast this spell.' };
    }

    // Move to stack
    const stackItem = {
      type: card.isPlaneswalker ? 'planeswalkerSpell' : (card.isCreature ? 'creatureSpell' : 'spell'),
      instanceId: card.instanceId,
      name: card.name,
      controllerId: playerId,
      manaCost: totalCost,
      card,
      targets: [],
    };

    // Remove from hand
    const idx = player.hand.findIndex(c => c.instanceId === instanceId);
    player.hand.splice(idx, 1);
    card.currentZone = 'stack';

    // Deduct mana
    _payManaCost(player, totalCost);

    if (card.isCommander) {
      GameState.recordCommanderCast(playerId, card.name);
    }

    GameState.pushToStack(stackItem);

    return { success: true, stackItem };
  }

  /**
   * Play a land (not a spell, no stack).
   */
  function playLand(playerId, instanceId, state) {
    const player = GameState.getPlayer(playerId);
    const card = player.hand.find(c => c.instanceId === instanceId);

    if (!card || !card.isLand) return { success: false, error: 'Not a land.' };

    const phase = GameState.getCurrentPhase();
    const isMainPhase = phase.id === 'main1' || phase.id === 'main2';
    if (!isMainPhase) return { success: false, error: 'Lands can only be played during your main phase.' };
    if (state.activePlayerIndex !== state.players.findIndex(p => p.id === playerId)) {
      return { success: false, error: 'You can only play lands on your turn.' };
    }
    if (player.landPlayedThisTurn) {
      return { success: false, error: 'You have already played a land this turn.' };
    }
    if (state.stack.length > 0) {
      return { success: false, error: 'You cannot play a land while spells are on the stack.' };
    }

    // Move land to battlefield
    const idx = player.hand.findIndex(c => c.instanceId === instanceId);
    player.hand.splice(idx, 1);
    card.currentZone = 'battlefield';
    card.tapped = false;
    card.summoningSick = false; // lands don't have summoning sickness
    player.battlefield.push(card);
    player.landPlayedThisTurn = true;

    return { success: true };
  }

  /**
   * Resolve the top of the stack. Handles permanent resolution, spell effects,
   * and commander zone replacement.
   */
  function resolveStack(state) {
    const item = GameState.resolveTopOfStack();
    if (!item) return { resolved: false };

    const player = GameState.getPlayer(item.controllerId);
    const events = [];

    if (item.type === 'spell' || item.type === 'creatureSpell' || item.type === 'planeswalkerSpell') {
      const card = item.card;

      // Permanents go to battlefield
      if (card.isCreature || card.isPlaneswalker || card.isArtifact || card.isEnchantment || card.isLand) {
        card.currentZone = 'battlefield';
        card.tapped = false;
        card.summoningSick = card.isCreature && !card.automatedKeywords.includes('Haste');
        if (card.isPlaneswalker) {
          card.currentLoyalty = card.loyalty || 0;
        }
        player.battlefield.push(card);
        events.push({ type: 'permanentEntered', card, playerId: player.id });

        // Check for triggered abilities on entry (ETB)
        const etbTriggers = checkETBTriggers(card, player.id, state);
        events.push(...etbTriggers);
      } else {
        // Non-permanent (instant/sorcery) — resolve effect then graveyard
        const effect = resolveSpellEffect(card, item.targets, player.id, state);
        events.push(...effect);
        card.currentZone = 'graveyard';
        player.graveyard.push(card);
        events.push({ type: 'spellResolved', card, playerId: player.id });
      }
    } else if (item.type === 'ability' || item.type === 'trigger') {
      const effect = resolveAbilityEffect(item, state);
      events.push(...effect);
    }

    // Check SBAs after resolution
    GameState.checkStateBasedActions();

    return { resolved: true, item, events };
  }

  // ── ETB Triggers ────────────────────────────────────────
  function checkETBTriggers(card, playerId, state) {
    const events = [];
    const oracle = (card.oracleText || '').toLowerCase();

    // Lifelink
    if (card.automatedKeywords.includes('Lifelink')) {
      // Lifelink triggers during combat damage — tracked separately
    }

    // Simple ETB: "when ~ enters, draw a card"
    if (/when .* enters.*draw a card/i.test(oracle)) {
      const drawn = GameState.drawCard(playerId);
      if (drawn) events.push({ type: 'draw', playerId, card: drawn, source: card.name });
    }

    // ETB: "when ~ enters, each opponent loses X life"
    const lifeLossMatch = oracle.match(/when .* enters.*each opponent loses (\d+) life/i);
    if (lifeLossMatch) {
      const amount = parseInt(lifeLossMatch[1]);
      for (const p of state.players) {
        if (p.id !== playerId && !p.eliminated) {
          GameState.adjustLife(p.id, -amount);
          events.push({ type: 'lifeLoss', targetId: p.id, amount, source: card.name });
        }
      }
    }

    return events;
  }

  // ── Spell Effect Resolution (simplified) ─────────────────
  function resolveSpellEffect(card, targets, casterId, state) {
    const events = [];
    const oracle = (card.oracleText || '').toLowerCase();

    // Destroy target creature
    if (/destroy target creature/i.test(oracle) && targets.length > 0) {
      for (const targetId of targets) {
        const target = GameState.getCardInstance(targetId);
        if (target && !target.automatedKeywords?.includes('Indestructible')) {
          const owner = GameState.getCardOwner(targetId);
          if (owner) {
            GameState.moveCard(targetId, owner.id, 'battlefield', owner.id, 'graveyard');
            events.push({ type: 'destroy', targetId, source: card.name });
          }
        }
      }
    }

    // "Draw X cards"
    const drawMatch = oracle.match(/draw (\d+|a) card/i);
    if (drawMatch) {
      const amount = drawMatch[1] === 'a' ? 1 : parseInt(drawMatch[1]);
      const drawn = GameState.drawCards(casterId, amount);
      events.push({ type: 'draw', playerId: casterId, count: drawn.length, source: card.name });
    }

    // "Each player draws X cards"
    const drawAllMatch = oracle.match(/each player draws (\d+) card/i);
    if (drawAllMatch) {
      const amount = parseInt(drawAllMatch[1]);
      for (const p of state.players) {
        if (!p.eliminated) {
          GameState.drawCards(p.id, amount);
          events.push({ type: 'draw', playerId: p.id, count: amount, source: card.name });
        }
      }
    }

    // "Deal X damage to any target" / "Deal X damage to target player"
    const damageMatch = oracle.match(/deals? (\d+) damage to (any target|target player|each opponent)/i);
    if (damageMatch) {
      const amount = parseInt(damageMatch[1]);
      const targetType = damageMatch[2].toLowerCase();

      if (targetType === 'each opponent') {
        for (const p of state.players) {
          if (p.id !== casterId && !p.eliminated) {
            GameState.adjustLife(p.id, -amount);
            events.push({ type: 'damage', targetId: p.id, amount, source: card.name });
          }
        }
      } else if (targets.length > 0) {
        for (const targetId of targets) {
          // Check if target is a player
          const targetPlayer = state.players.find(p => p.id === targetId);
          if (targetPlayer) {
            GameState.adjustLife(targetId, -amount);
            events.push({ type: 'damage', targetId, amount, source: card.name });
          } else {
            // Target is a permanent
            const targetCard = GameState.getCardInstance(targetId);
            if (targetCard) {
              targetCard.markedDamage = (targetCard.markedDamage || 0) + amount;
              events.push({ type: 'damage', targetId, amount, source: card.name });
            }
          }
        }
      }
    }

    return events;
  }

  // ── Ability Effect Resolution ────────────────────────────
  function resolveAbilityEffect(item, state) {
    const events = [];
    // Tapped ability resolution — mana abilities
    if (item.subtype === 'manaAbility') {
      const player = GameState.getPlayer(item.controllerId);
      GameState.addMana(item.controllerId, item.manaProduced || {});
      events.push({ type: 'manaAdded', playerId: item.controllerId, mana: item.manaProduced });
    }
    return events;
  }

  // ── Tapping for Mana ─────────────────────────────────────
  /**
   * Tap a permanent for its mana ability.
   * Returns { success, manaProduced }
   */
  function tapForMana(playerId, instanceId, state) {
    const player = GameState.getPlayer(playerId);
    const card = player.battlefield.find(c => c.instanceId === instanceId);

    if (!card) return { success: false, error: 'Card not on battlefield.' };
    if (card.tapped) return { success: false, error: 'Already tapped.' };
    if (!card.manaProduction) return { success: false, error: 'This permanent does not produce mana.' };

    card.tapped = true;
    GameState.addMana(playerId, card.manaProduction);

    return { success: true, manaProduced: card.manaProduction };
  }

  // ── Combat ───────────────────────────────────────────────
  /**
   * Declare an attacker.
   */
  function declareAttacker(playerId, instanceId, defendingId, state) {
    const player = GameState.getPlayer(playerId);
    const card = player.battlefield.find(c => c.instanceId === instanceId);

    if (!card) return { success: false, error: 'Card not on battlefield.' };
    if (!card.isCreature) return { success: false, error: 'Only creatures can attack.' };
    if (card.tapped) return { success: false, error: 'Tapped creatures cannot attack.' };
    if (card.summoningSick && !card.automatedKeywords.includes('Haste')) {
      return { success: false, error: 'This creature has summoning sickness and cannot attack.' };
    }

    card.isAttacking = true;
    // Tap attacker unless it has Vigilance
    if (!card.automatedKeywords.includes('Vigilance')) {
      card.tapped = true;
    }

    state.attackers.push({ attackerInstanceId: instanceId, defendingId });

    return { success: true };
  }

  /**
   * Declare a blocker.
   */
  function declareBlocker(blockingPlayerId, blockerInstanceId, attackerInstanceId, state) {
    const player = GameState.getPlayer(blockingPlayerId);
    const blocker = player.battlefield.find(c => c.instanceId === blockerInstanceId);
    const attacker = GameState.getCardInstance(attackerInstanceId);

    if (!blocker) return { success: false, error: 'Blocker not found.' };
    if (!blocker.isCreature) return { success: false, error: 'Only creatures can block.' };
    if (blocker.tapped) return { success: false, error: 'Tapped creatures cannot block.' };

    // Check Flying/Reach
    if (attacker && attacker.automatedKeywords.includes('Flying')) {
      const canBlock = blocker.automatedKeywords.includes('Flying') ||
                       blocker.automatedKeywords.includes('Reach');
      if (!canBlock) return { success: false, error: 'This creature cannot block a Flying creature.' };
    }

    // Check Menace (must block with 2+ creatures — simplified check)
    if (attacker && attacker.automatedKeywords.includes('Menace')) {
      const existingBlockers = state.declaredBlockers.filter(b => b.attackerInstanceId === attackerInstanceId);
      if (existingBlockers.length === 0) {
        // First blocker — valid, but note menace
      }
    }

    // Hexproof / Shroud don't affect combat blocking
    blocker.isBlocking = true;
    blocker.blockingInstanceId = attackerInstanceId;
    state.declaredBlockers.push({ blockerInstanceId, attackerInstanceId });

    return { success: true };
  }

  /**
   * Resolve combat damage step.
   */
  function resolveCombatDamage(state) {
    const events = [];

    // First strike damage
    const firstStrikeAttackers = state.attackers.filter(a => {
      const card = GameState.getCardInstance(a.attackerInstanceId);
      return card && (card.automatedKeywords.includes('First strike') ||
                      card.automatedKeywords.includes('Double strike'));
    });
    const regularAttackers = state.attackers.filter(a => {
      const card = GameState.getCardInstance(a.attackerInstanceId);
      return card && !card.automatedKeywords.includes('First strike');
    });

    // Process all attackers
    for (const attackEntry of state.attackers) {
      const attacker = GameState.getCardInstance(attackEntry.attackerInstanceId);
      if (!attacker) continue;

      const blockers = state.declaredBlockers
        .filter(b => b.attackerInstanceId === attackEntry.attackerInstanceId)
        .map(b => GameState.getCardInstance(b.blockerInstanceId))
        .filter(Boolean);

      if (blockers.length === 0) {
        // Unblocked — damage to defending player/planeswalker
        const power = attacker.currentPower || 0;
        const defPlayer = state.players.find(p => p.id === attackEntry.defendingId);

        if (defPlayer) {
          const isCommanderDamage = attacker.isCommander;
          GameState.adjustLife(defPlayer.id, -power, attacker.controllerId, isCommanderDamage);
          events.push({ type: 'combatDamage', source: attacker.name, target: defPlayer.name, amount: power });

          // Lifelink
          if (attacker.automatedKeywords.includes('Lifelink')) {
            GameState.adjustLife(attacker.controllerId, power);
            events.push({ type: 'lifelink', source: attacker.name, amount: power });
          }
        }
      } else {
        // Blocked — deal damage to blockers
        let remainingPower = attacker.currentPower || 0;

        for (const blocker of blockers) {
          const blockDmg = Math.min(remainingPower, blocker.currentToughness || 0);
          blocker.markedDamage = (blocker.markedDamage || 0) + (attacker.currentPower || 0);

          // Blocker deals damage back
          attacker.markedDamage = (attacker.markedDamage || 0) + (blocker.currentPower || 0);

          if (attacker.automatedKeywords.includes('Deathtouch')) {
            blocker.markedDamage = 999; // Deathtouch = lethal
          }
          if (blocker.automatedKeywords.includes('Deathtouch')) {
            attacker.markedDamage = 999;
          }

          // Trample
          if (attacker.automatedKeywords.includes('Trample') && blockers.length > 0) {
            remainingPower -= (blocker.currentToughness || 0);
          }

          events.push({ type: 'combatDamage', source: attacker.name, target: blocker.name, amount: blockDmg });
        }

        // Trample excess damage
        if (attacker.automatedKeywords.includes('Trample') && remainingPower > 0) {
          const defPlayer = state.players.find(p => p.id === attackEntry.defendingId);
          if (defPlayer) {
            GameState.adjustLife(defPlayer.id, -remainingPower);
            events.push({ type: 'combatDamage', source: attacker.name, target: defPlayer.name, amount: remainingPower, trample: true });
          }
        }
      }
    }

    // SBAs after combat damage
    GameState.checkStateBasedActions();

    return events;
  }

  // ── Commander Zone Replacement ───────────────────────────
  /**
   * When a commander would go to graveyard or exile, give the owner
   * the option to redirect to command zone.
   * Returns true if redirected.
   */
  function checkCommanderRedirect(instanceId, toZone, state) {
    const card = GameState.getCardInstance(instanceId);
    if (!card || !card.isCommander) return false;
    if (toZone !== 'graveyard' && toZone !== 'exile') return false;

    // For bots, always redirect
    const owner = GameState.getPlayer(card.ownerId);
    if (!owner.isHuman) {
      GameState.moveCard(instanceId, card.ownerId, toZone, card.ownerId, 'commandZone');
      return true;
    }

    // For human, this triggers a UI prompt (handled in ui.js)
    return false; // UI will handle
  }

  // ── Priority System ──────────────────────────────────────
  /**
   * Pass priority from the current holder to the next player.
   * If all players have passed, resolve the top of the stack (or advance phase).
   */
  function passPriority(playerId, state) {
    if (state.priority !== playerId) return { success: false };

    state.passedPriority.add(playerId);

    const activePlayers = state.players.filter(p => !p.eliminated);
    const allPassed = activePlayers.every(p => state.passedPriority.has(p.id));

    if (allPassed) {
      state.passedPriority = new Set();

      if (state.stack.length > 0) {
        // Resolve top of stack
        const result = resolveStack(state);
        // Priority returns to active player
        state.priority = GameState.getActivePlayer().id;
        return { stackResolved: true, result };
      } else {
        // Advance phase
        const newPhase = GameState.advancePhase();
        const phaseEvents = handlePhaseEntry(newPhase.id, state);
        state.priority = GameState.getActivePlayer().id;
        return { phaseAdvanced: true, phase: newPhase, phaseEvents };
      }
    } else {
      // Pass to next player
      const currentIdx = activePlayers.findIndex(p => p.id === playerId);
      const nextIdx = (currentIdx + 1) % activePlayers.length;
      state.priority = activePlayers[nextIdx].id;
      return { priorityPassed: true, nextPriority: state.priority };
    }
  }

  // ── APNAP Ordering ────────────────────────────────────────
  /**
   * Sort a list of triggered abilities in APNAP order.
   * Active player's triggers resolve first, then in turn order.
   */
  function apnapOrder(triggers, state) {
    const activeIdx = state.activePlayerIndex;
    return [...triggers].sort((a, b) => {
      const aIdx = state.players.findIndex(p => p.id === a.controllerId);
      const bIdx = state.players.findIndex(p => p.id === b.controllerId);
      const aNorm = (aIdx - activeIdx + state.players.length) % state.players.length;
      const bNorm = (bIdx - activeIdx + state.players.length) % state.players.length;
      return aNorm - bNorm;
    });
  }

  // ── Planeswalker Ability ──────────────────────────────────
  function activatePlaneswalkerAbility(playerId, instanceId, abilityIndex, state) {
    const player = GameState.getPlayer(playerId);
    const card = player.battlefield.find(c => c.instanceId === instanceId);

    if (!card || !card.isPlaneswalker) return { success: false, error: 'Not a planeswalker.' };
    if (player.planeswalkerAbilityUsed.has(instanceId)) {
      return { success: false, error: 'You have already used this planeswalker\'s ability this turn.' };
    }

    const phase = GameState.getCurrentPhase();
    const isMainPhase = phase.id === 'main1' || phase.id === 'main2';
    if (!isMainPhase) return { success: false, error: 'Planeswalker abilities can only be activated during your main phase.' };
    if (state.stack.length > 0) return { success: false, error: 'Cannot activate while spells are on the stack.' };

    // Parse loyalty abilities from oracle text
    const abilities = _parsePlaneswalkerAbilities(card);
    if (abilityIndex < 0 || abilityIndex >= abilities.length) {
      return { success: false, error: 'Invalid ability index.' };
    }

    const ability = abilities[abilityIndex];
    const loyaltyChange = ability.loyaltyChange;

    if (loyaltyChange < 0 && card.currentLoyalty < Math.abs(loyaltyChange)) {
      return { success: false, error: 'Not enough loyalty counters.' };
    }

    // Adjust loyalty
    card.currentLoyalty = (card.currentLoyalty || 0) + loyaltyChange;
    if (loyaltyChange > 0) {
      GameState.addCounter(instanceId, 'loyalty', loyaltyChange);
    } else {
      GameState.removeCounter(instanceId, 'loyalty', Math.abs(loyaltyChange));
    }

    player.planeswalkerAbilityUsed.add(instanceId);

    // Flag as complex (manual resolution) for most abilities
    return {
      success: true,
      ability,
      requiresManualResolution: true,
      manualPrompt: `Resolve ${card.name}'s "${ability.text}" ability manually.`,
    };
  }

  function _parsePlaneswalkerAbilities(card) {
    const oracle = card.oracleText || card.data?.oracle_text || '';
    const lines = oracle.split('\n').filter(l => l.trim());
    const abilities = [];

    for (const line of lines) {
      const plusMatch  = line.match(/^\+(\d+):\s*(.+)/);
      const zeroMatch  = line.match(/^0:\s*(.+)/);
      const minusMatch = line.match(/^−(\d+):\s*(.+)/);
      const xMatch     = line.match(/^−X:\s*(.+)/);

      if (plusMatch)  abilities.push({ loyaltyChange: +parseInt(plusMatch[1]),  text: line });
      else if (zeroMatch)  abilities.push({ loyaltyChange: 0,                   text: line });
      else if (minusMatch) abilities.push({ loyaltyChange: -parseInt(minusMatch[1]), text: line });
      else if (xMatch)     abilities.push({ loyaltyChange: 0, isX: true,        text: line });
    }

    return abilities;
  }

  // ── Keyword Checks ───────────────────────────────────────
  /**
   * Check if a card has a manual keyword that needs prompting.
   */
  function getManualKeywordPrompt(card) {
    if (!card.hasManualKeywords || card.manualKeywords.length === 0) return null;

    const descriptions = {
      'Morph':      'You may cast this card face down as a 2/2 creature for {3}. Turn it face up at any time by paying its morph cost.',
      'Foretell':   'During your turn, you may pay {2} and exile this card from your hand face down. Cast it on a later turn for its foretell cost.',
      'Suspend':    'Exile this card with time counters. At the beginning of your upkeep, remove a counter. When the last is removed, cast it for free.',
      'Cascade':    'When you cast this spell, exile cards from the top of your library until you exile a nonland card with lesser CMC. You may cast it for free.',
      'Miracle':    'You may cast this card for its miracle cost when you draw it, if it\'s the first card you drew this turn.',
      'Flashback':  'You may cast this card from your graveyard for its flashback cost. Then exile it.',
      'Madness':    'If you discard this card, you may cast it for its madness cost instead of putting it into your graveyard.',
      'Kicker':     'You may pay this spell\'s kicker cost as you cast it.',
      'Overload':   'You may cast this spell for its overload cost. If you do, change all instances of "target" to "each".',
    };

    return {
      keywords: card.manualKeywords,
      prompts: card.manualKeywords.map(kw => ({
        keyword: kw,
        description: descriptions[kw] || `${kw}: Resolve manually per the card\'s oracle text.`,
      })),
    };
  }

  // ── Mana Helpers ─────────────────────────────────────────
  function _canPayManaCost(pool, cost) {
    if (!cost) return true;
    let genericNeeded = cost.generic || 0;
    let totalPool = 0;

    for (const [color, amount] of Object.entries(cost)) {
      if (color === 'generic') continue;
      if ((pool[color] || 0) < amount) return false;
      totalPool += (pool[color] || 0) - amount;
    }

    totalPool += pool.C || 0;
    return totalPool >= genericNeeded;
  }

  function _payManaCost(player, cost) {
    if (!cost) return;
    let genericNeeded = cost.generic || 0;

    for (const [color, amount] of Object.entries(cost)) {
      if (color === 'generic') continue;
      player.manaPool[color] = (player.manaPool[color] || 0) - amount;
    }

    // Pay generic from any color
    const colorOrder = ['C', 'G', 'R', 'B', 'U', 'W'];
    for (const color of colorOrder) {
      if (genericNeeded <= 0) break;
      const available = player.manaPool[color] || 0;
      const spent = Math.min(available, genericNeeded);
      player.manaPool[color] = available - spent;
      genericNeeded -= spent;
    }
  }

  return {
    handlePhaseEntry,
    castSpell,
    playLand,
    resolveStack,
    tapForMana,
    declareAttacker,
    declareBlocker,
    resolveCombatDamage,
    checkCommanderRedirect,
    passPriority,
    apnapOrder,
    activatePlaneswalkerAbility,
    getManualKeywordPrompt,
  };
})();
