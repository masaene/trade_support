(() => {
  'use strict';

  const CHART_BG = '#131722';
  const GRID_COLOR = '#1e222d';
  const BORDER_COLOR = '#2a2e39';
  const TEXT_COLOR = '#787b86';
  // Softened (semi-transparent) rather than the fully-saturated brand colors —
  // full-strength fills across every candle body read as too harsh/eye-straining.
  const UP_COLOR = 'rgba(8, 153, 129, 0.75)';
  const DOWN_COLOR = 'rgba(242, 54, 69, 0.75)';
  const SMA_PERIODS = [5, 25, 75, 200];
  const SMA_COLORS = { 5: '#f23645', 25: '#f0b90b', 75: '#089981', 200: '#58a6ff' };

  const el = (id) => document.getElementById(id);
  const symbolInput = el('symbol-input');
  const suggestionsBox = el('symbol-suggestions');
  const priceChartEl = el('price-chart');
  const volumeChartEl = el('volume-chart');
  const legendEl = el('legend');
  const emptyStateEl = el('empty-state');
  const loadingEl = el('loading');
  const statusText = el('status-text');

  let symbols = [];
  let activeSuggestionIndex = -1;
  let currentBars = [];
  let currentCode = null;

  // ---- chart setup ----
  const chartOptions = {
    layout: { background: { color: CHART_BG }, textColor: TEXT_COLOR, attributionLogo: false },
    grid: {
      vertLines: { color: GRID_COLOR },
      horzLines: { color: GRID_COLOR },
    },
    rightPriceScale: { borderColor: BORDER_COLOR },
    timeScale: { borderColor: BORDER_COLOR, timeVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  };

  const priceChart = LightweightCharts.createChart(priceChartEl, {
    ...chartOptions,
    timeScale: { ...chartOptions.timeScale, visible: false },
  });
  const volumeChart = LightweightCharts.createChart(volumeChartEl, chartOptions);

  const candleSeries = priceChart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: UP_COLOR,
    downColor: DOWN_COLOR,
    borderVisible: false,
    wickUpColor: UP_COLOR,
    wickDownColor: DOWN_COLOR,
  });
  const smaSeries = {};
  SMA_PERIODS.forEach((p) => {
    smaSeries[p] = priceChart.addSeries(LightweightCharts.LineSeries, {
      color: SMA_COLORS[p], lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
  });
  const volumeSeries = volumeChart.addSeries(LightweightCharts.HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: '',
  });
  volumeChart.priceScale('').applyOptions({ scaleMargins: { top: 0.2, bottom: 0 } });

  // Keep the two independent chart instances scrolling/zooming together.
  let syncing = false;
  function linkTimeScales(a, b) {
    a.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncing || !range) return;
      syncing = true;
      b.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    });
  }
  linkTimeScales(priceChart, volumeChart);
  linkTimeScales(volumeChart, priceChart);

  function resizeCharts() {
    const pRect = priceChartEl.getBoundingClientRect();
    const vRect = volumeChartEl.getBoundingClientRect();
    priceChart.resize(pRect.width, pRect.height);
    volumeChart.resize(vRect.width, vRect.height);
  }
  new ResizeObserver(resizeCharts).observe(document.querySelector('.chart-stack'));

  // ---- data helpers ----
  function computeSMA(bars, period) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].close;
      if (i >= period) sum -= bars[i - period].close;
      if (i >= period - 1) out.push({ time: bars[i].time, value: sum / period });
    }
    return out;
  }

  function fmt(n, digits = 1) {
    if (n === undefined || n === null || Number.isNaN(n)) return '—';
    return n.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function fmtVolume(n) {
    if (n === undefined || n === null) return '—';
    return Math.round(n).toLocaleString('ja-JP');
  }

  function fmtDate(timeStr) {
    if (!timeStr) return '—';
    const [y, m, d] = timeStr.split('-');
    return `${y}/${m}/${d}`;
  }

  function renderLegend(bar, smaValues) {
    if (!bar) { legendEl.classList.add('hidden'); return; }
    const dir = bar.close >= bar.open ? 'l-up' : 'l-down';
    let html = `<span class="l-date">${fmtDate(bar.time)}</span>` +
      `<span class="l-o">O <b class="${dir}">${fmt(bar.open)}</b></span>` +
      `<span class="l-h">H <b class="${dir}">${fmt(bar.high)}</b></span>` +
      `<span class="l-l">L <b class="${dir}">${fmt(bar.low)}</b></span>` +
      `<span class="l-c">C <b class="${dir}">${fmt(bar.close)}</b></span>` +
      `<span class="l-v">Vol <b>${fmtVolume(bar.volume)}</b></span>`;
    SMA_PERIODS.forEach((p) => {
      if (smaValues[p] !== undefined) {
        html += `<span class="l-sma${p}">SMA${p} ${fmt(smaValues[p])}</span>`;
      }
    });
    legendEl.innerHTML = html;
    legendEl.classList.remove('hidden');
  }

  function barAtTime(time) {
    return currentBars.find((b) => b.time === time);
  }

  const smaCache = {};
  SMA_PERIODS.forEach((p) => { smaCache[p] = []; });
  function smaValueAtTime(period, time) {
    const point = smaCache[period].find((p) => p.time === time);
    return point ? point.value : undefined;
  }

  function smaValuesAtTime(time) {
    const values = {};
    SMA_PERIODS.forEach((p) => { values[p] = smaValueAtTime(p, time); });
    return values;
  }

  priceChart.subscribeCrosshairMove((param) => {
    if (!currentBars.length) return;
    if (!param || !param.time) {
      const last = currentBars[currentBars.length - 1];
      renderLegend(last, smaValuesAtTime(last.time));
      return;
    }
    renderLegend(barAtTime(param.time), smaValuesAtTime(param.time));
  });

  // ---- symbol header ----
  function updateSymbolHeader(info, bars) {
    el('info-code').textContent = info.code;
    el('info-name').textContent = info.name;
    el('info-market').textContent = info.market || '';
    el('info-sector').textContent = info.sector || '';

    const last = bars[bars.length - 1];
    const prev = bars.length > 1 ? bars[bars.length - 2] : null;
    el('info-close').textContent = fmt(last.close);
    const changeEl = el('info-change');
    if (prev) {
      const diff = last.close - prev.close;
      const pct = (diff / prev.close) * 100;
      const sign = diff >= 0 ? '+' : '';
      changeEl.textContent = `${sign}${fmt(diff)} (${sign}${fmt(pct, 2)}%)`;
      changeEl.className = 'change ' + (diff >= 0 ? 'up' : 'down');
    } else {
      changeEl.textContent = '';
    }
  }

  // ---- main render ----
  async function selectSymbol(code) {
    disarmPicking();
    closeLotConfirm();
    loadingEl.classList.remove('hidden');
    try {
      const res = await fetch(`/api/bars/${code}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      currentCode = code;
      currentBars = data.bars;

      candleSeries.setData(currentBars.map((b) => ({
        time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
      })));
      volumeSeries.setData(currentBars.map((b) => ({
        time: b.time,
        value: b.volume,
        color: b.close >= b.open ? 'rgba(8,153,129,0.6)' : 'rgba(242,54,69,0.6)',
      })));

      SMA_PERIODS.forEach((p) => {
        smaCache[p] = computeSMA(currentBars, p);
        smaSeries[p].setData(smaCache[p]);
      });

      updateSymbolHeader(data, currentBars);
      const last = currentBars[currentBars.length - 1];
      renderLegend(last, smaValuesAtTime(last.time));

      emptyStateEl.classList.add('hidden');
      priceChart.timeScale().fitContent();
      volumeChart.timeScale().fitContent();
      statusText.textContent = `${data.code} ${data.name} — ${currentBars.length}件の日足データ`;
      await loadPositions(code);
    } catch (err) {
      statusText.textContent = `データの取得に失敗しました: ${err.message}`;
    } finally {
      loadingEl.classList.add('hidden');
    }
  }

  // ---- search / suggestions ----
  function matchSymbols(query) {
    const q = query.trim().toLowerCase();
    if (!q) return symbols.slice(0, 30);
    return symbols
      .filter((s) => s.code.startsWith(q) || s.name.toLowerCase().includes(q) || (s.nameEn && s.nameEn.toLowerCase().includes(q)))
      .slice(0, 30);
  }

  function renderSuggestions(list) {
    activeSuggestionIndex = -1;
    if (!list.length) {
      suggestionsBox.innerHTML = '<div class="no-match">一致する銘柄がありません</div>';
      suggestionsBox.classList.remove('hidden');
      return;
    }
    suggestionsBox.innerHTML = list.map((s) => {
      const summary = symbolPnLSummary(s);
      let holdingHtml = '';
      if (summary) {
        const dir = summary.pnl > 0 ? 'up' : summary.pnl < 0 ? 'down' : null;
        const sign = summary.pnl > 0 ? '+' : '';
        holdingHtml = `<span class="s-holding${dir ? ` s-holding--${dir}` : ''}">保有中 ${sign}${fmt(summary.pnl, 0)}円</span>`;
      }
      return `<div class="suggestion-item" data-code="${s.code}">` +
        `<span class="s-code">${s.code}</span>` +
        `<span class="s-name">${s.name}</span>` +
        holdingHtml +
        `<span class="s-meta">${s.market || ''}</span>` +
      `</div>`;
    }).join('');
    suggestionsBox.classList.remove('hidden');
  }

  function openSuggestions() { renderSuggestions(matchSymbols(symbolInput.value)); }
  function showAllSuggestions() { renderSuggestions(matchSymbols('')); }
  function closeSuggestions() { suggestionsBox.classList.add('hidden'); }

  symbolInput.addEventListener('input', openSuggestions);
  // Always show the full list on focus, regardless of leftover text from a
  // previous selection, and select that text so typing immediately replaces
  // it — otherwise re-opening the dropdown after a selection required first
  // manually clearing the "1605 ＩＮＰＥＸ"-style text already in the box.
  symbolInput.addEventListener('focus', () => {
    symbolInput.select();
    showAllSuggestions();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) closeSuggestions();
  });

  suggestionsBox.addEventListener('click', (e) => {
    const item = e.target.closest('.suggestion-item');
    if (!item) return;
    chooseSymbol(item.dataset.code);
  });

  function chooseSymbol(code) {
    const info = symbols.find((s) => s.code === code);
    symbolInput.value = info ? `${info.code} ${info.name}` : code;
    closeSuggestions();
    selectSymbol(code);
  }

  symbolInput.addEventListener('keydown', (e) => {
    const items = suggestionsBox.querySelectorAll('.suggestion-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = activeSuggestionIndex >= 0 ? items[activeSuggestionIndex] : items[0];
      if (target) chooseSymbol(target.dataset.code);
      return;
    } else if (e.key === 'Escape') {
      closeSuggestions();
      return;
    } else {
      return;
    }
    items.forEach((it, i) => it.classList.toggle('active', i === activeSuggestionIndex));
    items[activeSuggestionIndex].scrollIntoView({ block: 'nearest' });
  });

  // ---- screen navigation (sidebar on desktop, bottom nav on mobile) ----
  function selectScreen(screenId) {
    document.querySelectorAll('.screen').forEach((s) => {
      s.classList.toggle('active', s.id === `screen-${screenId}`);
    });
    document.querySelectorAll('.nav-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.screen === screenId);
    });
    if (screenId === 'chart') {
      // the chart panes were sized 0x0 while their screen was display:none;
      // force a resize now instead of waiting on the next observer tick.
      resizeCharts();
    }
  }

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectScreen(btn.dataset.screen));
  });

  // ---- positions panel (建玉) ----
  const positionsAggEl = el('positions-agg');
  const positionsListEl = el('positions-list');
  const positionsEmptyEl = el('positions-empty');
  const positionsPanelEl = el('positions-panel');
  const addLotBtn = el('add-lot-btn');
  const positionsCollapseBtn = el('positions-collapse-btn');
  const pickBannerEl = el('pick-banner');
  const pickBannerTextEl = el('pick-banner-text');
  const pickBannerCancelBtn = el('pick-banner-cancel');
  const lotConfirmEl = el('lot-confirm');
  const lotConfirmContextEl = el('lot-confirm-context');
  const lotConfirmPriceEl = el('lot-confirm-price');
  const lotConfirmQtyRow = el('lot-confirm-qty-row');
  const lotConfirmQtyInput = el('lot-confirm-qty');
  const lotConfirmDateLabel = el('lot-confirm-date-label');
  const lotConfirmDateInput = el('lot-confirm-date');
  const lotConfirmSubmitBtn = el('lot-confirm-submit');

  let positions = [];
  let pickMode = null; // null | {kind:'add'} | {kind:'settle', lotId}
  let pendingPick = null; // {kind, lotId, price} once a price has been captured, awaiting form submit

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function pnlArrowSvg(direction) {
    return `<svg class="pnl-arrow pnl-arrow--${direction}"><use href="#icon-arrow-${direction}"/></svg>`;
  }

  async function loadPositions(code) {
    try {
      const res = await fetch(`/api/positions/${code}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      positions = data.lots || [];
    } catch {
      positions = [];
    }
    renderPositions();
    loadAllPositionsSummary(); // keep the symbol dropdown's 保有中 badges in sync too
  }

  // Across all symbols, for the 保有中 badge in the symbol dropdown.
  let allPositionsByCode = {};

  async function loadAllPositionsSummary() {
    try {
      const res = await fetch('/api/positions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allPositionsByCode = data.positions || {};
    } catch {
      allPositionsByCode = {};
    }
  }

  // exitPrice: the sell price for a settled lot (realized), or the current
  // market price for an open lot (unrealized) — combined into one P&L figure.
  function computeLotPnL(lot, currentClose) {
    const exitPrice = lot.settled ? lot.sellPrice : currentClose;
    const pnl = (exitPrice - lot.buyPrice) * lot.quantity;
    const cost = lot.buyPrice * lot.quantity;
    return { pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : 0 };
  }

  function computeLotsSummary(lots, currentClose) {
    let pnl = 0;
    let cost = 0;
    lots.forEach((lot) => {
      pnl += computeLotPnL(lot, currentClose).pnl;
      cost += lot.buyPrice * lot.quantity;
    });
    return { pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : 0 };
  }

  function computeAggregate(currentClose) {
    return computeLotsSummary(positions, currentClose);
  }

  // 保有中(未決済)の建玉だけを対象にした評価損益。銘柄ドロップダウンの「保有有無」表示専用
  // (建玉パネル本体の合計損益とは異なり、決済済み分の実現損益はここには含めない)。
  function symbolPnLSummary(sym) {
    const openLots = (allPositionsByCode[sym.code] || []).filter((l) => !l.settled);
    if (!openLots.length || sym.lastClose === null || sym.lastClose === undefined) return null;
    return computeLotsSummary(openLots, sym.lastClose);
  }

  function renderLotCard(lot, currentClose) {
    const { pnl, pnlPct } = computeLotPnL(lot, currentClose);
    const dir = pnl > 0 ? 'profit' : pnl < 0 ? 'loss' : null;
    const armed = pickMode && pickMode.kind === 'settle' && pickMode.lotId === lot.id;
    const sign = pnl > 0 ? '+' : '';
    const deleteBtn = `<button type="button" class="lot-swipe-delete-btn" data-lot-id="${lot.id}"><svg><use href="#icon-trash"/></svg>削除</button>`;
    return `
      <div class="lot-card-swipe" data-lot-id="${lot.id}">
        <div class="lot-card-delete-zone lot-card-delete-zone--left">${deleteBtn}</div>
        <div class="lot-card-delete-zone lot-card-delete-zone--right">${deleteBtn}</div>
        <div class="lot-card${dir ? ` lot-card--${dir}` : ''}${armed ? ' lot-card--armed' : ''}" data-lot-id="${lot.id}">
          <div class="lot-card__main">
            <span class="lot-card__price">${fmt(lot.buyPrice)}円 <span style="color:var(--text-muted);font-weight:400;">× ${lot.quantity.toLocaleString('ja-JP')}株</span></span>
            <span class="lot-card__meta">${fmtDate(lot.buyDate)}${lot.settled ? ` → ${fmtDate(lot.sellDate)} @ ${fmt(lot.sellPrice)}円` : ''}</span>
          </div>
          ${lot.settled ? '<span class="lot-badge-settled">決済済み</span>' : ''}
          <div class="lot-card__pnl${dir ? ` pnl-${dir}` : ''}">
            ${dir ? pnlArrowSvg(dir === 'profit' ? 'up' : 'down') : ''}
            <span>${sign}${fmt(pnl, 0)}円 (${sign}${fmt(pnlPct, 1)}%)</span>
          </div>
          <div class="lot-card__actions">
            ${lot.settled ? '' : `<button type="button" class="lot-settle-btn${armed ? ' armed' : ''}" data-lot-id="${lot.id}">${armed ? 'キャンセル' : '決済'}</button>`}
          </div>
        </div>
      </div>`;
  }

  function renderPositions() {
    // any in-progress/open swipe gesture references DOM nodes about to be replaced
    activeSwipe = null;
    openSwipeCard = null;
    const currentClose = currentBars.length ? currentBars[currentBars.length - 1].close : null;
    if (!positions.length) {
      positionsListEl.innerHTML = '';
      positionsEmptyEl.classList.remove('hidden');
    } else {
      positionsEmptyEl.classList.add('hidden');
      positionsListEl.innerHTML = positions
        .slice()
        .sort((a, b) => (a.buyDate < b.buyDate ? 1 : a.buyDate > b.buyDate ? -1 : 0))
        .map((lot) => renderLotCard(lot, currentClose))
        .join('');
    }

    if (!positions.length || currentClose === null) {
      positionsAggEl.className = 'positions-agg positions-agg--flat';
      positionsAggEl.innerHTML = positions.length ? '評価中...' : '建玉なし';
      return;
    }
    const { pnl, pnlPct } = computeAggregate(currentClose);
    const dir = pnl > 0 ? 'profit' : pnl < 0 ? 'loss' : 'flat';
    const sign = pnl > 0 ? '+' : '';
    positionsAggEl.className = `positions-agg positions-agg--${dir}`;
    const arrow = dir !== 'flat' ? pnlArrowSvg(dir === 'profit' ? 'up' : 'down') : '';
    positionsAggEl.innerHTML = `${arrow}<span>合計 ${sign}${fmt(pnl, 0)}円 (${sign}${fmt(pnlPct, 1)}%)</span>`;
  }

  // ---- click-to-pick-price interaction ----
  function updatePickModeUI() {
    priceChartEl.classList.toggle('picking', !!pickMode);
    if (!pickMode) {
      pickBannerEl.classList.add('hidden');
    } else if (pickMode.kind === 'add') {
      pickBannerTextEl.textContent = 'チャートをクリックして買値を指定してください(Escでキャンセル)';
      pickBannerEl.classList.remove('hidden');
    } else {
      const lot = positions.find((l) => l.id === pickMode.lotId);
      pickBannerTextEl.textContent = lot
        ? `《買値${fmt(lot.buyPrice)}円・${lot.quantity}株》の決済価格をチャートでクリックして指定してください(Escでキャンセル)`
        : '決済価格をチャートでクリックして指定してください(Escでキャンセル)';
      pickBannerEl.classList.remove('hidden');
    }
    addLotBtn.classList.toggle('armed', !!pickMode && pickMode.kind === 'add');
    renderPositions(); // refreshes the armed highlight on the relevant lot's settle button
  }

  function armAddLotPicking() {
    if (pickMode && pickMode.kind === 'add') { disarmPicking(); return; }
    pickMode = { kind: 'add' };
    closeLotConfirm();
    updatePickModeUI();
  }

  function armSettlePicking(lotId) {
    if (pickMode && pickMode.kind === 'settle' && pickMode.lotId === lotId) { disarmPicking(); return; }
    pickMode = { kind: 'settle', lotId };
    closeLotConfirm();
    updatePickModeUI();
  }

  function disarmPicking() {
    if (!pickMode) return;
    pickMode = null;
    updatePickModeUI();
  }

  function openLotConfirm(mode, price, lotId) {
    pendingPick = { kind: mode, lotId, price };
    lotConfirmPriceEl.textContent = `${fmt(price)}円`;
    lotConfirmDateInput.value = todayStr();
    if (mode === 'add') {
      lotConfirmContextEl.textContent = '新規建玉を追加します。';
      lotConfirmQtyRow.style.display = '';
      lotConfirmDateLabel.firstChild.textContent = '購入日';
      lotConfirmSubmitBtn.textContent = '追加';
    } else {
      const lot = positions.find((l) => l.id === lotId);
      lotConfirmContextEl.textContent = lot
        ? `《買値${fmt(lot.buyPrice)}円・${lot.quantity}株・${fmtDate(lot.buyDate)}》を決済します。`
        : '建玉を決済します。';
      lotConfirmQtyRow.style.display = 'none';
      lotConfirmDateLabel.firstChild.textContent = '決済日';
      lotConfirmSubmitBtn.textContent = '決済確定';
    }
    lotConfirmEl.classList.remove('hidden');
  }

  function closeLotConfirm() {
    pendingPick = null;
    lotConfirmEl.classList.add('hidden');
  }

  priceChart.subscribeClick((param) => {
    if (!pickMode || !param.point) return;
    const price = candleSeries.coordinateToPrice(param.point.y);
    if (price === null) return;
    const { kind, lotId } = pickMode;
    disarmPicking();
    openLotConfirm(kind, price, lotId);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pickMode) disarmPicking();
  });

  // ---- CRUD ----
  async function submitAddLot({ buyPrice, buyDate, quantity }) {
    const res = await fetch(`/api/positions/${currentCode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyPrice, buyDate, quantity }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await loadPositions(currentCode);
  }

  async function submitSettleLot(lotId, { sellPrice, sellDate }) {
    const res = await fetch(`/api/positions/${currentCode}/${lotId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sellPrice, sellDate }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await loadPositions(currentCode);
  }

  async function deleteLot(lotId) {
    if (!window.confirm('この建玉を削除しますか？')) return;
    if (pickMode && pickMode.lotId === lotId) disarmPicking();
    try {
      const res = await fetch(`/api/positions/${currentCode}/${lotId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadPositions(currentCode);
      statusText.textContent = '建玉を削除しました';
    } catch (err) {
      statusText.textContent = `削除に失敗しました: ${err.message}`;
    }
  }

  // ---- positions panel wiring ----
  addLotBtn.addEventListener('click', armAddLotPicking);
  pickBannerCancelBtn.addEventListener('click', disarmPicking);
  el('lot-confirm-repick').addEventListener('click', () => {
    if (!pendingPick) return;
    if (pendingPick.kind === 'add') armAddLotPicking();
    else armSettlePicking(pendingPick.lotId);
  });
  el('lot-confirm-cancel').addEventListener('click', closeLotConfirm);

  lotConfirmEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pendingPick) return;
    const { kind, lotId, price } = pendingPick;
    const date = lotConfirmDateInput.value || todayStr();
    lotConfirmSubmitBtn.disabled = true;
    try {
      if (kind === 'add') {
        const quantity = Number(lotConfirmQtyInput.value);
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('数量を入力してください');
        await submitAddLot({ buyPrice: price, buyDate: date, quantity });
        statusText.textContent = '建玉を追加しました';
      } else {
        await submitSettleLot(lotId, { sellPrice: price, sellDate: date });
        statusText.textContent = '決済しました';
      }
      closeLotConfirm();
    } catch (err) {
      statusText.textContent = `保存に失敗しました: ${err.message}`;
    } finally {
      lotConfirmSubmitBtn.disabled = false;
    }
  });

  positionsListEl.addEventListener('click', (e) => {
    const settleBtn = e.target.closest('.lot-settle-btn');
    if (settleBtn) { armSettlePicking(settleBtn.dataset.lotId); return; }
    const delBtn = e.target.closest('.lot-swipe-delete-btn');
    if (delBtn) deleteLot(delBtn.dataset.lotId);
  });

  positionsCollapseBtn.addEventListener('click', () => {
    positionsPanelEl.classList.toggle('collapsed');
    resizeCharts();
  });

  // ---- swipe-to-delete on lot cards ----
  const SWIPE_REVEAL_PX = 84; // matches .lot-card-delete-zone width in style.css
  const SWIPE_OPEN_THRESHOLD = 40;
  let activeSwipe = null; // { cardEl, startX, startY, dx, axis }
  let openSwipeCard = null; // the currently-revealed card element, if any

  function closeSwipeCard(cardEl) {
    if (!cardEl) return;
    cardEl.style.transition = 'transform 0.2s ease';
    cardEl.style.transform = 'translateX(0)';
    if (openSwipeCard === cardEl) openSwipeCard = null;
  }

  function openSwipeCardTo(cardEl, direction) {
    cardEl.style.transition = 'transform 0.2s ease';
    cardEl.style.transform = `translateX(${direction * SWIPE_REVEAL_PX}px)`;
    openSwipeCard = cardEl;
  }

  positionsListEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.lot-settle-btn, .lot-swipe-delete-btn')) return;
    const cardEl = e.target.closest('.lot-card');
    if (!cardEl) return;
    if (openSwipeCard && openSwipeCard !== cardEl) closeSwipeCard(openSwipeCard);
    if (openSwipeCard === cardEl) {
      closeSwipeCard(cardEl); // tapping an already-open card closes it
      return;
    }
    cardEl.style.transition = 'none';
    activeSwipe = { cardEl, startX: e.clientX, startY: e.clientY, dx: 0, axis: null };
  });

  window.addEventListener('pointermove', (e) => {
    if (!activeSwipe) return;
    const dx = e.clientX - activeSwipe.startX;
    const dy = e.clientY - activeSwipe.startY;
    if (activeSwipe.axis === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // too small yet to tell intent
      activeSwipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (activeSwipe.axis === 'x') activeSwipe.cardEl.setPointerCapture(e.pointerId);
    }
    if (activeSwipe.axis !== 'x') return; // vertical drag: let the list scroll normally
    e.preventDefault();
    const clamped = Math.max(-SWIPE_REVEAL_PX, Math.min(SWIPE_REVEAL_PX, dx));
    activeSwipe.dx = clamped;
    activeSwipe.cardEl.style.transform = `translateX(${clamped}px)`;
  }, { passive: false });

  function endSwipeDrag() {
    if (!activeSwipe) return;
    const { cardEl, dx, axis } = activeSwipe;
    if (axis === 'x') {
      if (dx > SWIPE_OPEN_THRESHOLD) openSwipeCardTo(cardEl, 1);
      else if (dx < -SWIPE_OPEN_THRESHOLD) openSwipeCardTo(cardEl, -1);
      else closeSwipeCard(cardEl);
    }
    activeSwipe = null;
  }
  window.addEventListener('pointerup', endSwipeDrag);
  window.addEventListener('pointercancel', endSwipeDrag);

  // tapping/clicking anywhere outside a card also dismisses an open swipe
  document.addEventListener('pointerdown', (e) => {
    if (openSwipeCard && !e.target.closest('.lot-card-swipe')) closeSwipeCard(openSwipeCard);
  });

  // ---- init ----
  async function init() {
    try {
      const res = await fetch('/api/symbols');
      symbols = await res.json();
      await loadAllPositionsSummary();
      statusText.textContent = `${symbols.length}銘柄を読み込みました`;
      if (symbols.length === 1) {
        chooseSymbol(symbols[0].code);
      }
    } catch (err) {
      statusText.textContent = `銘柄一覧の取得に失敗しました: ${err.message}`;
    }
    resizeCharts();
  }

  init();
})();
