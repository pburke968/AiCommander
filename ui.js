/**
 * ui.js — UI Layer
 * Handles all DOM rendering, card display, interactions, hover previews,
 * zone overlays, counter modals, phase display, and screen transitions.
 */

const UI = (() => {

  // ── Screen Management ─────────────────────────────────────
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const screen = document.getElementById(`screen-${id}`);
    if (screen) screen.classList.add('active');
  }

  // ── Card Preview ──────────────────────────────────────────
  const _preview = document.getElementById('card-preview');
  const _previewImg = document.getElementById('card-preview-img');

  function setupHoverPreview() {
    document.addEventListener('mousemove', e => {
      if (!_preview.classList.contains('hidden')) {
        const x = e.clientX + 20;
        const y = e.clientY - 140;
        const clampedX = Math.min(x, window.innerWidth - 220);
        const clampedY = Math.max(10, Math.min(y, window.innerHeight - 300));
        _preview.style.left = `${clampedX}px`;
        _preview.style.top  = `${clampedY}px`;
      }
    });
  }

  function showCardPreview(imageUrl) {
    if (!imageUrl) return;
    _previewImg.src = imageUrl;
    _preview.classList.remove('hidden');
  }

  function hideCardPreview() {
    _preview.classList.add('hidden');
  }

  // ── Card Rendering ────────────────────────────────────────
  /**
   * Create a card wrapper element with thumb, counters, and controls.
   */
  function createCardElement(cardInstance, options = {}) {
    const { interactive = true, showCounters = true, onClick, onContextMenu } = options;

    const wrap = document.createElement('div');
    wrap.className = 'card-wrap';
    wrap.dataset.instanceId = cardInstance.instanceId;

    const img = document.createElement('img');
    img.className = 'card-thumb';
    img.src = _getCurrentFaceImage(cardInstance);
    img.alt = cardInstance.name;
    img.loading = 'lazy';

    // Error fallback
    img.onerror = () => { img.src = ScryfallAPI.cardBackUrl(); };

    // Tapped
    if (cardInstance.tapped) img.classList.add('tapped');

    // Hover preview
    img.addEventListener('mouseenter', () => showCardPreview(_getCurrentFaceImage(cardInstance)));
    img.addEventListener('mouseleave', hideCardPreview);

    // Click
    if (interactive && onClick) {
      img.addEventListener('click', (e) => { e.stopPropagation(); onClick(cardInstance, e); });
    }

    // Right-click context menu
    if (interactive && onContextMenu) {
      img.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(cardInstance, e); });
    }

    wrap.appendChild(img);

    // Transform button for DFCs
    if (cardInstance.isDoubleFaced) {
      const btn = document.createElement('button');
      btn.className = 'card-transform-btn';
      btn.title = 'Transform / Flip';
      btn.textContent = '↻';
      btn.addEventListener('click', (e) => { e.stopPropagation(); transformCard(cardInstance, img); });
      wrap.appendChild(btn);
    }

    // Manual keyword flag
    if (cardInstance.hasManualKeywords) {
      const flag = document.createElement('div');
      flag.className = 'card-keyword-flag';
      flag.title = `Complex keywords: ${cardInstance.manualKeywords.join(', ')}`;
      flag.textContent = '!';
      flag.addEventListener('click', (e) => {
        e.stopPropagation();
        showKeywordModal(cardInstance);
      });
      wrap.appendChild(flag);
    }

    // Counters
    if (showCounters && Object.keys(cardInstance.counters || {}).length > 0) {
      const counterDiv = document.createElement('div');
      counterDiv.className = 'card-counters';
      counterDiv.id = `counters-${cardInstance.instanceId}`;
      _renderCounters(counterDiv, cardInstance);
      wrap.appendChild(counterDiv);
    }

    // Planeswalker loyalty buttons (on battlefield)
    if (cardInstance.isPlaneswalker && options.showPWButtons) {
      _attachPlaneswalkerButtons(wrap, cardInstance, options.onPWAbility);
    }

    return wrap;
  }

  function _getCurrentFaceImage(card) {
    if (card.isDoubleFaced && card.transformed && card.imageUrlBack) {
      return card.imageUrlBack;
    }
    return card.imageUrl || ScryfallAPI.cardBackUrl();
  }

  function transformCard(card, imgEl) {
    card.transformed = !card.transformed;
    imgEl.src = _getCurrentFaceImage(card);
  }

  function _renderCounters(div, card) {
    div.innerHTML = '';
    for (const [type, count] of Object.entries(card.counters || {})) {
      if (count <= 0) continue;
      const badge = document.createElement('div');
      badge.className = 'counter-badge';
      badge.textContent = `${count} ${type}`;
      div.appendChild(badge);
    }
  }

  function _attachPlaneswalkerButtons(wrap, card, onAbility) {
    const oracle = card.oracleText || '';
    const lines = oracle.split('\n').filter(l => l.trim());
    const abilitiesDiv = document.createElement('div');
    abilitiesDiv.className = 'pw-abilities';

    lines.forEach((line, i) => {
      const plusM  = line.match(/^\+(\d+):/);
      const zeroM  = line.match(/^0:/);
      const minusM = line.match(/^−(\d+):/);

      if (plusM || zeroM || minusM) {
        const btn = document.createElement('button');
        btn.className = `pw-ability-btn ${plusM ? 'plus' : zeroM ? 'zero' : 'minus'}`;
        const cost = plusM ? `+${plusM[1]}` : zeroM ? '0' : `−${minusM[1]}`;
        btn.textContent = cost;
        btn.title = line;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (onAbility) onAbility(card, i, cost);
        });
        abilitiesDiv.appendChild(btn);
      }
    });

    if (abilitiesDiv.children.length > 0) {
      wrap.appendChild(abilitiesDiv);
    }
  }

  // ── Phase Tracker ─────────────────────────────────────────
  function renderPhases(phases, currentIndex) {
    const container = document.getElementById('phase-steps');
    container.innerHTML = '';
    phases.forEach((phase, i) => {
      const el = document.createElement('div');
      el.className = `phase-step${i === currentIndex ? ' active' : i < currentIndex ? ' done' : ''}`;
      el.textContent = phase.label;
      el.dataset.index = i;
      container.appendChild(el);
    });
  }

  // ── Player Info ───────────────────────────────────────────
  function updatePlayerInfo(player) {
    const pid = player.id;

    const lifeEl = document.getElementById(`${pid}-life`);
    if (lifeEl) {
      lifeEl.textContent = player.life;
      lifeEl.classList.toggle('critical', player.life <= 10);
    }

    const handCountEl = document.getElementById(`${pid}-hand-count`);
    if (handCountEl) handCountEl.textContent = player.hand.length;

    const libEl = document.getElementById(`${pid}-library-count`);
    if (libEl) libEl.textContent = player.library.length;

    const gyEl = document.getElementById(`${pid}-graveyard-count`);
    if (gyEl) gyEl.textContent = player.graveyard.length;

    const exlEl = document.getElementById(`${pid}-exile-count`);
    if (exlEl) exlEl.textContent = player.exile.length;

    // Commander damage
    const cmdDmgEl = document.getElementById(`${pid}-cmd-damage`);
    if (cmdDmgEl) {
      cmdDmgEl.innerHTML = '';
      for (const [fromId, dmg] of Object.entries(player.commanderDamageReceived || {})) {
        if (dmg === 0) continue;
        const entry = document.createElement('div');
        entry.className = 'cmd-dmg-entry';
        entry.innerHTML = `<span class="cmd-dmg-label">${fromId}</span><span class="cmd-dmg-value${dmg >= 10 ? ' danger' : ''}">${dmg}</span>`;
        cmdDmgEl.appendChild(entry);
      }
    }

    // Eliminated
    const zoneEl = document.getElementById(`zone-${pid}`);
    if (zoneEl) {
      zoneEl.classList.toggle('eliminated', player.eliminated);
    }
  }

  // ── Battlefield ────────────────────────────────────────────
  function renderBattlefield(player, onCardClick, onCardRightClick) {
    const pid = player.id;
    const landsEl    = document.getElementById(`${pid}-lands`);
    const nonlandsEl = document.getElementById(`${pid}-nonlands`);

    if (!landsEl || !nonlandsEl) return;

    landsEl.innerHTML = '';
    nonlandsEl.innerHTML = '';

    for (const card of player.battlefield) {
      const el = createCardElement(card, {
        interactive: player.isHuman,
        showCounters: true,
        showPWButtons: player.isHuman && card.isPlaneswalker,
        onClick: onCardClick,
        onContextMenu: onCardRightClick,
        onPWAbility: (c, i, cost) => _handlePWAbility(c, i, cost),
      });

      if (card.isLand) {
        landsEl.appendChild(el);
      } else {
        nonlandsEl.appendChild(el);
      }
    }
  }

  function _handlePWAbility(card, abilityIndex, cost) {
    // Bubble up to main.js
    document.dispatchEvent(new CustomEvent('pwAbility', {
      detail: { card, abilityIndex, cost }
    }));
  }

  // ── Hand ──────────────────────────────────────────────────
  function renderHand(player, onCardClick) {
    const pid = player.id;

    if (player.isHuman) {
      const handEl = document.getElementById('p1-hand');
      if (!handEl) return;
      handEl.innerHTML = '';

      for (const card of player.hand) {
        const el = createCardElement(card, {
          interactive: true,
          showCounters: false,
          onClick: onCardClick,
        });
        handEl.appendChild(el);
      }
    } else {
      // Bot — show face-down cards
      const displayEl = document.getElementById(`${pid}-hand-display`);
      if (!displayEl) return;
      displayEl.innerHTML = '';
      for (let i = 0; i < player.hand.length; i++) {
        const back = document.createElement('div');
        back.className = 'card-back-mini';
        back.textContent = '⬡';
        displayEl.appendChild(back);
      }
    }
  }

  // ── Command Zone ──────────────────────────────────────────
  function renderCommandZone(player, onCardClick) {
    const el = document.getElementById(`${player.id}-command-zone`);
    if (!el) return;
    el.innerHTML = '';

    for (const card of player.commandZone) {
      const cardEl = createCardElement(card, {
        interactive: player.isHuman,
        showCounters: false,
        onClick: player.isHuman ? onCardClick : null,
      });
      el.appendChild(cardEl);
    }
  }

  // ── Mana Pool ─────────────────────────────────────────────
  function updateManaPool(manaPool) {
    for (const [color, amount] of Object.entries(manaPool)) {
      const el = document.getElementById(`mana-${color}`);
      if (el) {
        el.textContent = `${color}: ${amount}`;
        el.classList.toggle('has-mana', amount > 0);
      }
    }
  }

  // ── Turn / Priority ───────────────────────────────────────
  function updateTurnInfo(state) {
    const activePlayer = GameState.getActivePlayer();
    const el = document.getElementById('turn-active-player');
    if (el) el.textContent = activePlayer.isHuman ? 'Your Turn' : `${activePlayer.name}'s Turn`;

    const turnNumEl = document.getElementById('turn-num');
    if (turnNumEl) turnNumEl.textContent = `Turn ${state.turnNum}`;

    const priEl = document.getElementById('priority-indicator');
    if (priEl) {
      const prioPlayer = GameState.getPlayer(state.priority);
      priEl.textContent = prioPlayer?.isHuman ? 'Priority: You' : `Priority: ${prioPlayer?.name || '?'}`;
    }

    // Show/hide player controls
    const btnPriority = document.getElementById('btn-pass-priority');
    const btnEnd = document.getElementById('btn-end-turn');
    const isPlayerPriority = state.priority === 'p1';
    if (btnPriority) btnPriority.disabled = !isPlayerPriority;
    if (btnEnd) btnEnd.disabled = state.activePlayerIndex !== 0;
  }

  // ── Stack Panel ───────────────────────────────────────────
  function updateStack(stack) {
    const panel = document.getElementById('stack-panel');
    const items = document.getElementById('stack-items');
    if (!panel || !items) return;

    panel.classList.toggle('hidden', stack.length === 0);
    items.innerHTML = '';

    for (let i = stack.length - 1; i >= 0; i--) {
      const item = stack[i];
      const el = document.createElement('div');
      el.className = `stack-item${i === stack.length - 1 ? ' top' : ''}`;
      el.textContent = item.name || item.type;
      items.appendChild(el);
    }
  }

  // ── Zone Overlay ──────────────────────────────────────────
  function showZoneOverlay(title, cards) {
    const overlay = document.getElementById('zone-overlay');
    const titleEl = document.getElementById('zone-overlay-title');
    const cardsEl = document.getElementById('zone-overlay-cards');

    titleEl.textContent = `${title} (${cards.length})`;
    cardsEl.innerHTML = '';

    for (const card of cards) {
      const el = createCardElement(card, { interactive: false });
      cardsEl.appendChild(el);
    }

    overlay.classList.remove('hidden');
  }

  function hideZoneOverlay() {
    document.getElementById('zone-overlay').classList.add('hidden');
  }

  // ── Counter Modal ─────────────────────────────────────────
  let _counterTargetCard = null;

  function showCounterModal(card) {
    _counterTargetCard = card;
    const modal = document.getElementById('counter-modal');
    const list = document.getElementById('counter-list');
    list.innerHTML = '';

    for (const [type, count] of Object.entries(card.counters || {})) {
      if (count <= 0) continue;
      _addCounterRow(list, type, count, card);
    }

    modal.classList.remove('hidden');
  }

  function _addCounterRow(container, type, count, card) {
    const row = document.createElement('div');
    row.className = 'counter-row';
    row.innerHTML = `
      <span class="counter-name">${type}</span>
      <div class="counter-controls">
        <button class="counter-btn" data-action="remove" data-type="${type}">−</button>
        <span class="counter-val" id="cval-${type}">${count}</span>
        <button class="counter-btn" data-action="add" data-type="${type}">+</button>
      </div>
    `;

    row.querySelectorAll('.counter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        const t = btn.dataset.type;
        if (action === 'add') {
          GameState.addCounter(card.instanceId, t, 1);
        } else {
          GameState.removeCounter(card.instanceId, t, 1);
        }
        const valEl = row.querySelector(`#cval-${t}`);
        if (valEl) valEl.textContent = card.counters[t] || 0;
        // Refresh counters on the card
        _refreshCardCounters(card);
      });
    });

    container.appendChild(row);
  }

  function hideCounterModal() {
    document.getElementById('counter-modal').classList.add('hidden');
    _counterTargetCard = null;
  }

  function _refreshCardCounters(card) {
    const wrap = document.querySelector(`[data-instance-id="${card.instanceId}"]`);
    if (!wrap) return;
    let counterDiv = wrap.querySelector('.card-counters');
    if (!counterDiv) {
      counterDiv = document.createElement('div');
      counterDiv.className = 'card-counters';
      wrap.appendChild(counterDiv);
    }
    _renderCounters(counterDiv, card);
  }

  // ── Keyword Modal ─────────────────────────────────────────
  function showKeywordModal(card) {
    const modal = document.getElementById('keyword-modal');
    const title = document.getElementById('keyword-modal-title');
    const body  = document.getElementById('keyword-modal-body');

    const prompt = RulesEngine.getManualKeywordPrompt(card);
    if (!prompt) return;

    title.textContent = `Manual Resolution: ${card.name}`;
    body.innerHTML = prompt.prompts.map(p =>
      `<strong>${p.keyword}:</strong> ${p.description}`
    ).join('<br/><br/>');

    modal.classList.remove('hidden');
  }

  function hideKeywordModal() {
    document.getElementById('keyword-modal').classList.add('hidden');
  }

  // ── Error Overlay ─────────────────────────────────────────
  function showError(message) {
    const overlay = document.getElementById('error-overlay');
    const msg = document.getElementById('error-message');
    if (overlay && msg) {
      msg.textContent = message;
      overlay.classList.remove('hidden');
    }
  }

  function hideError() {
    document.getElementById('error-overlay').classList.add('hidden');
  }

  // ── Loading ───────────────────────────────────────────────
  function updateLoadingProgress(status, progress, detail = '') {
    const statusEl = document.getElementById('loading-status');
    const barEl = document.getElementById('loading-bar');
    const detailEl = document.getElementById('loading-detail');
    if (statusEl) statusEl.textContent = status;
    if (barEl) barEl.style.width = `${Math.round(progress * 100)}%`;
    if (detailEl) detailEl.textContent = detail;
  }

  // ── Validation Panel ──────────────────────────────────────
  function showValidationMessages(errors, warnings, successes) {
    const panel = document.getElementById('validation-panel');
    const msgs  = document.getElementById('validation-messages');
    panel.classList.remove('hidden');
    msgs.innerHTML = '';

    for (const e of errors) {
      const el = document.createElement('div');
      el.className = 'validation-msg error';
      el.textContent = `✗ ${e}`;
      msgs.appendChild(el);
    }
    for (const w of warnings) {
      const el = document.createElement('div');
      el.className = 'validation-msg warning';
      el.textContent = `⚠ ${w}`;
      msgs.appendChild(el);
    }
    for (const s of successes) {
      const el = document.createElement('div');
      el.className = 'validation-msg success';
      el.textContent = `✓ ${s}`;
      msgs.appendChild(el);
    }
  }

  // ── Emblems & Dungeons ────────────────────────────────────
  function renderEmblemsAndDungeons(state) {
    const container = document.getElementById('emblem-list');
    if (!container) return;
    container.innerHTML = '';

    for (const emblem of state.emblems) {
      const el = document.createElement('div');
      el.className = 'counter-badge';
      el.textContent = `${emblem.name} (${emblem.ownerId})`;
      el.title = emblem.text;
      container.appendChild(el);
    }

    for (const dungeon of state.dungeons) {
      const el = document.createElement('div');
      el.className = 'counter-badge';
      el.textContent = `${dungeon.dungeonName}: ${dungeon.rooms[dungeon.currentRoomIndex]}`;
      container.appendChild(el);
    }
  }

  // ── Mulligan Screen ───────────────────────────────────────
  function renderMulliganHand(hand, mulliganCount, onCardClick) {
    const handEl = document.getElementById('mulligan-hand');
    const infoEl = document.getElementById('mulligan-info');
    handEl.innerHTML = '';

    infoEl.textContent = mulliganCount === 0
      ? 'Keep this hand or mulligan?'
      : `Mulligan ${mulliganCount} — select ${mulliganCount} card(s) to put on the bottom.`;

    for (const card of hand) {
      const el = createCardElement(card, {
        interactive: true,
        onClick: onCardClick,
      });
      handEl.appendChild(el);
    }
  }

  // ── Win/Loss Screen ───────────────────────────────────────
  function showResult(isWin, message) {
    const icon  = document.getElementById('result-icon');
    const title = document.getElementById('result-title');
    const sub   = document.getElementById('result-sub');

    if (icon)  icon.className  = `result-icon${isWin ? '' : ' loss'}`;
    if (title) title.textContent = isWin ? 'Victory' : 'Defeated';
    if (sub)   sub.textContent  = message;

    showScreen('result');
  }

  // ── Full Refresh ──────────────────────────────────────────
  /**
   * Redraw the entire game state to the DOM.
   */
  function fullRender(state, callbacks) {
    const { onCardClick, onCardRightClick } = callbacks;

    for (const player of state.players) {
      updatePlayerInfo(player);
      renderBattlefield(player, onCardClick, onCardRightClick);
      renderHand(player, onCardClick);
      renderCommandZone(player, onCardClick);
    }

    const humanPlayer = GameState.getPlayer('p1');
    if (humanPlayer) updateManaPool(humanPlayer.manaPool);

    renderPhases(state.phases, state.phaseIndex);
    updateTurnInfo(state);
    updateStack(state.stack);
    renderEmblemsAndDungeons(state);
  }

  return {
    showScreen,
    setupHoverPreview,
    showCardPreview,
    hideCardPreview,
    createCardElement,
    renderPhases,
    updatePlayerInfo,
    renderBattlefield,
    renderHand,
    renderCommandZone,
    updateManaPool,
    updateTurnInfo,
    updateStack,
    showZoneOverlay,
    hideZoneOverlay,
    showCounterModal,
    hideCounterModal,
    showKeywordModal,
    hideKeywordModal,
    showError,
    hideError,
    updateLoadingProgress,
    showValidationMessages,
    renderEmblemsAndDungeons,
    renderMulliganHand,
    showResult,
    fullRender,
  };
})();
