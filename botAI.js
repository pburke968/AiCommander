/**
 * botAI.js — Bot AI System
 * Intelligence scales with bracket level:
 * Bracket 1: Random legal play
 * Bracket 2: Basic threat awareness
 * Bracket 3: Mana curve + combat math
 * Bracket 4: Strategic + political targeting
 */

const BotAI = (() => {

  const THINK_DELAY_MS = 1200; // Simulate thinking time

  // ── Main Entry Point ─────────────────────────────────────
  /**
   * Called when it's a bot's turn to take an action.
   * Returns a promise that resolves after the bot acts.
   */
  async function takeTurn(botPlayerId, state) {
    const bot = GameState.getPlayer(botPlayerId);
    if (!bot || bot.eliminated) return;

    const bracket = state.bracket;
    await _think();

    // Resolve bot's decisions for the current phase
    const phase = GameState.getCurrentPhase();

    switch (phase.id) {
      case 'untap':
        // Automatic
        break;
      case 'upkeep':
        await _handleUpkeep(bot, state, bracket);
        break;
      case 'draw':
        // Automatic
        break;
      case 'main1':
      case 'main2':
        await _handleMainPhase(bot, state, bracket);
        break;
      case 'attackers':
        await _handleAttackers(bot, state, bracket);
        break;
      case 'blockers':
        await _handleBlockers(bot, state, bracket);
        break;
      case 'damage':
        // Automatic
        break;
      case 'end':
        await _handleEndStep(bot, state, bracket);
        break;
      case 'cleanup':
        await _handleCleanup(bot, state, bracket);
        break;
    }
  }

  // ── Phase Handlers ───────────────────────────────────────

  async function _handleUpkeep(bot, state, bracket) {
    // Triggered abilities at upkeep (simplified — auto-resolve)
    await _think(400);
  }

  async function _handleMainPhase(bot, state, bracket) {
    // Play lands
    const landInHand = bot.hand.find(c => c.isLand);
    if (landInHand && !bot.landPlayedThisTurn) {
      RulesEngine.playLand(bot.id, landInHand.instanceId, state);
      await _think(600);
    }

    // Cast spells based on bracket
    const spellsToCast = _selectSpellsToCast(bot, state, bracket);
    for (const card of spellsToCast) {
      // Tap lands for mana
      _tapLandsForMana(bot, card, state);
      await _think(400);

      const result = RulesEngine.castSpell(bot.id, card.instanceId, state);
      if (result.success) {
        // Auto-resolve bot's spells
        while (state.stack.length > 0 && state.stack[state.stack.length - 1].controllerId === bot.id) {
          RulesEngine.resolveStack(state);
          await _think(300);
        }
      }
    }
  }

  async function _handleAttackers(bot, state, bracket) {
    const attackers = _selectAttackers(bot, state, bracket);
    for (const attacker of attackers) {
      const target = _selectDefendingPlayer(bot, state, bracket);
      if (target) {
        RulesEngine.declareAttacker(bot.id, attacker.instanceId, target.id, state);
      }
    }
    await _think(600);
  }

  async function _handleBlockers(bot, state, bracket) {
    const incomingAttackers = state.attackers.filter(a => a.defendingId === bot.id);
    for (const attack of incomingAttackers) {
      const blocker = _selectBlocker(bot, attack.attackerInstanceId, state, bracket);
      if (blocker) {
        RulesEngine.declareBlocker(bot.id, blocker.instanceId, attack.attackerInstanceId, state);
      }
    }
    await _think(600);
  }

  async function _handleEndStep(bot, state, bracket) {
    await _think(300);
  }

  async function _handleCleanup(bot, state, bracket) {
    // Discard to hand size if needed
    while (bot.hand.length > 7) {
      const discard = _selectDiscard(bot, bracket);
      if (discard) {
        GameState.moveCard(discard.instanceId, bot.id, 'hand', bot.id, 'graveyard');
        await _think(200);
      } else break;
    }
  }

  // ── Spell Selection ──────────────────────────────────────
  function _selectSpellsToCast(bot, state, bracket) {
    const playable = bot.hand.filter(c => !c.isLand && _canAfford(bot, c));
    if (playable.length === 0) return [];

    switch (bracket) {
      case 1: return _bracket1SelectSpells(playable, bot, state);
      case 2: return _bracket2SelectSpells(playable, bot, state);
      case 3: return _bracket3SelectSpells(playable, bot, state);
      case 4: return _bracket4SelectSpells(playable, bot, state);
      default: return _bracket1SelectSpells(playable, bot, state);
    }
  }

  function _bracket1SelectSpells(playable, bot, state) {
    // Random — just play one random affordable spell
    if (Math.random() < 0.5 && playable.length > 0) {
      return [playable[Math.floor(Math.random() * playable.length)]];
    }
    return [];
  }

  function _bracket2SelectSpells(playable, bot, state) {
    // Basic: play highest CMC affordable spell, prefer creatures
    const creatures = playable.filter(c => c.isCreature);
    const others = playable.filter(c => !c.isCreature);

    // Prioritize removal if threats exist
    const humanPlayer = state.players.find(p => p.isHuman && !p.eliminated);
    if (humanPlayer && humanPlayer.battlefield.length > 2) {
      const removal = others.find(c => /destroy target|exile target/i.test(c.oracleText));
      if (removal) return [removal];
    }

    const best = [...creatures, ...others].sort((a, b) => b.cmc - a.cmc)[0];
    return best ? [best] : [];
  }

  function _bracket3SelectSpells(playable, bot, state) {
    // Mana curve: prefer to spend as much mana as possible efficiently
    const manaAvailable = _totalManaAvailable(bot);
    let bestCombo = [];
    let bestSpent = 0;

    // Try combinations of 1-2 spells
    for (const spell of playable) {
      const cost = spell.cmc || 0;
      if (cost <= manaAvailable && cost > bestSpent) {
        bestCombo = [spell];
        bestSpent = cost;
      }
    }

    // Prefer ramp/card draw over nothing
    if (bestCombo.length === 0) {
      const ramp = playable.find(c => /add mana|search your library for.*land/i.test(c.oracleText));
      if (ramp) return [ramp];
    }

    return bestCombo;
  }

  function _bracket4SelectSpells(playable, bot, state) {
    // Strategic: prioritize win conditions, removal, ramp
    const winCons = playable.filter(c => _isWinCondition(c));
    if (winCons.length > 0) return [winCons[0]];

    const removal = playable.filter(c => _isRemoval(c));
    const ramp    = playable.filter(c => _isRamp(c));
    const draw    = playable.filter(c => _isCardDraw(c));
    const threats = playable.filter(c => c.isCreature && (c.currentPower || 0) >= 4);

    // Sequence: removal > ramp > draw > threats > other
    const priority = [...removal, ...ramp, ...draw, ...threats, ...playable];
    const deduped = [...new Set(priority)];

    // Play as many affordable spells as possible
    const toCast = [];
    let manaLeft = _totalManaAvailable(bot);
    for (const card of deduped) {
      if ((card.cmc || 0) <= manaLeft) {
        toCast.push(card);
        manaLeft -= (card.cmc || 0);
        if (toCast.length >= 3) break;
      }
    }
    return toCast;
  }

  // ── Attacker Selection ───────────────────────────────────
  function _selectAttackers(bot, state, bracket) {
    const attackCandidates = bot.battlefield.filter(c =>
      c.isCreature && !c.tapped && !c.summoningSick
    );

    if (attackCandidates.length === 0) return [];

    switch (bracket) {
      case 1: {
        // Attack randomly 50% of the time with random creatures
        return attackCandidates.filter(() => Math.random() < 0.5);
      }
      case 2: {
        // Attack if it's favorable (our power >= their toughness or they have no blockers)
        const target = _selectDefendingPlayer(bot, state, bracket);
        if (!target) return [];
        const blockers = target.battlefield.filter(c => c.isCreature && !c.tapped);
        return attackCandidates.filter(a => {
          const defended = blockers.some(b => (b.currentToughness || 0) >= (a.currentPower || 0));
          return !defended || blockers.length === 0;
        });
      }
      case 3:
      case 4: {
        // Combat math: attack with creatures where we come out ahead
        const target = _selectDefendingPlayer(bot, state, bracket);
        if (!target) return [];

        return attackCandidates.filter(attacker => {
          const ap = attacker.currentPower || 0;
          const at = attacker.currentToughness || 0;

          // Would we survive or is the damage worth it?
          const worstBlocker = target.battlefield
            .filter(c => c.isCreature && !c.tapped)
            .sort((a, b) => (b.currentToughness || 0) - (a.currentToughness || 0))[0];

          if (!worstBlocker) return true; // No blockers — always attack
          return ap > (worstBlocker.currentToughness || 0) || at > (worstBlocker.currentPower || 0);
        });
      }
      default: return [];
    }
  }

  function _selectDefendingPlayer(bot, state, bracket) {
    const opponents = state.players.filter(p => p.id !== bot.id && !p.eliminated);
    if (opponents.length === 0) return null;

    switch (bracket) {
      case 1:
      case 2:
        // Attack random opponent
        return opponents[Math.floor(Math.random() * opponents.length)];
      case 3:
        // Attack lowest life total
        return opponents.reduce((a, b) => a.life < b.life ? a : b);
      case 4: {
        // Political: attack the player who is winning (most permanents + highest life)
        const score = p => p.life + p.battlefield.length * 2;
        return opponents.reduce((a, b) => score(b) > score(a) ? b : a);
      }
      default:
        return opponents[0];
    }
  }

  // ── Blocker Selection ─────────────────────────────────────
  function _selectBlocker(bot, attackerInstanceId, state, bracket) {
    const attacker = GameState.getCardInstance(attackerInstanceId);
    if (!attacker) return null;

    const validBlockers = bot.battlefield.filter(c =>
      c.isCreature && !c.tapped && !c.isBlocking
    );

    if (validBlockers.length === 0) return null;

    switch (bracket) {
      case 1:
        return Math.random() < 0.3 ? validBlockers[0] : null;
      case 2:
        // Block to prevent lethal
        if (attacker.currentPower || 0 >= bot.life) {
          return validBlockers[0];
        }
        return null;
      case 3:
      case 4: {
        // Block if favorable trade or blocking lethal damage
        const ap = attacker.currentPower || 0;
        if (ap >= bot.life) return validBlockers[0]; // Block lethal

        // Find favorable trade
        const favorable = validBlockers.find(b => {
          const bp = b.currentPower || 0;
          const bt = b.currentToughness || 0;
          const at = attacker.currentToughness || 0;
          return bp >= at && bt > ap;
        });
        return favorable || null;
      }
      default:
        return null;
    }
  }

  // ── Discard Selection ─────────────────────────────────────
  function _selectDiscard(bot, bracket) {
    if (bot.hand.length === 0) return null;
    // Discard lowest CMC / least useful card
    return bot.hand.sort((a, b) => (a.cmc || 0) - (b.cmc || 0))[0];
  }

  // ── Mana Helpers ─────────────────────────────────────────
  function _canAfford(bot, card) {
    const cost = ScryfallAPI.parseManaCost(card.manaCost);
    if (!cost) return card.cmc === 0;
    const totalPool = Object.values(bot.manaPool).reduce((a, b) => a + b, 0);
    return totalPool >= (card.cmc || 0);
  }

  function _tapLandsForMana(bot, targetCard, state) {
    const neededMana = targetCard.cmc || 0;
    let tappedMana = 0;

    const untappedLands = bot.battlefield.filter(c => c.isLand && !c.tapped && c.manaProduction);
    for (const land of untappedLands) {
      if (tappedMana >= neededMana) break;
      RulesEngine.tapForMana(bot.id, land.instanceId, state);
      tappedMana += Object.values(land.manaProduction || {}).reduce((a, b) => a + b, 0);
    }
  }

  function _totalManaAvailable(bot) {
    const fromPool = Object.values(bot.manaPool).reduce((a, b) => a + b, 0);
    const fromLands = bot.battlefield
      .filter(c => c.isLand && !c.tapped && c.manaProduction)
      .reduce((sum, c) => sum + Object.values(c.manaProduction || {}).reduce((a, b) => a + b, 0), 0);
    return fromPool + fromLands;
  }

  // ── Card Classifiers ──────────────────────────────────────
  function _isRemoval(card) {
    return /destroy target|exile target|return target.*to.*hand|counter target/i.test(card.oracleText);
  }
  function _isRamp(card) {
    return /search your library for.*land|add \{[WUBRGC]\}.*\{[WUBRGC]\}/i.test(card.oracleText);
  }
  function _isCardDraw(card) {
    return /draw (a|\d+) card/i.test(card.oracleText) && !card.isLand;
  }
  function _isWinCondition(card) {
    return /each opponent loses|win the game|opponents lose/i.test(card.oracleText);
  }

  function _think(ms = THINK_DELAY_MS) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── Bot Mulligan Decision ─────────────────────────────────
  function shouldMulligan(hand, bracket) {
    const lands = hand.filter(c => c.isLand).length;
    // Basic heuristic: mulligan if 0-1 lands or 7 lands
    if (lands <= 1 || lands >= 6) return true;
    if (bracket >= 3 && lands < 2) return true;
    return false;
  }

  return {
    takeTurn,
    shouldMulligan,
  };
})();
