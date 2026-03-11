/**
 * main.js — Game Entry Point
 * Orchestrates all modules: start screen, loading, mulligan, game loop.
 */

(async () => {

  // ── State ──────────────────────────────────────────────────
  let gameState = null;
  let selectedCard = null;
  let targetingMode = false;
  let validTargets = [];
  let mulliganCount = 0;
  let bottomCards = [];
  let _counterTargetCard = null;

  // ── Setup ──────────────────────────────────────────────────
  UI.setupHoverPreview();
  bindStartScreen();
  bindGameControls();
  bindOverlays();

  // ── Start Screen ──────────────────────────────────────────
  function bindStartScreen() {
    document.querySelectorAll('.bracket-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.bracket-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    const deckInput = document.getElementById('deck-input');
    const startBtn  = document.getElementById('btn-start-game');

    deckInput.addEventListener('input', () => {
      const hasContent = deckInput.value.trim().length > 20;
      startBtn.disabled = !hasContent;
      startBtn.querySelector('.btn-text').textContent = hasContent ? 'Validate Deck' : 'Validate Deck';
    });

    startBtn.addEventListener('click', handleStartClick);
    document.getElementById('btn-play-again').addEventListener('click', resetToStart);
  }

  async function handleStartClick() {
    const deckText = document.getElementById('deck-input').value.trim();
    const bracket  = parseInt(document.querySelector('.bracket-btn.active')?.dataset.bracket || '1');
    const startBtn = document.getElementById('btn-start-game');

    const parsed = DeckValidator.parseDecklist(deckText);
    if (parsed.cards.length === 0) {
      UI.showValidationMessages(['No cards found. Please check the format.'], [], []);
      return;
    }

    startBtn.disabled = true;
    startBtn.querySelector('.btn-text').textContent = 'Validating...';

    const allNames = [...new Set(parsed.cards.map(c => c.name))];
    UI.showValidationMessages([], [], [`Fetching ${allNames.length} cards from Scryfall...`]);

    try {
      const cardDataMap = await ScryfallAPI.batchFetchCards(allNames, (done, total) => {
        UI.showValidationMessages([], [], [`Fetching card data: ${done}/${total}...`]);
      });

      const validation = DeckValidator.validateCommander(parsed, cardDataMap);

      if (!validation.valid) {
        UI.showValidationMessages(validation.errors, validation.warnings, []);
        startBtn.disabled = false;
        startBtn.querySelector('.btn-text').textContent = 'Validate Deck';
        return;
      }

      const summary = DeckValidator.summarizeDeck(parsed.cards, cardDataMap);
      UI.showValidationMessages([], validation.warnings, [
        `Deck valid — Commander: ${validation.commanderName}`,
        `Colors: ${(validation.commanderIdentity || []).join('')} | Creatures: ${summary.creature} | Lands: ${summary.land}`,
      ]);

      startBtn.querySelector('.btn-text').textContent = 'Starting...';
      await sleep(600);
      await startGame(parsed, cardDataMap, validation.commanderName, bracket);

    } catch (err) {
      UI.showValidationMessages([`Error: ${err.message}`], [], []);
      startBtn.disabled = false;
      startBtn.querySelector('.btn-text').textContent = 'Validate Deck';
    }
  }

  // ── Game Start ─────────────────────────────────────────────
  async function startGame(parsedDeck, cardDataMap, commanderName, bracketLevel) {
    UI.showScreen('loading');

    try {
      UI.updateLoadingProgress('Selecting bot decks...', 0.05);
      const botDeckDefs = getRandomBotDecks(bracketLevel);
      const botDecksWithData = [];

      for (let i = 0; i < botDeckDefs.length; i++) {
        const deck = botDeckDefs[i];
        const names = [...new Set(deck.cards)];
        UI.updateLoadingProgress(`Loading ${deck.name}...`, 0.1 + (i / 3) * 0.7, `${names.length} cards`);

        const botCardMap = await ScryfallAPI.batchFetchCards(names, (done, total) => {
          UI.updateLoadingProgress(`Loading ${deck.name}...`, 0.1 + (i / 3) * 0.7 + (done / total) * (0.7 / 3), `${done}/${total}`);
        });

        botDecksWithData.push({ ...deck, cardDataMap: botCardMap });
      }

      UI.updateLoadingProgress('Building game state...', 0.85);

      // Init game with placeholder bot data (we'll build libraries manually)
      const placeholderBotData = botDecksWithData.map(d => ({ name: d.name, cards: [], cardDataMap: d.cardDataMap, commanderName: d.commander }));
      gameState = GameState.initGame({ cards: parsedDeck.cards, cardDataMap, commanderName }, placeholderBotData, bracketLevel);

      // Build bot libraries
      for (let i = 0; i < 3; i++) {
        buildBotLibrary(gameState.players[i + 1], botDecksWithData[i]);
      }

      UI.updateLoadingProgress('Ready!', 1.0);
      await sleep(400);
      startMulligan();

    } catch (err) {
      console.error(err);
      UI.showError(`Failed to start: ${err.message}`);
      setTimeout(() => resetToStart(), 2000);
    }
  }

  function buildBotLibrary(player, deckData) {
    const cards = [];
    player.commandZone = [];

    for (const cardName of deckData.cards) {
      const data = deckData.cardDataMap.get(cardName);
      if (!data) continue;
      const instance = GameState.createCardInstance(data, player.id);
      if (cardName === deckData.commander) {
        instance.isCommander = true;
        instance.currentZone = 'commandZone';
        player.commandZone = [instance];
      } else {
        instance.currentZone = 'library';
        cards.push(instance);
      }
    }

    // Shuffle library
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    player.library = cards;
  }

  // ── Mulligan ───────────────────────────────────────────────
  function startMulligan() {
    mulliganCount = 0;
    bottomCards = [];

    for (const player of gameState.players) {
      GameState.drawCards(player.id, 7);
    }

    // Bots auto-mulligan
    for (let i = 1; i <= 3; i++) {
      autoBotMulligan(gameState.players[i]);
    }

    UI.showScreen('mulligan');
    renderMulliganScreen();

    document.getElementById('btn-keep').onclick = handleKeepHand;
    document.getElementById('btn-mulligan').onclick = handleMulligan;
    document.getElementById('btn-confirm-bottom').onclick = handleConfirmBottom;
  }

  function autoBotMulligan(bot) {
    let tries = 0;
    while (BotAI.shouldMulligan(bot.hand, gameState.bracket) && tries < 4) {
      bot.library.push(...bot.hand);
      bot.hand = [];
      shuffleArray(bot.library);
      GameState.drawCards(bot.id, 7);
      tries++;
    }
  }

  function renderMulliganScreen() {
    const player = GameState.getPlayer('p1');
    UI.renderMulliganHand(player.hand, mulliganCount, onMulliganCardClick);
    document.getElementById('mulligan-info').textContent = mulliganCount === 0
      ? `Opening hand — ${player.hand.length} cards. Keep or Mulligan?`
      : `Mulligan ${mulliganCount}: select ${mulliganCount - bottomCards.length} more card(s) to put on the bottom.`;

    document.getElementById('btn-confirm-bottom').disabled = mulliganCount > 0 && bottomCards.length < mulliganCount;
    document.getElementById('mulligan-scry').classList.toggle('hidden', mulliganCount === 0);
    document.getElementById('scry-count').textContent = mulliganCount;
    document.getElementById('btn-mulligan').style.display = mulliganCount >= 6 ? 'none' : '';
  }

  function handleMulligan() {
    mulliganCount++;
    const player = GameState.getPlayer('p1');
    player.library.push(...player.hand);
    player.hand = [];
    bottomCards = [];
    shuffleArray(player.library);
    GameState.drawCards(player.id, 7);
    renderMulliganScreen();
  }

  function handleKeepHand() {
    if (mulliganCount > 0 && bottomCards.length < mulliganCount) {
      UI.showError(`Select ${mulliganCount - bottomCards.length} more card(s) to put on the bottom.`);
      return;
    }
    confirmBottomCards();
    enterGame();
  }

  function handleConfirmBottom() {
    if (bottomCards.length < mulliganCount) return;
    confirmBottomCards();
    enterGame();
  }

  function onMulliganCardClick(card) {
    if (mulliganCount === 0) return;
    const imgEl = document.querySelector(`[data-instance-id="${card.instanceId}"] img`);

    if (bottomCards.includes(card.instanceId)) {
      bottomCards = bottomCards.filter(id => id !== card.instanceId);
      imgEl?.classList.remove('selected-bottom');
    } else if (bottomCards.length < mulliganCount) {
      bottomCards.push(card.instanceId);
      imgEl?.classList.add('selected-bottom');
    }

    document.getElementById('btn-confirm-bottom').disabled = bottomCards.length < mulliganCount;
    document.getElementById('mulligan-info').textContent =
      `Mulligan ${mulliganCount}: select ${mulliganCount - bottomCards.length} more card(s) to put on the bottom.`;
  }

  function confirmBottomCards() {
    const player = GameState.getPlayer('p1');
    for (const id of bottomCards) {
      const idx = player.hand.findIndex(c => c.instanceId === id);
      if (idx !== -1) {
        const [card] = player.hand.splice(idx, 1);
        card.currentZone = 'library';
        player.library.push(card);
      }
    }
    bottomCards = [];
  }

  function enterGame() {
    RulesEngine.handlePhaseEntry(GameState.getCurrentPhase().id, gameState);
    UI.showScreen('game');
    gameState.priority = 'p1';
    fullRender();
  }

  // ── Card Interactions ──────────────────────────────────────
  function handleCardClick(card) {
    if (!gameState || gameState.gameOver) return;

    const state = gameState;
    const isPlayerPriority = state.priority === 'p1';
    const isPlayerTurn = state.activePlayerIndex === 0;
    const phase = GameState.getCurrentPhase();

    // Targeting mode
    if (targetingMode) {
      if (validTargets.includes(card.instanceId)) {
        resolveTargetSelection(card.instanceId);
      }
      return;
    }

    // === HAND CARD ===
    if (card.currentZone === 'hand' && card.controllerId === 'p1') {
      if (!isPlayerPriority) { UI.showError('You do not have priority.'); return; }

      if (card.isLand) {
        const result = RulesEngine.playLand('p1', card.instanceId, state);
        if (!result.success) UI.showError(result.error);
        else fullRender();
        return;
      }

      const kwPrompt = RulesEngine.getManualKeywordPrompt(card);
      if (kwPrompt) UI.showKeywordModal(card);

      const result = RulesEngine.castSpell('p1', card.instanceId, state);
      if (!result.success) { UI.showError(result.error); return; }

      fullRender();

      if (/target/i.test(card.oracleText)) {
        enterTargetingMode(card);
      } else {
        setTimeout(() => { RulesEngine.resolveStack(state); fullRender(); checkGameOver(); }, 350);
      }
      return;
    }

    // === COMMAND ZONE ===
    if (card.currentZone === 'commandZone' && card.ownerId === 'p1') {
      if (!isPlayerPriority) { UI.showError('You do not have priority.'); return; }
      const result = RulesEngine.castSpell('p1', card.instanceId, state);
      if (!result.success) UI.showError(result.error);
      else { fullRender(); setTimeout(() => { RulesEngine.resolveStack(state); fullRender(); checkGameOver(); }, 350); }
      return;
    }

    // === BATTLEFIELD ===
    if (card.currentZone === 'battlefield' && card.controllerId === 'p1') {
      // Tap for mana
      if ((card.isLand || (card.isArtifact && card.manaProduction)) && !card.tapped && isPlayerPriority) {
        const result = RulesEngine.tapForMana('p1', card.instanceId, state);
        if (result.success) fullRender();
        else UI.showError(result.error);
        return;
      }

      // Declare attacker
      if (card.isCreature && phase.id === 'attackers' && isPlayerTurn) {
        const opponents = state.players.filter(p => p.id !== 'p1' && !p.eliminated);
        if (opponents.length === 0) return;

        if (opponents.length === 1) {
          const result = RulesEngine.declareAttacker('p1', card.instanceId, opponents[0].id, state);
          if (!result.success) UI.showError(result.error);
          else fullRender();
        } else {
          enterAttackTargetMode(card, opponents);
        }
        return;
      }

      // Declare blocker
      if (card.isCreature && phase.id === 'blockers' && !isPlayerTurn) {
        const incoming = state.attackers.filter(a => a.defendingId === 'p1');
        if (incoming.length === 1) {
          const result = RulesEngine.declareBlocker('p1', card.instanceId, incoming[0].attackerInstanceId, state);
          if (!result.success) UI.showError(result.error);
          else fullRender();
        } else if (incoming.length > 1) {
          enterBlockSelectMode(card, incoming);
        }
        return;
      }
    }
  }

  function handleCardRightClick(card) {
    if (card.currentZone === 'battlefield') {
      _counterTargetCard = card;
      UI.showCounterModal(card);
    }
  }

  // ── Targeting ──────────────────────────────────────────────
  function enterTargetingMode(card) {
    targetingMode = true;
    selectedCard = card;
    validTargets = computeValidTargets(card);

    validTargets.forEach(id => {
      const el = document.querySelector(`[data-instance-id="${id}"] img`);
      if (el) el.classList.add('valid-target');
      // Also highlight player life totals as targets
    });

    gameState.players.forEach(p => {
      if (!p.eliminated && p.id !== 'p1' && /target player|any target|target opponent/i.test(card.oracleText)) {
        const lifeEl = document.getElementById(`${p.id}-life`);
        if (lifeEl) { lifeEl.style.outline = '2px solid var(--success)'; lifeEl.style.cursor = 'pointer'; lifeEl.onclick = () => resolveTargetSelection(p.id); }
      }
    });
  }

  function computeValidTargets(card) {
    const oracle = card.oracleText || '';
    const targets = [];

    if (/target creature/i.test(oracle)) {
      gameState.players.forEach(p => p.battlefield.forEach(c => {
        if (c.isCreature && !c.automatedKeywords?.includes('Hexproof') && !c.automatedKeywords?.includes('Shroud')) {
          targets.push(c.instanceId);
        }
      }));
    }
    if (/target player|any target|target opponent/i.test(oracle)) {
      gameState.players.forEach(p => { if (!p.eliminated) targets.push(p.id); });
    }
    if (/target artifact/i.test(oracle)) {
      gameState.players.forEach(p => p.battlefield.forEach(c => { if (c.isArtifact) targets.push(c.instanceId); }));
    }
    if (/target enchantment/i.test(oracle)) {
      gameState.players.forEach(p => p.battlefield.forEach(c => { if (c.isEnchantment) targets.push(c.instanceId); }));
    }
    return targets;
  }

  function resolveTargetSelection(targetId) {
    targetingMode = false;
    clearTargetHighlights();

    if (gameState.stack.length > 0) {
      gameState.stack[gameState.stack.length - 1].targets = [targetId];
    }

    setTimeout(() => { RulesEngine.resolveStack(gameState); fullRender(); checkGameOver(); }, 300);
  }

  function clearTargetHighlights() {
    document.querySelectorAll('.valid-target').forEach(el => el.classList.remove('valid-target'));
    gameState?.players.forEach(p => {
      const el = document.getElementById(`${p.id}-life`);
      if (el) { el.style.outline = ''; el.style.cursor = ''; el.onclick = null; }
    });
    validTargets = [];
    selectedCard = null;
  }

  function enterAttackTargetMode(card, opponents) {
    const imgEl = document.querySelector(`[data-instance-id="${card.instanceId}"] img`);
    if (imgEl) imgEl.classList.add('attacking');

    opponents.forEach(p => {
      const zone = document.getElementById(`zone-${p.id}`);
      if (!zone) return;
      zone.style.outline = '2px solid var(--danger)';
      zone.style.cursor = 'pointer';
      zone.onclick = () => {
        zone.style.outline = '';
        zone.style.cursor = '';
        zone.onclick = null;
        imgEl?.classList.remove('attacking');
        RulesEngine.declareAttacker('p1', card.instanceId, p.id, gameState);
        fullRender();
      };
    });
  }

  function enterBlockSelectMode(blockerCard, incomingAttacks) {
    incomingAttacks.forEach(attack => {
      const el = document.querySelector(`[data-instance-id="${attack.attackerInstanceId}"] img`);
      if (!el) return;
      el.classList.add('valid-target');
      el.onclick = (e) => {
        e.stopPropagation();
        el.classList.remove('valid-target');
        el.onclick = null;
        RulesEngine.declareBlocker('p1', blockerCard.instanceId, attack.attackerInstanceId, gameState);
        fullRender();
      };
    });
  }

  // ── Priority & Turn ────────────────────────────────────────
  function bindGameControls() {
    document.getElementById('btn-pass-priority').addEventListener('click', handlePassPriority);
    document.getElementById('btn-end-turn').addEventListener('click', handleEndTurn);

    document.addEventListener('keydown', e => {
      if (!document.getElementById('screen-game').classList.contains('active')) return;
      if (e.key === 'p' || e.key === 'P') handlePassPriority();
      if (e.key === 'e' || e.key === 'E') handleEndTurn();
      if (e.key === 'Escape') { cancelTargeting(); UI.hideZoneOverlay(); UI.hideCounterModal(); UI.hideKeywordModal(); }
    });

    document.addEventListener('pwAbility', e => {
      const { card, abilityIndex } = e.detail;
      handlePWAbility(card, abilityIndex);
    });
  }

  async function handlePassPriority() {
    if (!gameState || gameState.priority !== 'p1') return;

    const result = RulesEngine.passPriority('p1', gameState);

    if (result.stackResolved) {
      fullRender();
      checkGameOver();
      await handleCommanderRedirects();
    } else if (result.phaseAdvanced) {
      fullRender();
    }

    await processBotActions();
    fullRender();
  }

  async function handleEndTurn() {
    if (!gameState || gameState.activePlayerIndex !== 0) {
      UI.showError("It's not your turn."); return;
    }

    // Fast-forward through remaining phases
    let safety = 20;
    while (gameState.activePlayerIndex === 0 && !gameState.gameOver && safety-- > 0) {
      const result = RulesEngine.passPriority('p1', gameState);
      if (result.phaseAdvanced && gameState.activePlayerIndex !== 0) break;
      if (!result.phaseAdvanced && !result.stackResolved) break;
    }

    fullRender();
    checkGameOver();
    if (!gameState.gameOver) await processBotActions();
    fullRender();
  }

  // ── Bot Turn Processing ────────────────────────────────────
  async function processBotActions() {
    if (!gameState || gameState.gameOver) return;

    let safety = 40;
    while (gameState.activePlayerIndex !== 0 && !gameState.gameOver && safety-- > 0) {
      const botPlayer = GameState.getActivePlayer();

      // Bot takes action for this phase
      await BotAI.takeTurn(botPlayer.id, gameState);
      fullRender();
      await sleep(200);

      // Bot passes priority
      const result = RulesEngine.passPriority(botPlayer.id, gameState);

      if (result.stackResolved) {
        fullRender();
        checkGameOver();
        await handleCommanderRedirects();
      } else if (result.phaseAdvanced) {
        fullRender();
        // If it's now the player's turn, stop
        if (gameState.activePlayerIndex === 0) break;
      } else if (result.priorityPassed) {
        // Priority passed to next — could be another bot or player
        if (gameState.priority === 'p1') break; // Player gets priority
      }

      if (gameState.gameOver) break;
    }

    fullRender();
  }

  // ── Commander Redirect ─────────────────────────────────────
  async function handleCommanderRedirects() {
    // Check if any commander is in graveyard/exile and should go to command zone
    for (const player of gameState.players) {
      for (const zone of ['graveyard', 'exile']) {
        const commanders = player[zone].filter(c => c.isCommander);
        for (const cmd of commanders) {
          if (player.isHuman) {
            const yes = confirm(`${cmd.name} is going to the ${zone}. Move it to the command zone instead?`);
            if (yes) {
              GameState.moveCard(cmd.instanceId, player.id, zone, player.id, 'commandZone');
              fullRender();
            }
          } else {
            // Bots always redirect
            GameState.moveCard(cmd.instanceId, player.id, zone, player.id, 'commandZone');
          }
        }
      }
    }
  }

  // ── Planeswalker Abilities ─────────────────────────────────
  function handlePWAbility(card, abilityIndex) {
    if (!gameState || gameState.priority !== 'p1') return;
    const result = RulesEngine.activatePlaneswalkerAbility('p1', card.instanceId, abilityIndex, gameState);
    if (!result.success) { UI.showError(result.error); return; }
    if (result.requiresManualResolution) {
      UI.showKeywordModal({ name: card.name, manualKeywords: ['ability'], oracleText: '', hasManualKeywords: true,
        data: { oracle_text: result.manualPrompt } });
    }
    fullRender();
  }

  // ── Overlay Bindings ──────────────────────────────────────
  function bindOverlays() {
    document.getElementById('btn-close-zone').addEventListener('click', UI.hideZoneOverlay);
    document.getElementById('btn-dismiss-error').addEventListener('click', UI.hideError);
    document.getElementById('btn-close-counter').addEventListener('click', () => { UI.hideCounterModal(); fullRender(); });
    document.getElementById('btn-close-keyword').addEventListener('click', UI.hideKeywordModal);

    // Zone buttons
    ['p1','p2','p3','p4'].forEach(pid => {
      const gy  = document.getElementById(`${pid}-graveyard-btn`);
      const exl = document.getElementById(`${pid}-exile-btn`);
      if (gy) gy.addEventListener('click', () => {
        const p = GameState.getPlayer(pid);
        if (p) UI.showZoneOverlay(`${p.name}'s Graveyard`, p.graveyard);
      });
      if (exl) exl.addEventListener('click', () => {
        const p = GameState.getPlayer(pid);
        if (p) UI.showZoneOverlay(`${p.name}'s Exile`, p.exile);
      });
    });

    // Counter add
    const typeSelect = document.getElementById('counter-type-select');
    const customInput = document.getElementById('counter-custom-name');
    typeSelect?.addEventListener('change', () => {
      if (customInput) customInput.style.display = typeSelect.value === 'custom' ? '' : 'none';
    });
    document.getElementById('btn-add-counter')?.addEventListener('click', () => {
      if (!_counterTargetCard) return;
      const type = typeSelect?.value === 'custom' ? (customInput?.value || 'custom') : (typeSelect?.value || '+1/+1');
      GameState.addCounter(_counterTargetCard.instanceId, type, 1);
      UI.showCounterModal(_counterTargetCard);
      fullRender();
    });

    // Make counter modal reference accessible to ui.js
    Object.defineProperty(UI, '_counterTargetCard', {
      get: () => _counterTargetCard,
      set: (v) => { _counterTargetCard = v; },
      configurable: true,
    });
  }

  function cancelTargeting() {
    if (!targetingMode) return;
    targetingMode = false;
    clearTargetHighlights();
    // Return top spell to hand if it was the player's
    if (gameState?.stack.length > 0) {
      const top = gameState.stack[gameState.stack.length - 1];
      if (top?.controllerId === 'p1' && top?.card) {
        gameState.stack.pop();
        top.card.currentZone = 'hand';
        GameState.getPlayer('p1').hand.push(top.card);
        fullRender();
      }
    }
  }

  // ── Win/Loss Check ─────────────────────────────────────────
  function checkGameOver() {
    if (!gameState?.gameOver) return;
    const winner = gameState.winner ? GameState.getPlayer(gameState.winner) : null;
    if (winner?.isHuman) {
      UI.showResult(true, 'You outlasted all opponents. Well played!');
    } else {
      const elimBy = gameState.players.find(p => !p.eliminated && !p.isHuman);
      UI.showResult(false, `You were eliminated. ${elimBy?.name || 'A bot'} won the game.`);
    }
  }

  // ── Full Render ────────────────────────────────────────────
  function fullRender() {
    if (!gameState) return;
    UI.fullRender(gameState, {
      onCardClick: handleCardClick,
      onCardRightClick: handleCardRightClick,
    });
    checkGameOver();
  }

  // ── Reset ──────────────────────────────────────────────────
  function resetToStart() {
    gameState = null;
    selectedCard = null;
    targetingMode = false;
    validTargets = [];
    mulliganCount = 0;
    bottomCards = [];
    _counterTargetCard = null;
    ScryfallAPI.clearCache();

    const startBtn = document.getElementById('btn-start-game');
    if (startBtn) { startBtn.disabled = true; startBtn.querySelector('.btn-text').textContent = 'Validate Deck'; }
    document.getElementById('deck-input').value = '';
    document.getElementById('validation-panel').classList.add('hidden');
    UI.showScreen('start');
  }

  // ── Utilities ──────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

})();
