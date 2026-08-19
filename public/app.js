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
    if (screenId === 'analysis') {
      if (!analysisInitialized) {
        // first visit only: default to whatever symbol is already selected on
        // the chart screen, as a convenience — never overrides a later choice
        // made on the analysis screen itself. This already fetches fresh data,
        // so no separate refresh is needed on this branch.
        analysisInitialized = true;
        if (currentCode) {
          analysisSelectEl.value = currentCode;
          onAnalysisSymbolChange(currentCode);
        }
      } else {
        // every subsequent visit: pick up any add/settle/delete made on the
        // chart screen (or elsewhere) since this screen was last shown.
        refreshAnalysisLots();
      }
    }
    if (screenId === 'stats') {
      // the stats chart pane was sized 0x0 while its screen was display:none;
      // force a resize now instead of waiting on the next observer tick.
      resizeStatsCharts();
      if (!statsInitialized) {
        statsInitialized = true;
        if (currentCode) {
          statsSelectEl.value = currentCode;
          onStatsSymbolChange(currentCode);
        }
      }
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

  const waterfallChartEl = el('waterfall-chart');
  const waterfallTotalEl = el('waterfall-total');
  const waterfallEmptyEl = el('waterfall-empty');

  let positions = [];
  let pickMode = null; // null | {kind:'add'} | {kind:'settle', lotId}
  let pendingPick = null; // {kind, lotId, price} once a price has been captured, awaiting form submit
  let lotOverlaySeries = []; // per-lot buy→current(or→sell) line series drawn on the price chart

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
          <span class="lot-card__seq">#${lot.seq ?? '—'}</span>
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

    renderWaterfall(currentClose);
    renderLotOverlays();

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

  // ---- waterfall panel: per-lot P&L for the selected symbol, in the order
  // lots were added (#seq), building up to a final NET column ----
  function renderWaterfall(currentClose) {
    if (!positions.length || currentClose === null || currentClose === undefined) {
      waterfallChartEl.innerHTML = '';
      waterfallEmptyEl.classList.toggle('hidden', !positions.length);
      waterfallTotalEl.className = 'positions-agg positions-agg--flat';
      waterfallTotalEl.innerHTML = positions.length ? '評価中...' : '建玉なし';
      return;
    }
    waterfallEmptyEl.classList.add('hidden');

    const lots = positions.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
    let cum = 0;
    const steps = lots.map((lot) => {
      const { pnl } = computeLotPnL(lot, currentClose);
      const from = cum;
      cum += pnl;
      return { lot, pnl, from, to: cum };
    });
    const net = cum;

    // Scale every bar (including the 0 baseline and the final NET bar)
    // against one shared min/max so heights are directly comparable.
    const values = [0, net];
    steps.forEach((s) => values.push(s.from, s.to));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    // Bars are scaled into a sub-range, not the full 0-100%, so the value
    // label sitting above the tallest bar's top always has headroom instead
    // of being clipped by the panel's edge; a little room is kept at the
    // bottom too so the shortest bar isn't flush against the panel edge.
    const TOP_HEADROOM = 18;
    const BOTTOM_HEADROOM = 4;
    const pct = (v) => BOTTOM_HEADROOM + ((v - min) / range) * (100 - TOP_HEADROOM - BOTTOM_HEADROOM);

    function barHtml(from, to, pnl, dir, labelHtml) {
      const bottom = pct(Math.min(from, to));
      const height = Math.abs(pct(to) - pct(from));
      const valueBottom = pct(Math.max(from, to)) + 3;
      const sign = pnl > 0 ? '+' : '';
      return `
        <div class="wf-col${dir === 'net' ? ' is-net' : ''}">
          <div class="wf-bar ${dir}" style="bottom:${bottom}%;height:${height}%;"></div>
          <div class="wf-value ${dir === 'net' ? 'net' : (pnl >= 0 ? 'up' : 'down')}" style="bottom:${valueBottom}%;">${sign}${fmt(pnl, 0)}</div>
          <div class="wf-label">${labelHtml}</div>
        </div>`;
    }

    const colsHtml = steps.map((s) =>
      barHtml(s.from, s.to, s.pnl, s.pnl >= 0 ? 'up' : 'down', `#${s.lot.seq ?? '—'}`)
    ).join('') + barHtml(0, net, net, 'net', '合計');

    waterfallChartEl.innerHTML = `<div class="wf-zero" style="bottom:${pct(0)}%;"></div>${colsHtml}`;

    const dir = net > 0 ? 'profit' : net < 0 ? 'loss' : 'flat';
    const sign = net > 0 ? '+' : '';
    waterfallTotalEl.className = `positions-agg positions-agg--${dir}`;
    const arrow = dir !== 'flat' ? pnlArrowSvg(dir === 'profit' ? 'up' : 'down') : '';
    waterfallTotalEl.innerHTML = `${arrow}<span>合計 ${sign}${fmt(net, 0)}円</span>`;
  }

  // ---- per-lot overlay on the price chart: a line from the buy point to
  // the current price (or, for a settled lot, to the sell point), labeled
  // with the lot's #ID ----

  // A lot's buy/sell date may fall on a non-trading day (weekend, or simply
  // hand-edited in the date field), so anchor it to the closest bar that
  // actually exists — otherwise it wouldn't land on the shared time scale.
  function nearestBarTime(dateStr) {
    if (!currentBars.length) return dateStr;
    const target = new Date(dateStr).getTime();
    let best = currentBars[0].time;
    let bestDiff = Infinity;
    for (const b of currentBars) {
      const diff = Math.abs(new Date(b.time).getTime() - target);
      if (diff < bestDiff) { bestDiff = diff; best = b.time; }
    }
    return best;
  }

  function clearLotOverlays() {
    lotOverlaySeries.forEach((s) => {
      try { priceChart.removeSeries(s); } catch { /* already gone */ }
    });
    lotOverlaySeries = [];
  }

  function renderLotOverlays() {
    clearLotOverlays();
    if (!currentBars.length || !positions.length) return;
    const lastBar = currentBars[currentBars.length - 1];

    positions.forEach((lot) => {
      const buyTime = nearestBarTime(lot.buyDate);
      let endTime, endValue, profit;
      if (lot.settled) {
        endTime = nearestBarTime(lot.sellDate);
        endValue = lot.sellPrice;
        profit = lot.sellPrice - lot.buyPrice;
      } else {
        endTime = lastBar.time;
        endValue = lastBar.close;
        profit = lastBar.close - lot.buyPrice;
      }
      // A same-day (or snapped-to-the-same-bar) lot would collapse to a
      // single point, which the series can't draw as a line.
      if (buyTime === endTime) return;

      // A thicker line reads more easily than a hairline, but at full
      // opacity that same thickness would compete with the candles/SMAs —
      // so the width goes up while the opacity comes down to compensate.
      const alpha = lot.settled ? 0.32 : 0.42;
      const isUp = profit >= 0;
      const color = isUp ? `rgba(8, 153, 129, ${alpha})` : `rgba(242, 54, 69, ${alpha})`;
      const series = priceChart.addSeries(LightweightCharts.LineSeries, {
        color,
        lineWidth: 3,
        lineStyle: lot.settled ? LightweightCharts.LineStyle.Dotted : LightweightCharts.LineStyle.Dashed,
        pointMarkersVisible: true,
        pointMarkersRadius: 3,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData([
        { time: buyTime, value: lot.buyPrice },
        { time: endTime, value: endValue },
      ]);
      lotOverlaySeries.push(series);

      // The line itself stays translucent, so the lot's #ID label is drawn
      // at full opacity right next to its starting point to stay readable.
      LightweightCharts.createSeriesMarkers(series, [{
        time: buyTime,
        position: 'aboveBar',
        color: isUp ? UP_COLOR : DOWN_COLOR,
        shape: 'circle',
        size: 0.6,
        text: `#${lot.seq ?? '—'}`,
      }]);
    });
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

  function openLotConfirm(mode, price, lotId, time) {
    pendingPick = { kind: mode, lotId, price };
    lotConfirmPriceEl.textContent = `${fmt(price)}円`;
    // Use the date of the bar that was clicked, not today's date — the whole
    // point of picking a price on the chart is to backdate past trades.
    lotConfirmDateInput.value = time || todayStr();
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

  // Clicking off the candle's body (above or below the open/close range)
  // clamps the picked price to the nearer body edge, rather than taking the
  // raw pixel position literally — otherwise a stray click far from the
  // candle would record an implausible price.
  function clampToBody(price, bar) {
    if (!bar) return price;
    const lower = Math.min(bar.open, bar.close);
    const upper = Math.max(bar.open, bar.close);
    if (price < lower) return lower;
    if (price > upper) return upper;
    return price;
  }

  priceChart.subscribeClick((param) => {
    if (!pickMode || !param.point) return;
    const rawPrice = candleSeries.coordinateToPrice(param.point.y);
    if (rawPrice === null) return;
    const price = clampToBody(rawPrice, param.time ? barAtTime(param.time) : null);
    const { kind, lotId } = pickMode;
    disarmPicking();
    openLotConfirm(kind, price, lotId, param.time);
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

  // ---- analysis screen (分析): symbol pulldown + read-only lot list, a
  // price-prediction slider that re-evaluates every open lot's P&L in real
  // time, and the aggregate breakeven price. Entirely separate state from
  // the chart screen's currentCode/currentBars/positions — never touches it. ----
  const analysisSelectEl = el('analysis-symbol-select');
  const analysisInfoCodeEl = el('analysis-info-code');
  const analysisInfoNameEl = el('analysis-info-name');
  const analysisEmptyEl = el('analysis-empty');
  const analysisContentEl = el('analysis-content');
  const analysisPriceSliderEl = el('analysis-price-slider');
  const analysisPriceValueEl = el('analysis-price-value');
  const analysisBreakevenMarkerEl = el('analysis-breakeven-marker');
  const analysisSmaMarkersEl = el('analysis-sma-markers');
  const analysisSmaLegendEl = el('analysis-sma-legend');
  const analysisCurrentMarkerEl = el('analysis-current-marker');
  const analysisSliderMinEl = el('analysis-slider-min');
  const analysisSliderMaxEl = el('analysis-slider-max');
  const analysisBreakevenCardEl = el('analysis-breakeven-card');
  const analysisBreakevenLabelEl = el('analysis-breakeven-label');
  const analysisBreakevenValueEl = el('analysis-breakeven-value');
  const analysisBreakevenJumpBtn = el('analysis-breakeven-jump');
  const analysisJumpCurrentBtn = el('analysis-jump-current');
  const analysisAggEl = el('analysis-agg');
  const analysisLotsListEl = el('analysis-lots-list');
  const analysisLotsEmptyEl = el('analysis-lots-empty');
  const analysisLockedProfitEl = el('analysis-locked-profit');
  const analysisSimResetBtn = el('analysis-sim-reset');

  let analysisCode = null;
  let analysisBars = [];
  let analysisLots = [];
  let analysisRange = null; // { min, max, defaultPrice }
  let analysisInitialized = false; // guards the one-time default-symbol behavior
  let analysisSimSettledIds = new Set(); // lot ids checked as "settle now" in the partial-settlement simulator

  function populateAnalysisSymbolSelect() {
    const options = symbols.map((s) => `<option value="${s.code}">${s.code} ${s.name}</option>`).join('');
    analysisSelectEl.insertAdjacentHTML('beforeend', options);
  }

  // The slider's bounds are exactly the chart's historical low/high, so a
  // marker's position on the track is directly comparable to where it sits
  // on the price chart itself.
  function computeAnalysisSliderRange(bars) {
    if (!bars.length) return { min: 0, max: 1000, defaultPrice: 500 };
    let lo = Math.min(...bars.map((b) => b.low));
    let hi = Math.max(...bars.map((b) => b.high));
    // degenerate range (e.g. a single bar) — force a visible band instead of a zero-width slider
    if (hi - lo < hi * 0.001) {
      const pad = Math.max(hi * 0.05, 1);
      lo -= pad;
      hi += pad;
    }
    return { min: Math.max(0, lo), max: hi, defaultPrice: bars[bars.length - 1].close };
  }

  // Latest value of each SMA period, for marking where the predicted price
  // sits relative to the moving averages — reuses the same computeSMA used
  // for the chart's own SMA lines, just evaluated for the analysis screen's
  // independently-loaded bars.
  function latestAnalysisSmaValues(bars) {
    return SMA_PERIODS.map((period) => {
      const series = computeSMA(bars, period);
      return { period, value: series.length ? series[series.length - 1].value : null };
    });
  }

  function priceToPct(price, range) {
    return Math.max(0, Math.min(100, ((price - range.min) / (range.max - range.min || 1)) * 100));
  }

  function renderAnalysisSmaMarkers(bars, range) {
    const values = latestAnalysisSmaValues(bars);
    analysisSmaMarkersEl.innerHTML = values
      .filter((v) => v.value !== null)
      .map((v) => {
        const pct = priceToPct(v.value, range);
        return `<svg class="analysis-sma-marker" style="left:${pct}%;color:${SMA_COLORS[v.period]};" title="SMA${v.period} ${fmt(v.value, 1)}円"><use href="#icon-marker-tri"/></svg>`;
      })
      .join('');
    analysisSmaLegendEl.innerHTML = values
      .map((v) => `<span class="analysis-sma-legend__item" style="color:${SMA_COLORS[v.period]};">SMA${v.period} ${v.value !== null ? fmt(v.value, 1) : '—'}</span>`)
      .join('');
  }

  // Fixed reference point for today's actual last close — distinct from the
  // slider's thumb, which the user is free to drag away to a hypothetical
  // price. Mirrored onto the opposite (bottom) side of the track from the
  // SMA markers so the two kinds of reference are never confused.
  function renderAnalysisCurrentPriceMarker(bars, range) {
    if (!bars.length) { analysisCurrentMarkerEl.classList.add('hidden'); return; }
    const currentClose = bars[bars.length - 1].close;
    analysisCurrentMarkerEl.style.left = `${priceToPct(currentClose, range)}%`;
    analysisCurrentMarkerEl.title = `現在値 ${fmt(currentClose, 1)}円`;
    analysisCurrentMarkerEl.classList.remove('hidden');
  }

  function renderAnalysisLotCard(lot, evalPrice) {
    const { pnl, pnlPct } = computeLotPnL(lot, evalPrice);
    const dir = pnl > 0 ? 'profit' : pnl < 0 ? 'loss' : null;
    const sign = pnl > 0 ? '+' : '';
    // A real settled lot has nothing left to simulate; every other lot (open,
    // or hypothetically checked as "settle now") gets the sim checkbox.
    const isRealSettled = lot.settled && !lot.simSettled;
    const metaTail = lot.simSettled
      ? ` → シミュレーション決済 @ ${fmt(lot.sellPrice)}円`
      : lot.settled
        ? ` → ${fmtDate(lot.sellDate)} @ ${fmt(lot.sellPrice)}円`
        : '';
    const badge = lot.simSettled
      ? '<span class="lot-badge-sim">シミュレーション決済</span>'
      : lot.settled
        ? '<span class="lot-badge-settled">決済済み</span>'
        : '';
    const checkbox = isRealSettled ? '' : `
          <input type="checkbox" class="analysis-sim-checkbox" data-lot-id="${lot.id}"
                 ${lot.simSettled ? 'checked' : ''} title="現在値で決済したと仮定してシミュレーション">`;
    return `
      <div class="lot-card${dir ? ` lot-card--${dir}` : ''}">${checkbox}
        <span class="lot-card__seq">#${lot.seq ?? '—'}</span>
        <div class="lot-card__main">
          <span class="lot-card__price">${fmt(lot.buyPrice)}円 <span style="color:var(--text-muted);font-weight:400;">× ${lot.quantity.toLocaleString('ja-JP')}株</span></span>
          <span class="lot-card__meta">${fmtDate(lot.buyDate)}${metaTail}</span>
        </div>
        ${badge}
        <div class="lot-card__pnl${dir ? ` pnl-${dir}` : ''}">
          ${dir ? pnlArrowSvg(dir === 'profit' ? 'up' : 'down') : ''}
          <span>${sign}${fmt(pnl, 0)}円 (${sign}${fmt(pnlPct, 1)}%)</span>
        </div>
      </div>`;
  }

  // Substitutes any lot checked in the partial-settlement simulator with a
  // "settled at today's close" copy, reusing computeLotPnL's existing
  // settled/open branch so no other rendering code needs to know about the
  // simulation at all — cards and the aggregate badge just see a lot that
  // happens to be settled.
  function effectiveAnalysisLots(currentClose) {
    return analysisLots.map((lot) =>
      (!lot.settled && analysisSimSettledIds.has(lot.id))
        ? { ...lot, settled: true, sellPrice: currentClose, simSettled: true }
        : lot
    );
  }

  function currentAnalysisClose() {
    return analysisBars.length ? analysisBars[analysisBars.length - 1].close : null;
  }

  function renderAnalysisLots(evalPrice) {
    const lots = effectiveAnalysisLots(currentAnalysisClose());
    if (!lots.length) {
      analysisLotsListEl.innerHTML = '';
      analysisLotsEmptyEl.classList.remove('hidden');
    } else {
      analysisLotsEmptyEl.classList.add('hidden');
      analysisLotsListEl.innerHTML = lots
        .slice()
        .sort((a, b) => (a.seq || 0) - (b.seq || 0))
        .map((lot) => renderAnalysisLotCard(lot, evalPrice))
        .join('');
    }

    if (!lots.length) {
      analysisAggEl.className = 'positions-agg positions-agg--flat';
      analysisAggEl.innerHTML = '建玉なし';
      return;
    }
    const { pnl, pnlPct } = computeLotsSummary(lots, evalPrice);
    const dir = pnl > 0 ? 'profit' : pnl < 0 ? 'loss' : 'flat';
    const sign = pnl > 0 ? '+' : '';
    analysisAggEl.className = `positions-agg positions-agg--${dir}`;
    const arrow = dir !== 'flat' ? pnlArrowSvg(dir === 'profit' ? 'up' : 'down') : '';
    analysisAggEl.innerHTML = `${arrow}<span>合計 ${sign}${fmt(pnl, 0)}円 (${sign}${fmt(pnlPct, 1)}%)</span>`;
  }

  function setAnalysisPrice(price) {
    analysisPriceSliderEl.value = price;
    analysisPriceValueEl.textContent = `${fmt(price, 1)}円`;
    renderAnalysisLots(price);
  }

  // 損益分岐点の計算式には決済済み建玉の実現損益を含める（合意済み） — 既存の「合計」
  // バッジ(computeAggregate)が実現損益＋含み損益を合算している仕様と一致させるため。
  // simSettledIdsが空集合なら以前と完全に同じ計算結果になる。
  function computeAnalysisBreakeven(lots, simSettledIds, currentClose) {
    const realizedPnL = lots.filter((l) => l.settled)
      .reduce((s, l) => s + (l.sellPrice - l.buyPrice) * l.quantity, 0);
    const simPnL = lots.filter((l) => !l.settled && simSettledIds.has(l.id))
      .reduce((s, l) => s + (currentClose - l.buyPrice) * l.quantity, 0);
    const remainingOpen = lots.filter((l) => !l.settled && !simSettledIds.has(l.id));
    const openQtySum = remainingOpen.reduce((s, l) => s + l.quantity, 0);
    if (openQtySum === 0) return null; // 保有中(シミュレーション決済分を除く)の建玉なし＝分岐点は定義できない
    const openCostSum = remainingOpen.reduce((s, l) => s + l.buyPrice * l.quantity, 0);
    return (openCostSum - realizedPnL - simPnL) / openQtySum;
  }

  function computeSimLockedProfit(lots, simSettledIds, currentClose) {
    return lots.filter((l) => !l.settled && simSettledIds.has(l.id))
      .reduce((s, l) => s + (currentClose - l.buyPrice) * l.quantity, 0);
  }

  function renderBreakevenUI() {
    const currentClose = currentAnalysisClose();
    const hasSim = analysisSimSettledIds.size > 0;

    if (hasSim) {
      const lockedProfit = computeSimLockedProfit(analysisLots, analysisSimSettledIds, currentClose);
      const lockedDir = lockedProfit > 0 ? 'up' : lockedProfit < 0 ? 'down' : null;
      const lockedSign = lockedProfit > 0 ? '+' : '';
      analysisLockedProfitEl.className = `analysis-breakeven-card__locked${lockedDir ? ` ${lockedDir}` : ''}`;
      analysisLockedProfitEl.textContent = `確定利益(シミュレーション) ${lockedSign}${fmt(lockedProfit, 0)}円`;
      analysisLockedProfitEl.classList.remove('hidden');
      analysisBreakevenLabelEl.textContent = '損益分岐点（残りの建玉）';
      analysisSimResetBtn.classList.remove('hidden');
    } else {
      analysisLockedProfitEl.classList.add('hidden');
      analysisBreakevenLabelEl.textContent = '損益分岐点';
      analysisSimResetBtn.classList.add('hidden');
    }

    const be = computeAnalysisBreakeven(analysisLots, analysisSimSettledIds, currentClose);
    if (be === null) {
      analysisBreakevenCardEl.classList.add('analysis-breakeven-card--na');
      analysisBreakevenValueEl.textContent = analysisLots.length
        ? '保有中の建玉がないため計算できません'
        : '建玉なし';
      analysisBreakevenJumpBtn.disabled = true;
      analysisBreakevenMarkerEl.classList.add('hidden');
      return;
    }
    analysisBreakevenCardEl.classList.remove('analysis-breakeven-card--na');
    analysisBreakevenValueEl.textContent = `${fmt(be, 1)}円`;
    analysisBreakevenJumpBtn.disabled = false;
    analysisBreakevenMarkerEl.style.left = `${priceToPct(be, analysisRange)}%`;
    analysisBreakevenMarkerEl.classList.remove('hidden');
  }

  function showAnalysisEmpty() {
    analysisCode = null;
    analysisBars = [];
    analysisLots = [];
    analysisRange = null;
    analysisInfoCodeEl.textContent = '';
    analysisInfoNameEl.textContent = '';
    analysisSmaMarkersEl.innerHTML = '';
    analysisSmaLegendEl.innerHTML = '';
    analysisCurrentMarkerEl.classList.add('hidden');
    analysisEmptyEl.classList.remove('hidden');
    analysisContentEl.classList.add('hidden');
  }

  async function loadAnalysisSymbol(code) {
    try {
      const [barsRes, positionsRes] = await Promise.all([
        fetch(`/api/bars/${code}`),
        fetch(`/api/positions/${code}`),
      ]);
      if (!barsRes.ok) throw new Error(`HTTP ${barsRes.status}`);
      if (!positionsRes.ok) throw new Error(`HTTP ${positionsRes.status}`);
      const barsData = await barsRes.json();
      const positionsData = await positionsRes.json();

      analysisCode = code;
      analysisBars = barsData.bars;
      analysisLots = positionsData.lots || [];
      analysisSimSettledIds = new Set(); // switching symbols always clears any in-progress simulation
      analysisInfoCodeEl.textContent = barsData.code;
      analysisInfoNameEl.textContent = barsData.name;

      analysisRange = computeAnalysisSliderRange(analysisBars);
      analysisPriceSliderEl.min = analysisRange.min;
      analysisPriceSliderEl.max = analysisRange.max;
      analysisSliderMinEl.textContent = `${fmt(analysisRange.min, 1)}円`;
      analysisSliderMaxEl.textContent = `${fmt(analysisRange.max, 1)}円`;

      setAnalysisPrice(analysisRange.defaultPrice);
      renderBreakevenUI();
      renderAnalysisSmaMarkers(analysisBars, analysisRange);
      renderAnalysisCurrentPriceMarker(analysisBars, analysisRange);

      analysisEmptyEl.classList.add('hidden');
      analysisContentEl.classList.remove('hidden');
    } catch (err) {
      statusText.textContent = `分析データの取得に失敗しました: ${err.message}`;
      showAnalysisEmpty();
    }
  }

  // The chart screen's add/settle/delete actions only update its own
  // `positions` array — they never touch `analysisLots`. Screens are just
  // shown/hidden (never torn down), so without this, an already-loaded
  // analysis screen would keep showing a stale, still-"open" copy of a lot
  // that was settled elsewhere, and it would keep reacting to the slider.
  async function refreshAnalysisLots() {
    if (!analysisCode) return;
    try {
      const res = await fetch(`/api/positions/${analysisCode}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      analysisLots = data.lots || [];
      // drop any simulated-settle checks for lots that no longer exist, or
      // that got for-real settled/deleted on the chart screen meanwhile
      const stillOpenIds = new Set(analysisLots.filter((l) => !l.settled).map((l) => l.id));
      analysisSimSettledIds = new Set([...analysisSimSettledIds].filter((id) => stillOpenIds.has(id)));
      renderAnalysisLots(Number(analysisPriceSliderEl.value));
      renderBreakevenUI();
    } catch (err) {
      statusText.textContent = `分析画面の建玉データの再取得に失敗しました: ${err.message}`;
    }
  }

  function onAnalysisSymbolChange(code) {
    if (!code) { showAnalysisEmpty(); return; }
    loadAnalysisSymbol(code);
  }

  analysisSelectEl.addEventListener('change', (e) => onAnalysisSymbolChange(e.target.value));
  analysisPriceSliderEl.addEventListener('input', (e) => setAnalysisPrice(Number(e.target.value)));
  analysisBreakevenJumpBtn.addEventListener('click', () => {
    const be = computeAnalysisBreakeven(analysisLots, analysisSimSettledIds, currentAnalysisClose());
    if (be !== null) setAnalysisPrice(be);
  });
  analysisJumpCurrentBtn.addEventListener('click', () => {
    const currentClose = currentAnalysisClose();
    if (currentClose !== null) setAnalysisPrice(currentClose);
  });

  // ---- partial-settlement simulator (分析画面の建玉チェックボックス) ----
  analysisLotsListEl.addEventListener('change', (e) => {
    const cb = e.target.closest('.analysis-sim-checkbox');
    if (!cb) return;
    const id = cb.dataset.lotId;
    if (cb.checked) analysisSimSettledIds.add(id); else analysisSimSettledIds.delete(id);
    renderAnalysisLots(Number(analysisPriceSliderEl.value));
    renderBreakevenUI();
  });

  analysisSimResetBtn.addEventListener('click', () => {
    analysisSimSettledIds.clear();
    renderAnalysisLots(Number(analysisPriceSliderEl.value));
    renderBreakevenUI();
  });

  // ---- stats screen (統計): several independent statistical views of the
  // price series — rolling standard deviation relative to a chosen SMA,
  // running drawdown from the historical peak, and rolling historical
  // VaR/CVaR of daily returns. Independent state, same pattern as the
  // analysis screen — never touches currentCode/currentBars. ----
  const VAR_WINDOW_MIN = 30;
  const VAR_WINDOW_MAX = 500;

  const statsSelectEl = el('stats-symbol-select');
  const statsInfoCodeEl = el('stats-info-code');
  const statsInfoNameEl = el('stats-info-name');
  const statsEmptyEl = el('stats-empty');
  const statsContentEl = el('stats-content');
  const statsLoadingEl = el('stats-loading');

  const statsSmaPickerEl = el('stats-sma-picker');
  const statsCurrentPeriodEl = el('stats-current-period');
  const statsCurrentStdDevEl = el('stats-current-stddev');
  const statsChartEl = el('stats-chart');
  const statsChartWrapEl = el('stats-chart-wrap');

  const statsMaxDdEl = el('stats-max-dd');
  const statsCurrentDdEl = el('stats-current-dd');
  const statsDdChartEl = el('stats-dd-chart');
  const statsDdChartWrapEl = el('stats-dd-chart-wrap');

  const statsVarPickerEl = el('stats-var-picker');
  const statsVarWindowInputEl = el('stats-var-window');
  const statsVarConfidenceAEl = el('stats-var-confidence-a');
  const statsVarConfidenceBEl = el('stats-var-confidence-b');
  const statsCurrentVarEl = el('stats-current-var');
  const statsCurrentCvarEl = el('stats-current-cvar');
  const statsVarChartEl = el('stats-var-chart');
  const statsVarChartWrapEl = el('stats-var-chart-wrap');

  let statsCode = null;
  let statsBars = [];
  let statsPeriod = 25;
  let statsVarConfidence = 0.95;
  let statsVarWindow = 150; // trading days for the rolling VaR/CVaR window — user-adjustable
  let statsInitialized = false; // guards the one-time default-symbol behavior

  const statsChart = LightweightCharts.createChart(statsChartEl, chartOptions);
  const stdDevSeries = statsChart.addSeries(LightweightCharts.LineSeries, {
    color: SMA_COLORS[statsPeriod],
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  const statsDdChart = LightweightCharts.createChart(statsDdChartEl, chartOptions);
  const ddSeries = statsDdChart.addSeries(LightweightCharts.LineSeries, {
    color: DOWN_COLOR,
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  const statsVarChart = LightweightCharts.createChart(statsVarChartEl, chartOptions);
  const varSeriesLine = statsVarChart.addSeries(LightweightCharts.LineSeries, {
    color: '#cfe0ff',
    lineWidth: 1.5,
    priceLineVisible: false,
    lastValueVisible: false,
  });
  const cvarSeriesLine = statsVarChart.addSeries(LightweightCharts.LineSeries, {
    color: '#ff9c9c',
    lineWidth: 1.5,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  function resizeStatsCharts() {
    const r1 = statsChartEl.getBoundingClientRect();
    statsChart.resize(r1.width, r1.height);
    const r2 = statsDdChartEl.getBoundingClientRect();
    statsDdChart.resize(r2.width, r2.height);
    const r3 = statsVarChartEl.getBoundingClientRect();
    statsVarChart.resize(r3.width, r3.height);
  }
  const statsResizeObserver = new ResizeObserver(resizeStatsCharts);
  statsResizeObserver.observe(statsChartWrapEl);
  statsResizeObserver.observe(statsDdChartWrapEl);
  statsResizeObserver.observe(statsVarChartWrapEl);

  function populateStatsSymbolSelect() {
    const options = symbols.map((s) => `<option value="${s.code}">${s.code} ${s.name}</option>`).join('');
    statsSelectEl.insertAdjacentHTML('beforeend', options);
  }

  // Population standard deviation of closes within each rolling window,
  // measured against that same window's own mean (which is exactly the SMA
  // value at that point) — the classic Bollinger-Band-style dispersion
  // measure. O(n) via a sliding sum/sum-of-squares, same shape as computeSMA.
  function computeRollingStdDev(bars, period) {
    const out = [];
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i].close;
      sum += c;
      sumSq += c * c;
      if (i >= period) {
        const old = bars[i - period].close;
        sum -= old;
        sumSq -= old * old;
      }
      if (i >= period - 1) {
        const mean = sum / period;
        const variance = Math.max(0, sumSq / period - mean * mean); // clamp tiny float-error negatives
        out.push({ time: bars[i].time, value: Math.sqrt(variance) });
      }
    }
    return out;
  }

  function renderStatsChart() {
    const series = computeRollingStdDev(statsBars, statsPeriod);
    stdDevSeries.applyOptions({ color: SMA_COLORS[statsPeriod] });
    stdDevSeries.setData(series);
    statsChart.timeScale().fitContent();
    statsCurrentPeriodEl.textContent = statsPeriod;
    statsCurrentStdDevEl.textContent = series.length ? `${fmt(series[series.length - 1].value, 1)}円` : '—円';
  }

  function selectStatsPeriod(period) {
    statsPeriod = period;
    statsSmaPickerEl.querySelectorAll('.btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.period) === period);
    });
    if (statsBars.length) renderStatsChart();
  }

  // Running drawdown (%) from the highest close seen so far, up to each
  // point — always ≤ 0. This is the classic "underwater" risk view: the
  // single worst value across the series is the maximum drawdown, and the
  // shape of the line shows how quickly the stock has historically dug out
  // of a decline.
  function computeDrawdown(bars) {
    const out = [];
    let peak = -Infinity;
    bars.forEach((b) => {
      peak = Math.max(peak, b.close);
      out.push({ time: b.time, value: peak > 0 ? ((b.close - peak) / peak) * 100 : 0 });
    });
    return out;
  }

  function renderDrawdownChart() {
    const series = computeDrawdown(statsBars);
    ddSeries.setData(series);
    statsDdChart.timeScale().fitContent();
    if (!series.length) {
      statsMaxDdEl.textContent = '—';
      statsCurrentDdEl.textContent = '—';
      return;
    }
    const worst = series.reduce((a, b) => (b.value < a.value ? b : a));
    statsMaxDdEl.textContent = `${fmt(worst.value, 1)}% (${fmtDate(worst.time)})`;
    statsCurrentDdEl.textContent = `${fmt(series[series.length - 1].value, 1)}%`;
  }

  function computeDailyReturns(bars) {
    const out = [];
    for (let i = 1; i < bars.length; i++) {
      out.push({ time: bars[i].time, value: bars[i].close / bars[i - 1].close - 1 });
    }
    return out;
  }

  // Historical-simulation VaR/CVaR: within each rolling window of daily
  // returns, sort ascending and take the worst tail slice sized to the
  // confidence level (e.g. 95% confidence → worst 5% of the window). VaR is
  // the boundary of that tail (the least-bad of the bad days); CVaR is the
  // average of the whole tail (the expected loss given a bad day happens).
  // Both are reported as positive loss percentages.
  function computeRollingVarCvar(bars, confidence, window) {
    const returns = computeDailyReturns(bars);
    const varOut = [];
    const cvarOut = [];
    for (let i = window - 1; i < returns.length; i++) {
      const win = returns.slice(i - window + 1, i + 1).map((r) => r.value).sort((a, b) => a - b);
      const tailCount = Math.max(1, Math.round((1 - confidence) * window));
      const tail = win.slice(0, tailCount);
      const varReturn = tail[tail.length - 1];
      const cvarReturn = tail.reduce((s, v) => s + v, 0) / tail.length;
      const time = returns[i].time;
      varOut.push({ time, value: -varReturn * 100 });
      cvarOut.push({ time, value: -cvarReturn * 100 });
    }
    return { varSeries: varOut, cvarSeries: cvarOut };
  }

  function renderVarChart() {
    const { varSeries, cvarSeries } = computeRollingVarCvar(statsBars, statsVarConfidence, statsVarWindow);
    varSeriesLine.setData(varSeries);
    cvarSeriesLine.setData(cvarSeries);
    statsVarChart.timeScale().fitContent();
    const pct = Math.round(statsVarConfidence * 100);
    statsVarConfidenceAEl.textContent = pct;
    statsVarConfidenceBEl.textContent = pct;
    if (!varSeries.length) {
      statsCurrentVarEl.textContent = 'データ不足';
      statsCurrentCvarEl.textContent = 'データ不足';
      return;
    }
    const currentClose = statsBars[statsBars.length - 1].close;
    const latestVar = varSeries[varSeries.length - 1].value;
    const latestCvar = cvarSeries[cvarSeries.length - 1].value;
    statsCurrentVarEl.textContent = `-${fmt(latestVar, 1)}% (約${fmt(currentClose * latestVar / 100, 0)}円)`;
    statsCurrentCvarEl.textContent = `-${fmt(latestCvar, 1)}% (約${fmt(currentClose * latestCvar / 100, 0)}円)`;
  }

  function selectStatsVarConfidence(confidence) {
    statsVarConfidence = confidence;
    statsVarPickerEl.querySelectorAll('.btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.confidence) === confidence);
    });
    if (statsBars.length) renderVarChart();
  }

  // Reads the window-size input, clamps it into a sane range, and writes the
  // clamped value back into the field so an out-of-range entry (e.g. "5" or
  // "9999") visibly snaps to what's actually being used.
  function updateStatsVarWindow() {
    let value = Math.round(Number(statsVarWindowInputEl.value));
    if (!Number.isFinite(value)) value = statsVarWindow;
    value = Math.min(VAR_WINDOW_MAX, Math.max(VAR_WINDOW_MIN, value));
    statsVarWindow = value;
    statsVarWindowInputEl.value = value;
    if (statsBars.length) renderVarChart();
  }

  function showStatsEmpty() {
    statsCode = null;
    statsBars = [];
    statsInfoCodeEl.textContent = '';
    statsInfoNameEl.textContent = '';
    stdDevSeries.setData([]);
    ddSeries.setData([]);
    varSeriesLine.setData([]);
    cvarSeriesLine.setData([]);
    statsEmptyEl.classList.remove('hidden');
    statsContentEl.classList.add('hidden');
  }

  async function loadStatsSymbol(code) {
    statsLoadingEl.classList.remove('hidden');
    try {
      const res = await fetch(`/api/bars/${code}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      statsCode = code;
      statsBars = data.bars;
      statsInfoCodeEl.textContent = data.code;
      statsInfoNameEl.textContent = data.name;

      renderStatsChart();
      renderDrawdownChart();
      renderVarChart();

      statsEmptyEl.classList.add('hidden');
      statsContentEl.classList.remove('hidden');
      resizeStatsCharts();
    } catch (err) {
      statusText.textContent = `統計データの取得に失敗しました: ${err.message}`;
      showStatsEmpty();
    } finally {
      statsLoadingEl.classList.add('hidden');
    }
  }

  function onStatsSymbolChange(code) {
    if (!code) { showStatsEmpty(); return; }
    loadStatsSymbol(code);
  }

  statsSelectEl.addEventListener('change', (e) => onStatsSymbolChange(e.target.value));
  statsSmaPickerEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    selectStatsPeriod(Number(btn.dataset.period));
    saveStatsSettings();
  });
  statsVarPickerEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    selectStatsVarConfidence(Number(btn.dataset.confidence));
    saveStatsSettings();
  });
  statsVarWindowInputEl.addEventListener('change', () => {
    updateStatsVarWindow();
    saveStatsSettings();
  });

  // ---- settings persistence: user-adjustable parameters (currently just
  // the stats screen's SMA period / VaR confidence / VaR window) are saved
  // to settings.json on the server and restored on the next visit. ----
  async function fetchAppSettings() {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch {
      return {};
    }
  }

  async function saveStatsSettings() {
    try {
      await fetch('/api/settings/stats', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smaPeriod: statsPeriod,
          varConfidence: statsVarConfidence,
          varWindow: statsVarWindow,
        }),
      });
    } catch {
      // best-effort — a failed save just means next session falls back to defaults
    }
  }

  // Applies a previously-saved {smaPeriod, varConfidence, varWindow} blob,
  // reusing the same setters user interaction goes through so the DOM
  // (active button states, the window input) and internal state never
  // diverge. Anything missing or out of range is left at its default.
  function applyStatsSettings(saved) {
    if (!saved) return;
    if (SMA_PERIODS.includes(saved.smaPeriod)) selectStatsPeriod(saved.smaPeriod);
    if ([0.9, 0.95, 0.99].includes(saved.varConfidence)) selectStatsVarConfidence(saved.varConfidence);
    if (Number.isFinite(saved.varWindow)) {
      statsVarWindowInputEl.value = saved.varWindow;
      updateStatsVarWindow();
    }
  }

  // ---- init ----
  async function init() {
    try {
      const [res, settings] = await Promise.all([fetch('/api/symbols'), fetchAppSettings()]);
      symbols = await res.json();
      applyStatsSettings(settings.stats);
      populateAnalysisSymbolSelect();
      populateStatsSymbolSelect();
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
