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
  // No cap on match count — the suggestions box already scrolls
  // (max-height + overflow-y in CSS), and capping silently hid real symbols
  // once there were more than 30. `pool` defaults to every symbol, but a
  // search box can narrow it (e.g. the simulation screen only offers
  // symbols with open positions). Sector is matched too, so typing an
  // industry name (e.g. "銀行") surfaces every symbol in it.
  function matchSymbols(query, pool) {
    const candidates = pool || symbols;
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((s) =>
      s.code.startsWith(q) ||
      s.name.toLowerCase().includes(q) ||
      (s.nameEn && s.nameEn.toLowerCase().includes(q)) ||
      (s.sector && s.sector.toLowerCase().includes(q))
    );
  }

  // Groups an already-filtered symbol list by sector (業種), sorted so the
  // grouping reads consistently every time — this is what turns a long flat
  // list into the two-level 業種→銘柄 structure the dropdown renders.
  function groupBySector(list) {
    const bySector = new Map();
    list.forEach((s) => {
      const sector = s.sector || '未分類';
      if (!bySector.has(sector)) bySector.set(sector, []);
      bySector.get(sector).push(s);
    });
    return [...bySector.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ja'));
  }

  // One reusable search-box-with-suggestions component — the chart screen's
  // top search box, and the symbol pickers on the simulation/stats screens,
  // are all instances of this, so their look and keyboard behavior can never
  // drift apart. onSelect(code) is called once a symbol is actually chosen
  // (click, Enter, or a programmatic .select(code) call). getPool() lets a
  // given instance narrow which symbols it offers (defaults to all of them).
  function createSymbolSearchBox({ containerEl, inputEl, suggestionsEl, onSelect, getPool, emptyMessage }) {
    let activeIndex = -1;
    const pool = getPool || (() => symbols);
    const noMatchText = emptyMessage || '一致する銘柄がありません';

    function render(list) {
      activeIndex = -1;
      if (!list.length) {
        suggestionsEl.innerHTML = `<div class="no-match">${noMatchText}</div>`;
        suggestionsEl.classList.remove('hidden');
        return;
      }
      suggestionsEl.innerHTML = groupBySector(list).map(([sector, items]) => {
        const itemsHtml = items.map((s) => {
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
        return `<div class="suggestion-group"><div class="suggestion-group__label">${sector}</div>${itemsHtml}</div>`;
      }).join('');
      suggestionsEl.classList.remove('hidden');
    }

    function openFiltered() { render(matchSymbols(inputEl.value, pool())); }
    function openAll() { render(matchSymbols('', pool())); }
    function close() { suggestionsEl.classList.add('hidden'); }

    function select(code) {
      const info = symbols.find((s) => s.code === code);
      inputEl.value = info ? `${info.code} ${info.name}` : code;
      close();
      onSelect(code);
    }

    inputEl.addEventListener('input', openFiltered);
    // Always show the full list on focus, regardless of leftover text from a
    // previous selection, and select that text so typing immediately
    // replaces it — otherwise re-opening the dropdown after a selection
    // required first manually clearing the "1605 ＩＮＰＥＸ"-style text.
    inputEl.addEventListener('focus', () => {
      inputEl.select();
      openAll();
    });

    document.addEventListener('click', (e) => {
      if (!containerEl.contains(e.target)) close();
    });

    suggestionsEl.addEventListener('click', (e) => {
      const item = e.target.closest('.suggestion-item');
      if (!item) return;
      select(item.dataset.code);
    });

    inputEl.addEventListener('keydown', (e) => {
      const items = suggestionsEl.querySelectorAll('.suggestion-item');
      if (!items.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = activeIndex >= 0 ? items[activeIndex] : items[0];
        if (target) select(target.dataset.code);
        return;
      } else if (e.key === 'Escape') {
        close();
        return;
      } else {
        return;
      }
      items.forEach((it, i) => it.classList.toggle('active', i === activeIndex));
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    });

    return { select };
  }

  const chartSymbolSearch = createSymbolSearchBox({
    containerEl: symbolInput.closest('.search-box'),
    inputEl: symbolInput,
    suggestionsEl: suggestionsBox,
    onSelect: selectSymbol,
  });
  function chooseSymbol(code) { chartSymbolSearch.select(code); }

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
        // so no separate refresh is needed on this branch. Only applies when
        // that symbol actually has an open position, since this screen's
        // picker is otherwise restricted to held symbols.
        analysisInitialized = true;
        if (currentCode && heldSymbols().some((s) => s.code === currentCode)) {
          analysisSymbolSearch.select(currentCode);
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
          statsSymbolSearch.select(currentCode);
        }
      }
    }
    if (screenId === 'screener' && !screenerInitialized) {
      screenerInitialized = true;
      loadScreenerData();
    }
    if (screenId === 'portfolio' && pfLastHoldings.length) {
      // the stage was sized 0x0 while its screen was display:none, so the
      // canvas backing store and cluster layout are stale — refresh both
      // now instead of waiting on the next resize observer tick.
      resizePortfolioCanvas();
    }
    if (screenId === 'dividends') {
      if (!dividendsInitialized) {
        dividendsInitialized = true;
        loadDividendsData();
      } else {
        // pick up any position added/settled/deleted elsewhere since this
        // screen was last shown (computed dividend amounts only change when
        // jquants_api.py refetches finance data, so no need to re-fetch those
        // here — the 更新 button does that — just re-derive holdings from
        // current positions).
        renderDividendsList(dividendHoldings());
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
    renderPortfolio();
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

  // Symbols with at least one open (未決済) lot — the simulation screen's
  // symbol picker offers only these, since simulating a price for a symbol
  // with no position doesn't make sense there.
  function heldSymbols() {
    return symbols.filter((sym) => (allPositionsByCode[sym.code] || []).some((l) => !l.settled));
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

    // `dir` is always the real up/down direction (never a separate "net"
    // color) so the total column turns red/green with the actual total —
    // `isNet` only controls the extra styling that keeps it visually
    // distinct from an individual lot's bar in the same color.
    function barHtml(from, to, pnl, dir, labelHtml, isNet) {
      const bottom = pct(Math.min(from, to));
      const height = Math.abs(pct(to) - pct(from));
      const valueBottom = pct(Math.max(from, to)) + 3;
      const sign = pnl > 0 ? '+' : '';
      return `
        <div class="wf-col${isNet ? ' is-net' : ''}">
          <div class="wf-bar ${dir}${isNet ? ' net' : ''}" style="bottom:${bottom}%;height:${height}%;"></div>
          <div class="wf-value ${dir}${isNet ? ' net' : ''}" style="bottom:${valueBottom}%;">${sign}${fmt(pnl, 0)}</div>
          <div class="wf-label">${labelHtml}</div>
        </div>`;
    }

    const colsHtml = steps.map((s) =>
      barHtml(s.from, s.to, s.pnl, s.pnl >= 0 ? 'up' : 'down', `#${s.lot.seq ?? '—'}`, false)
    ).join('') + barHtml(0, net, net, net >= 0 ? 'up' : 'down', '合計', true);

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
  const analysisSymbolInputEl = el('analysis-symbol-input');
  const analysisSymbolSuggestionsEl = el('analysis-symbol-suggestions');
  const analysisEmptyEl = el('analysis-empty');
  const analysisContentEl = el('analysis-content');
  const analysisPriceSliderEl = el('analysis-price-slider');
  const analysisPriceValueEl = el('analysis-price-value');
  const analysisSliderMinEl = el('analysis-slider-min');
  const analysisSliderMaxEl = el('analysis-slider-max');
  const analysisJumpCurrentBtn = el('analysis-jump-current');
  const analysisAggEl = el('analysis-agg');
  const analysisLotsListEl = el('analysis-lots-list');
  const analysisLotsEmptyEl = el('analysis-lots-empty');
  const analysisLockedProfitEl = el('analysis-locked-profit');
  const analysisSimResetBtn = el('analysis-sim-reset');
  const refptsSimBannerEl = el('refpts-sim-banner');
  const refptsListEl = el('refpts-list');
  const analysisDdComparisonEl = el('analysis-dd-comparison');

  const REFPT_GROUP_TITLES = { sma: 'SMA（移動平均線）', sigma: 'σ（標準偏差）', varcvar: 'VaR・CVaR' };

  let analysisCode = null;
  let analysisBars = [];
  let analysisLots = [];
  let analysisRange = null; // { min, max, defaultPrice }
  let analysisInitialized = false; // guards the one-time default-symbol behavior
  let analysisSimSettledIds = new Set(); // lot ids checked as "settle now" in the partial-settlement simulator

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
    renderDrawdownComparison(price);
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

  // ---- price reference points: SMA/σ/VaR/CVaR/最大ドローダウン/損益分岐点,
  // consolidated into one sorted-by-distance-from-current list instead of the
  // old three disconnected widgets (slider-marker overlay, separate stoploss
  // list, separate breakeven card). Same-family points (four SMA periods,
  // three σ multiples, VaR+CVaR) are bundled into one bordered block of
  // compact single-line rows so they don't need a full row each; solo points
  // (損益分岐点, 最大ドローダウン) get one row each. Every row is clickable and
  // jumps the simulator to that price, reusing setAnalysisPrice. ----
  // VaR/CVaR here use a fixed 1250-day (~5年) sample count — independent of
  // the stats screen's user-adjustable statsVarWindow, since the simulation
  // screen has no control to change it and always wants the long-run figure.
  const ANALYSIS_VAR_WINDOW = 1250;

  function computeAnalysisRefPoints(bars, currentClose) {
    const points = [];

    latestAnalysisSmaValues(bars).forEach(({ period, value }) => {
      if (value === null) return;
      points.push({ key: `sma${period}`, group: 'sma', label: `SMA${period}`, price: value, color: SMA_COLORS[period] });
    });

    const stdSeries = computeRollingStdDev(bars, statsPeriod);
    if (stdSeries.length) {
      const sigma = stdSeries[stdSeries.length - 1].value;
      const sigmaColors = { 1: '#ffb3b3', 2: '#f2767e', 3: '#c23b44' };
      [1, 2, 3].forEach((k) => {
        points.push({
          key: `sigma${k}`, group: 'sigma', label: `${k}σ`, color: sigmaColors[k],
          price: Math.max(1, currentClose - k * sigma),
        });
      });
    }

    // J-Quants only ever returns ~5年分(≈1222営業日)of bars regardless of
    // symbol, so cap at whatever's actually available instead of requiring
    // the full 1250 — otherwise this would always fall short by a hair and
    // silently hide VaR/CVaR even when 5 years of history is loaded.
    const analysisVarWindow = Math.min(ANALYSIS_VAR_WINDOW, Math.max(1, bars.length - 1));
    const { varSeries, cvarSeries } = computeRollingVarCvar(bars, statsVarConfidence, analysisVarWindow);
    const confidencePct = Math.round(statsVarConfidence * 100);
    if (varSeries.length) {
      const varPct = varSeries[varSeries.length - 1].value;
      points.push({ key: 'var', group: 'varcvar', label: `VaR${confidencePct}%`, color: '#ffb648', price: Math.max(1, currentClose * (1 - varPct / 100)) });
    }
    if (cvarSeries.length) {
      const cvarPct = cvarSeries[cvarSeries.length - 1].value;
      points.push({ key: 'cvar', group: 'varcvar', label: `CVaR${confidencePct}%`, color: '#e8791a', price: Math.max(1, currentClose * (1 - cvarPct / 100)) });
    }

    const ddSeries = computeDrawdown(bars);
    if (ddSeries.length) {
      const maxDd = Math.abs(ddSeries.reduce((a, b) => (b.value < a.value ? b : a)).value);
      points.push({ key: 'maxdd', group: 'solo', label: '最大DD', color: '#9b6bff', price: Math.max(1, currentClose * (1 - maxDd / 100)) });
    }

    return points;
  }

  function refptRowHtml(p, currentClose, maxAbsPct) {
    const pv = ((p.price - currentClose) / currentClose) * 100;
    const widthPct = maxAbsPct > 0 ? (Math.abs(pv) / maxAbsPct) * 48 : 0;
    const isLeft = pv < 0;
    return `
      <div class="refpt-row" data-price="${p.price}">
        <span class="refpt-row__dot" style="background:${p.color}"></span>
        <span class="refpt-row__label">${p.label}</span>
        <div class="refpt-row__track">
          <div class="refpt-row__zero"></div>
          <div class="refpt-row__bar" style="background:${p.color}; ${isLeft ? `right:50%; width:${widthPct}%;` : `left:50%; width:${widthPct}%;`}"></div>
        </div>
        <span class="refpt-row__value">${fmt(p.price, 1)}円<small>${pv > 0 ? '+' : ''}${fmt(pv, 2)}%</small></span>
      </div>`;
  }

  // Re-run whenever the symbol changes or the partial-settlement simulation
  // state changes (which moves 損益分岐点) — NOT on every slider tick, same
  // as the widgets this replaces.
  function renderAnalysisRefPoints() {
    const currentClose = currentAnalysisClose();
    if (currentClose === null) {
      refptsListEl.innerHTML = '';
      refptsSimBannerEl.classList.add('hidden');
      return;
    }

    const hasSim = analysisSimSettledIds.size > 0;
    if (hasSim) {
      const lockedProfit = computeSimLockedProfit(analysisLots, analysisSimSettledIds, currentClose);
      const lockedDir = lockedProfit > 0 ? 'up' : lockedProfit < 0 ? 'down' : null;
      const lockedSign = lockedProfit > 0 ? '+' : '';
      analysisLockedProfitEl.className = `refpts__locked${lockedDir ? ` ${lockedDir}` : ''}`;
      analysisLockedProfitEl.textContent = `確定利益(シミュレーション) ${lockedSign}${fmt(lockedProfit, 0)}円`;
      refptsSimBannerEl.classList.remove('hidden');
    } else {
      refptsSimBannerEl.classList.add('hidden');
    }

    const be = computeAnalysisBreakeven(analysisLots, analysisSimSettledIds, currentClose);
    const points = computeAnalysisRefPoints(analysisBars, currentClose);
    if (be !== null) {
      points.push({
        key: 'breakeven', group: 'solo', color: '#2962ff',
        label: hasSim ? '損益分岐点(残)' : '損益分岐点',
        price: be,
      });
    }

    if (!points.length) {
      refptsListEl.innerHTML = '<div class="refpts-empty">データ不足のため算出できません。</div>';
      return;
    }

    const maxAbsPct = Math.max(...points.map((p) => Math.abs(((p.price - currentClose) / currentClose) * 100)));
    const groupKeys = ['sma', 'sigma', 'varcvar'];
    const blocks = [];
    groupKeys.forEach((g) => {
      const members = points.filter((p) => p.group === g);
      if (members.length) {
        blocks.push({
          type: 'group', group: g, members,
          sortKey: Math.min(...members.map((p) => Math.abs(((p.price - currentClose) / currentClose) * 100))),
        });
      }
    });
    points.filter((p) => !groupKeys.includes(p.group)).forEach((p) => {
      blocks.push({ type: 'solo', point: p, sortKey: Math.abs(((p.price - currentClose) / currentClose) * 100) });
    });
    blocks.sort((a, b) => a.sortKey - b.sortKey);

    refptsListEl.innerHTML = blocks.map((b) => {
      if (b.type === 'solo') {
        return `<div class="refpt-block refpt-block--solo">${refptRowHtml(b.point, currentClose, maxAbsPct)}</div>`;
      }
      const rows = b.members.map((p) => refptRowHtml(p, currentClose, maxAbsPct)).join('');
      return `<div class="refpt-block refpt-group">
        <div class="refpt-group__title">${REFPT_GROUP_TITLES[b.group]}</div>
        ${rows}
      </div>`;
    }).join('');
  }

  // Tied to whatever price the slider currently represents, so it updates on
  // every input/jump — "is this stop deeper than what normally happens to
  // this stock, or shallower?" answered against the symbol's own history.
  function renderDrawdownComparison(price) {
    const currentClose = currentAnalysisClose();
    if (currentClose === null || !analysisBars.length || price >= currentClose) {
      analysisDdComparisonEl.textContent = '';
      analysisDdComparisonEl.className = 'refpts__note';
      return;
    }
    const ddSeries = computeDrawdown(analysisBars);
    if (!ddSeries.length) {
      analysisDdComparisonEl.textContent = '';
      return;
    }
    const maxDd = Math.abs(ddSeries.reduce((a, b) => (b.value < a.value ? b : a)).value);
    const consideredDrop = Math.abs(((price - currentClose) / currentClose) * 100);
    const ratio = maxDd > 0 ? (consideredDrop / maxDd) * 100 : 0;

    let level;
    let comment;
    if (ratio < 50) {
      level = 'mild';
      comment = '通常の値動きの範囲内で、損切りに引っかかりやすい可能性があります。';
    } else if (ratio < 100) {
      level = 'moderate';
      comment = '過去の下落と近い水準です。';
    } else {
      level = 'severe';
      comment = '過去の最大下落幅を超える水準です。';
    }

    analysisDdComparisonEl.className = `refpts__note refpts__note--${level}`;
    analysisDdComparisonEl.textContent =
      `検討中の価格は現在値から${fmt(consideredDrop, 1)}%の下落（過去の最大ドローダウン${fmt(maxDd, 1)}%の${fmt(ratio, 0)}%）。${comment}`;
  }

  function showAnalysisEmpty() {
    analysisCode = null;
    analysisBars = [];
    analysisLots = [];
    analysisRange = null;
    refptsListEl.innerHTML = '';
    refptsSimBannerEl.classList.add('hidden');
    analysisDdComparisonEl.textContent = '';
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

      analysisRange = computeAnalysisSliderRange(analysisBars);
      analysisPriceSliderEl.min = analysisRange.min;
      analysisPriceSliderEl.max = analysisRange.max;
      analysisSliderMinEl.textContent = `${fmt(analysisRange.min, 1)}円`;
      analysisSliderMaxEl.textContent = `${fmt(analysisRange.max, 1)}円`;

      setAnalysisPrice(analysisRange.defaultPrice);
      renderAnalysisRefPoints();

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
      renderAnalysisRefPoints();
    } catch (err) {
      statusText.textContent = `分析画面の建玉データの再取得に失敗しました: ${err.message}`;
    }
  }

  function onAnalysisSymbolChange(code) {
    if (!code) { showAnalysisEmpty(); return; }
    loadAnalysisSymbol(code);
  }

  const analysisSymbolSearch = createSymbolSearchBox({
    containerEl: analysisSymbolInputEl.closest('.search-box'),
    inputEl: analysisSymbolInputEl,
    suggestionsEl: analysisSymbolSuggestionsEl,
    onSelect: onAnalysisSymbolChange,
    getPool: heldSymbols,
    emptyMessage: '保有中の建玉がある銘柄がありません',
  });
  analysisPriceSliderEl.addEventListener('input', (e) => setAnalysisPrice(Number(e.target.value)));
  analysisJumpCurrentBtn.addEventListener('click', () => {
    const currentClose = currentAnalysisClose();
    if (currentClose !== null) setAnalysisPrice(currentClose);
  });

  refptsListEl.addEventListener('click', (e) => {
    const row = e.target.closest('.refpt-row');
    if (!row) return;
    setAnalysisPrice(Number(row.dataset.price));
  });

  // ---- partial-settlement simulator (分析画面の建玉チェックボックス) ----
  analysisLotsListEl.addEventListener('change', (e) => {
    const cb = e.target.closest('.analysis-sim-checkbox');
    if (!cb) return;
    const id = cb.dataset.lotId;
    if (cb.checked) analysisSimSettledIds.add(id); else analysisSimSettledIds.delete(id);
    renderAnalysisLots(Number(analysisPriceSliderEl.value));
    renderAnalysisRefPoints();
  });

  analysisSimResetBtn.addEventListener('click', () => {
    analysisSimSettledIds.clear();
    renderAnalysisLots(Number(analysisPriceSliderEl.value));
    renderAnalysisRefPoints();
  });

  // ---- stats screen (統計): several independent statistical views of the
  // price series — rolling standard deviation relative to a chosen SMA,
  // running drawdown from the historical peak, and rolling historical
  // VaR/CVaR of daily returns. Independent state, same pattern as the
  // analysis screen — never touches currentCode/currentBars. ----
  const VAR_WINDOW_MIN = 30;
  const VAR_WINDOW_MAX = 500;

  const statsSymbolInputEl = el('stats-symbol-input');
  const statsSymbolSuggestionsEl = el('stats-symbol-suggestions');
  const statsInfoCodeEl = el('stats-info-code');
  const statsInfoNameEl = el('stats-info-name');
  const statsInfoSectorEl = el('stats-info-sector');
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

  const statsCorrEmptyEl = el('stats-corr-empty');
  const statsCorrListEl = el('stats-corr-list');

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

  // ---- correlation ranking: computed server-side (it needs every other
  // symbol's full price history, not just the selected one) and rendered as
  // sorted diverging bars — the same zero-centered-bar idiom as the P&L
  // waterfall, ranked by |correlation| so strong positive AND strong
  // inverse relationships both surface at the top. ----
  // Strength tier from |r|, at the requested 0.25/0.50/0.75 breakpoints —
  // drives bar opacity/gradient intensity only. Hue stays fixed per
  // direction (green for positive, red for negative); tiers never change
  // which color family a bar uses, only how vivid it looks.
  function correlationTier(absR) {
    if (absR >= 0.75) return 3;
    if (absR >= 0.5) return 2;
    if (absR >= 0.25) return 1;
    return 0;
  }

  function renderCorrelationRanking(rankings, baseSector) {
    if (!rankings.length) {
      statsCorrListEl.innerHTML = '';
      statsCorrEmptyEl.classList.remove('hidden');
      return;
    }
    statsCorrEmptyEl.classList.add('hidden');
    statsCorrListEl.innerHTML = rankings.map((r) => {
      const dir = r.correlation >= 0 ? 'up' : 'down';
      const absR = Math.min(1, Math.abs(r.correlation));
      const tier = correlationTier(absR);
      // Left-anchored now that the bar has its own full-width line below the
      // name — length alone (0-100% of the track) encodes |r|, color encodes
      // sign, using the whole width instead of only half of it either side
      // of a center line.
      const barStyle = `left:0;width:${absR * 100}%;`;
      const sign = r.correlation > 0 ? '+' : '';
      // Same sector as the base symbol reads as muted (expected — same
      // industry tends to move together); a different sector is called out
      // in the accent color, since that's the "is this cross-industry?"
      // signal the ranking exists to surface.
      const sameSector = baseSector && r.sector === baseSector;
      const sectorClass = r.sector ? (sameSector ? '' : ' corr-row__sector--cross') : '';
      return `
        <div class="corr-row">
          <div class="corr-row__head">
            <span class="corr-row__label" title="${r.code} ${r.name}">${r.code} ${r.name}</span>
            <span class="corr-row__sector${sectorClass}" title="${r.sector || ''}">${r.sector || '—'}</span>
            <span class="corr-row__value ${dir}">${sign}${fmt(r.correlation, 2)}</span>
            <span class="corr-row__n">n=${r.sampleSize}</span>
          </div>
          <div class="corr-row__track">
            <div class="corr-row__bar ${dir} tier-${tier}" style="${barStyle}"></div>
          </div>
        </div>`;
    }).join('');
  }

  async function loadCorrelationRanking(code) {
    try {
      const res = await fetch(`/api/correlations/${code}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      statsInfoSectorEl.textContent = data.sector || '';
      renderCorrelationRanking(data.rankings || [], data.sector);
    } catch (err) {
      statusText.textContent = `相関ランキングの取得に失敗しました: ${err.message}`;
      renderCorrelationRanking([]);
    }
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
    statsInfoSectorEl.textContent = '';
    stdDevSeries.setData([]);
    ddSeries.setData([]);
    varSeriesLine.setData([]);
    cvarSeriesLine.setData([]);
    renderCorrelationRanking([]);
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

      // fetched separately and not awaited — it needs every other symbol's
      // full history server-side, so it can take longer than the three
      // charts above, which are all computed from data already in hand.
      loadCorrelationRanking(code);
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

  const statsSymbolSearch = createSymbolSearchBox({
    containerEl: statsSymbolInputEl.closest('.search-box'),
    inputEl: statsSymbolInputEl,
    suggestionsEl: statsSymbolSuggestionsEl,
    onSelect: onStatsSymbolChange,
  });
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

  // ---- screener screen (銘柄選定): cross-symbol trend/volatility screening.
  // Fetches /api/screener once (every symbol's precomputed metrics, no
  // filtering applied) and does all filtering/sorting/rendering locally, so
  // adjusting a threshold is instant — same shape as the stats screen's local
  // VaR-window recompute and the correlation ranking's full-list response. ----
  const screenerLoadingEl = el('screener-loading');
  const screenerLoadErrorEl = el('screener-load-error');
  const screenerContentEl = el('screener-content');
  const screenerCountEl = el('screener-count');
  const screenerEmptyEl = el('screener-empty');
  const screenerListEl = el('screener-list');
  const screenerTrendModePickerEl = el('screener-trend-mode-picker');
  const screenerPoRowEl = el('screener-po-row');
  const screenerSlopeRowEl = el('screener-slope-row');
  const screenerOrderScoreInputEl = el('screener-order-score');
  const screenerSlopePeriodPickerEl = el('screener-slope-period-picker');
  const screenerMinSlopeInputEl = el('screener-min-slope');
  const screenerSurgeDaysInputEl = el('screener-surge-days');
  const screenerSurgePctInputEl = el('screener-surge-pct');
  const screenerVolRatioMaxInputEl = el('screener-vol-ratio-max');
  const screenerRefreshBtnEl = el('screener-refresh-btn');

  let screenerRows = null; // null until the first successful fetch
  let screenerInitialized = false;
  let screenerTrendMode = 'po';
  let screenerSlopePeriod = 25;

  function screenerBadge(row) {
    if (screenerTrendMode === 'po') {
      return row.perfectOrder
        ? `<span class="screener-badge screener-badge--po">パーフェクトオーダー</span>`
        : `<span class="screener-badge">スコア ${row.orderScore}/4</span>`;
    }
    const slope = row.sma[screenerSlopePeriod].slopePct;
    const dir = slope >= 0 ? 'up' : 'down';
    const sign = slope >= 0 ? '+' : '';
    return `<span class="screener-badge screener-badge--${dir}">SMA${screenerSlopePeriod} ${sign}${fmt(slope, 2)}%/日</span>`;
  }

  function screenerRowPasses(row) {
    if (screenerTrendMode === 'po') {
      const minScore = Number(screenerOrderScoreInputEl.value);
      if (Number.isFinite(minScore) && row.orderScore < minScore) return false;
    } else {
      const minSlope = Number(screenerMinSlopeInputEl.value);
      if (Number.isFinite(minSlope) && row.sma[screenerSlopePeriod].slopePct < minSlope) return false;
    }
    // Only 5d/20d change is precomputed server-side, so the "surge window"
    // control is a choice between those two, not a free-form day count.
    const surgeDays = Number(screenerSurgeDaysInputEl.value);
    const surgePct = Number(screenerSurgePctInputEl.value);
    if (Number.isFinite(surgePct)) {
      const chg = surgeDays === 20 ? row.chg20d : row.chg5d;
      if (chg !== null && chg !== undefined && chg > surgePct) return false;
    }
    const volRatioMax = Number(screenerVolRatioMaxInputEl.value);
    if (Number.isFinite(volRatioMax) && row.volRatio !== null && row.volRatio > volRatioMax) return false;
    return true;
  }

  function renderScreenerRow(row) {
    const chg5Sign = row.chg5d >= 0 ? '+' : '';
    const chg20Sign = row.chg20d >= 0 ? '+' : '';
    const volRatioText = row.volRatio !== null && row.volRatio !== undefined ? fmt(row.volRatio, 2) : '—';
    return `
      <div class="corr-row screener-row" data-code="${row.code}">
        <div class="corr-row__head">
          <span class="corr-row__label" title="${row.code} ${row.name}">${row.code} ${row.name}</span>
          <span class="corr-row__sector" title="${row.sector || ''}">${row.sector || '—'}</span>
          ${screenerBadge(row)}
        </div>
        <div class="screener-row__metrics">
          <span>5日 ${chg5Sign}${fmt(row.chg5d, 1)}%</span>
          <span>20日 ${chg20Sign}${fmt(row.chg20d, 1)}%</span>
          <span>ボラ比 ${volRatioText}</span>
          <span>終値 ${fmt(row.lastClose)}円</span>
        </div>
      </div>`;
  }

  function renderScreener() {
    if (!screenerRows) return;
    const filtered = screenerRows.filter(screenerRowPasses);
    if (screenerTrendMode === 'po') {
      filtered.sort((a, b) => b.orderScore - a.orderScore || a.code.localeCompare(b.code));
    } else {
      filtered.sort((a, b) => b.sma[screenerSlopePeriod].slopePct - a.sma[screenerSlopePeriod].slopePct);
    }
    screenerCountEl.textContent = `${screenerRows.length}銘柄中 ${filtered.length}銘柄`;
    if (!filtered.length) {
      screenerListEl.innerHTML = '';
      screenerEmptyEl.classList.remove('hidden');
      return;
    }
    screenerEmptyEl.classList.add('hidden');
    screenerListEl.innerHTML = filtered.map(renderScreenerRow).join('');
  }

  async function loadScreenerData() {
    screenerLoadingEl.classList.remove('hidden');
    screenerLoadErrorEl.classList.add('hidden');
    screenerContentEl.classList.remove('hidden');
    try {
      const res = await fetch('/api/screener');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      screenerRows = data.symbols || [];
      renderScreener();
    } catch (err) {
      screenerRows = null;
      screenerContentEl.classList.add('hidden');
      screenerLoadErrorEl.classList.remove('hidden');
      statusText.textContent = `銘柄選定データの取得に失敗しました: ${err.message}`;
    } finally {
      screenerLoadingEl.classList.add('hidden');
    }
  }

  function setScreenerTrendMode(mode) {
    screenerTrendMode = mode;
    screenerTrendModePickerEl.querySelectorAll('.btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    screenerPoRowEl.classList.toggle('hidden', mode !== 'po');
    screenerSlopeRowEl.classList.toggle('hidden', mode !== 'slope');
    if (screenerRows) renderScreener();
  }

  function setScreenerSlopePeriod(period) {
    screenerSlopePeriod = period;
    screenerSlopePeriodPickerEl.querySelectorAll('.btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.period) === period);
    });
    if (screenerRows) renderScreener();
  }

  screenerTrendModePickerEl.querySelectorAll('.btn').forEach((btn) => {
    btn.addEventListener('click', () => { setScreenerTrendMode(btn.dataset.mode); saveScreenerSettings(); });
  });
  screenerSlopePeriodPickerEl.querySelectorAll('.btn').forEach((btn) => {
    btn.addEventListener('click', () => { setScreenerSlopePeriod(Number(btn.dataset.period)); saveScreenerSettings(); });
  });
  [screenerOrderScoreInputEl, screenerMinSlopeInputEl, screenerSurgePctInputEl, screenerVolRatioMaxInputEl].forEach((input) => {
    input.addEventListener('input', () => { if (screenerRows) renderScreener(); });
    input.addEventListener('change', () => saveScreenerSettings());
  });
  screenerSurgeDaysInputEl.addEventListener('change', () => {
    if (screenerRows) renderScreener();
    saveScreenerSettings();
  });
  screenerRefreshBtnEl.addEventListener('click', () => loadScreenerData());
  screenerListEl.addEventListener('click', (e) => {
    const row = e.target.closest('.screener-row');
    if (!row) return;
    chooseSymbol(row.dataset.code);
    selectScreen('chart');
  });

  async function saveScreenerSettings() {
    try {
      await fetch('/api/settings/screener', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trendMode: screenerTrendMode,
          slopePeriod: screenerSlopePeriod,
          orderScoreMin: Number(screenerOrderScoreInputEl.value),
          minSlope: Number(screenerMinSlopeInputEl.value),
          surgeDays: Number(screenerSurgeDaysInputEl.value),
          surgePct: Number(screenerSurgePctInputEl.value),
          volRatioMax: Number(screenerVolRatioMaxInputEl.value),
        }),
      });
    } catch {
      // best-effort — a failed save just means next session falls back to defaults
    }
  }

  // Applies a previously-saved filter blob the same way user interaction
  // would (through the same setters), so DOM state and internal state never
  // diverge. Anything missing or out of range is left at its default.
  function applyScreenerSettings(saved) {
    if (!saved) return;
    if (saved.trendMode === 'po' || saved.trendMode === 'slope') setScreenerTrendMode(saved.trendMode);
    if (SMA_PERIODS.includes(saved.slopePeriod)) setScreenerSlopePeriod(saved.slopePeriod);
    if (Number.isFinite(saved.orderScoreMin)) screenerOrderScoreInputEl.value = saved.orderScoreMin;
    if (Number.isFinite(saved.minSlope)) screenerMinSlopeInputEl.value = saved.minSlope;
    if ([5, 20].includes(saved.surgeDays)) screenerSurgeDaysInputEl.value = saved.surgeDays;
    if (Number.isFinite(saved.surgePct)) screenerSurgePctInputEl.value = saved.surgePct;
    if (Number.isFinite(saved.volRatioMax)) screenerVolRatioMaxInputEl.value = saved.volRatioMax;
  }

  // ---- portfolio screen (ポートフォリオ): the app's landing screen — a
  // "galaxy" view where every symbol with open positions orbits its sector's
  // star system, sized by evaluation value and colored by unrealized P&L%.
  // Uses only data already fetched for other screens (symbols' lastClose +
  // sector, allPositionsByCode from loadAllPositionsSummary), so no new
  // endpoint is needed. Continuously animated, so it's rendered on <canvas>
  // rather than as DOM tiles (the previous treemap version) — the only
  // vendored chart lib (lightweight-charts) has no such support, so this is
  // hand-rolled, same approach as the waterfall panel. ----
  const pfSummaryEl = el('portfolio-summary');
  const pfTreemapWrapEl = el('portfolio-treemap-wrap');
  const pfCanvas = el('portfolio-canvas');
  const pfCtx = pfCanvas.getContext('2d');
  const pfEmptyEl = el('portfolio-empty');
  const pfTotalValueEl = el('pf-total-value');
  const pfTotalCostEl = el('pf-total-cost');
  const pfTotalPnlEl = el('pf-total-pnl');
  const pfSymbolCountEl = el('pf-symbol-count');
  const pfLotCountEl = el('pf-lot-count');

  const pfReduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const PF_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", Meiryo, sans-serif';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function pfLerp(a, b, t) { return a + (b - a) * t; }
  function easeOutBack(t) {
    const c1 = 1.4, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  // Continuous green<->red blend by |pnlPct| magnitude (capped at 12%),
  // using the app's own up/down colors — never a new hue, just this
  // screen's own way of encoding the same P&L that colors lot cards
  // elsewhere in the app. Returns [r,g,b] so callers can mix their own alpha
  // per use (the neon-ring bubble below needs several different opacities
  // from the same base color).
  function pnlRgb(pct) {
    const t = clamp(Math.abs(pct) / 12, 0, 1);
    const up = pct >= 0;
    const dim = up ? [10, 46, 40] : [54, 16, 20];
    const vivid = up ? [8, 153, 129] : [242, 54, 69];
    const bright = up ? [107, 224, 189] : [255, 156, 156];
    const base = dim.map((d, i) => pfLerp(d, vivid[i], t));
    const extra = clamp((t - 0.55) / 0.45, 0, 1) * 0.55;
    return base.map((b, i) => Math.round(pfLerp(b, bright[i], extra)));
  }

  // Shortens text to fit maxWidth by cutting from the end and appending an
  // ellipsis — used only for the name line, which is never skipped outright,
  // just capped so a long company name can't spill arbitrarily far past a
  // small bubble into its neighbors. Assumes ctx.font is already set.
  function truncateToWidth(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }

  // "Neon ring" bubble: a glowing colored ring rather than a filled disc,
  // with just enough inner fill to read as a bubble rather than a hollow
  // circle. Picked over a flat-filled disc (the previous look) and a
  // multi-stop "aurora" glow (prototyped but not this round) for now — see
  // the mockup this was chosen from if reviving the aurora variant later.
  // The ring's glow strength pulses slowly, phase-offset per bubble by its
  // own x position so a whole cluster doesn't visibly breathe in sync.
  function drawBubble(ctx, x, y, r, pct, code, name, scale, t) {
    if (scale <= 0) return;
    const rr = r * scale;
    const [cr, cg, cb] = pnlRgb(pct);
    const pulse = 0.75 + 0.25 * Math.sin(t * 1.6 + x * 0.01);

    const fill = ctx.createRadialGradient(x, y, 0, x, y, rr);
    fill.addColorStop(0, `rgba(${cr},${cg},${cb},0.16)`);
    fill.addColorStop(1, `rgba(${cr},${cg},${cb},0.02)`);
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.save();
    ctx.shadowColor = `rgba(${cr},${cg},${cb},${0.9 * pulse})`;
    ctx.shadowBlur = 22 * pulse * scale;
    ctx.beginPath();
    ctx.arc(x, y, rr * 0.92, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.95)`;
    ctx.lineWidth = Math.max(2.5, rr * 0.085);
    ctx.stroke();
    ctx.restore();

    // crisp inner line for definition even when the glow above is faint
    ctx.beginPath();
    ctx.arc(x, y, rr * 0.92, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Code, name, and P&L% are always drawn, never omitted for a small
    // bubble — font sizes still scale with rr but never below a legible
    // floor, and the three lines are stacked using their own font sizes
    // (not rr) so they can't collapse into each other; a very small bubble
    // just has its label spill past its own edge instead of losing text.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const codeSize = clamp(rr * 0.26, 8, 12);
    const nameSize = clamp(rr * 0.22, 7, 11);
    const pctSize = clamp(rr * 0.3, 9, 14);
    const gap = Math.max(1, rr * 0.05);
    const totalH = codeSize + nameSize + pctSize + gap * 2;
    let cursorY = y - totalH / 2;

    ctx.font = `500 ${codeSize}px ${PF_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText(code, x, cursorY);
    cursorY += codeSize + gap;

    ctx.font = `500 ${nameSize}px ${PF_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    // capped a bit wider than the bubble itself so short names never get
    // clipped needlessly, but a long name truncates instead of spilling
    // arbitrarily far into neighboring bubbles/labels
    ctx.fillText(truncateToWidth(ctx, name, rr * 2.6), x, cursorY);
    cursorY += nameSize + gap;

    ctx.font = `700 ${pctSize}px ${PF_FONT}`;
    ctx.fillStyle = '#fff';
    const sign = pct >= 0 ? '+' : '';
    ctx.fillText(`${sign}${pct.toFixed(1)}%`, x, cursorY);
    ctx.textBaseline = 'alphabetic';
  }

  // Every symbol with at least one open (未決済) lot, valued at the current
  // market price — reuses computeLotsSummary (same P&L math as the chart
  // screen's positions panel) rather than reimplementing it.
  function portfolioHoldings() {
    const holdings = [];
    symbols.forEach((sym) => {
      const openLots = (allPositionsByCode[sym.code] || []).filter((l) => !l.settled);
      if (!openLots.length || sym.lastClose === null || sym.lastClose === undefined) return;
      const cost = openLots.reduce((s, l) => s + l.buyPrice * l.quantity, 0);
      const { pnl, pnlPct } = computeLotsSummary(openLots, sym.lastClose);
      holdings.push({
        code: sym.code, name: sym.name, sector: sym.sector || '未分類', cost, pnl, pnlPct,
        value: cost + pnl, lotCount: openLots.length,
      });
    });
    return holdings;
  }

  let pfLastHoldings = [];
  let pfClusters = null; // null when there's nothing to draw (no open positions)
  let pfStars = null; // built once; positions are stage-fractions so resize needs no rebuild
  const pfParallax = { x: 0, y: 0 };

  // Camera: clicking a sector's star system zooms in until it fills the
  // stage; clicking empty space zooms back out to the whole galaxy. Camera
  // state is in world (pre-transform) units — glides toward pfCameraTarget
  // every frame in drawGalaxyFrame rather than snapping, so the zoom reads
  // as a deliberate "fly to" rather than a jump cut.
  let pfFocusedSector = null; // sector name, or null = full-galaxy view
  let pfCamera = { x: 0, y: 0, scale: 1 };
  let pfCameraTarget = { x: 0, y: 0, scale: 1 };
  let pfCameraInited = false;

  function ensureStarfield() {
    if (pfStars) return;
    pfStars = [];
    for (let s = 0; s < 80; s++) {
      pfStars.push({
        xr: Math.random(), yr: Math.random(),
        r: 0.5 + Math.random() * 1.3,
        phase: Math.random() * Math.PI * 2,
        speed: 0.5 + Math.random() * 1.2,
      });
    }
  }

  // Rebuilds the sector "star systems" for the current holdings/canvas size.
  // Members keep their previous orbit angle when the same code survives a
  // rebuild (e.g. after settling an unrelated lot elsewhere), so the whole
  // galaxy doesn't visibly jump every time the summary refreshes — only a
  // genuinely new holding gets a fresh random angle and a spawn-in animation.
  function layoutGalaxy(holdings, w, h) {
    pfLastHoldings = holdings;
    if (!holdings.length || !w || !h) { pfClusters = null; return; }
    ensureStarfield();

    const prevAngles = {};
    if (pfClusters) {
      pfClusters.forEach((c) => c.members.forEach((m) => { prevAngles[m.hd.code] = m.angle; }));
    }

    const values = holdings.map((hd) => hd.value);
    const minV = Math.min(...values), maxV = Math.max(...values);
    function radiusFor(value, minR, maxR) {
      const t = maxV === minV ? 0.5 : (Math.sqrt(value) - Math.sqrt(minV)) / (Math.sqrt(maxV) - Math.sqrt(minV));
      return pfLerp(minR, maxR, t);
    }

    const bySector = {};
    const order = [];
    holdings.forEach((hd) => {
      if (!bySector[hd.sector]) { bySector[hd.sector] = []; order.push(hd.sector); }
      bySector[hd.sector].push(hd);
    });

    const cx = w / 2, cy = h / 2;
    const ringR = Math.min(w, h) * 0.34;
    const minBubR = Math.min(w, h) * 0.03, maxBubR = Math.min(w, h) * 0.095;
    const nowT = performance.now() / 1000;

    const clusters = order.map((sector, i) => {
      const members = bySector[sector];
      const totalValue = members.reduce((s, m) => s + m.value, 0);
      const angle = (i / order.length) * Math.PI * 2 - Math.PI / 2;
      const jitterR = ringR * (0.82 + (i % 3) * 0.09);
      const members2 = members.map((hd) => ({
        hd,
        r: radiusFor(hd.value, minBubR, maxBubR),
        orbitR: 0,
        angle: prevAngles[hd.code] !== undefined ? prevAngles[hd.code] : Math.random() * Math.PI * 2,
        speed: 0,
        bornAt: prevAngles[hd.code] !== undefined ? null : nowT,
        _x: cx, _y: cy,
      }));
      const baseOrbit = Math.min(w, h) * 0.055;
      members2.sort((a, b) => a.r - b.r);
      let acc = baseOrbit;
      members2.forEach((m) => {
        acc += m.r + 10;
        m.orbitR = acc;
        acc += m.r + 4;
        m.speed = pfReduceMotion ? 0 : (0.22 / Math.sqrt(m.orbitR / 40)) * (Math.random() > 0.5 ? 1 : -1) * 0.6;
      });
      return {
        sector,
        x: cx + Math.cos(angle) * jitterR,
        y: cy + Math.sin(angle) * jitterR * 0.72,
        starR: clamp(Math.sqrt(totalValue) * 0.012, 10, 26),
        members: members2,
      };
    });

    // Relax cluster centers apart so dense sector groups don't overlap into
    // unreadable label soup — same separation technique used to pack
    // symbols within a cluster, just applied to whole clusters using each
    // one's orbital footprint.
    clusters.forEach((c) => {
      let maxReach = 0;
      c.members.forEach((m) => { maxReach = Math.max(maxReach, m.orbitR + m.r); });
      c.footprint = Math.max(c.starR * 2.6, maxReach + 16);
    });
    for (let iter = 0; iter < 240; iter++) {
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const a = clusters[i], b = clusters[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 0.01;
          const minDist = a.footprint + b.footprint + 26;
          if (dist < minDist) {
            const overlap = (minDist - dist) / 2;
            const ux = dx / dist, uy = dy / dist;
            a.x -= ux * overlap; a.y -= uy * overlap * 0.82;
            b.x += ux * overlap; b.y += uy * overlap * 0.82;
          }
        }
      }
      clusters.forEach((c) => {
        c.x += (cx - c.x) * 0.008;
        c.y += (cy - c.y) * 0.008;
        c.x = clamp(c.x, c.footprint + 12, w - c.footprint - 12);
        c.y = clamp(c.y, c.footprint + 12, h - c.footprint - 12);
      });
    }

    pfClusters = clusters;
    pfRefocusCamera(w, h);
  }

  // Scale that makes a cluster's whole orbital footprint fill most of the
  // stage — floor of 1 so "zooming in" never zooms out past the default
  // full-galaxy view, capped so a tiny single-member system doesn't blow up
  // to an absurd size.
  function pfComputeClusterCameraTarget(cluster, w, h) {
    const targetScale = clamp((Math.min(w, h) * 0.42) / cluster.footprint, 1, 6);
    return { x: cluster.x, y: cluster.y, scale: targetScale };
  }

  // Re-derives the camera target after any relayout (data change or
  // resize) — keeps the view locked onto the focused sector's new position
  // if it still exists, otherwise falls back to the full-galaxy view. Only
  // sets the target; the camera itself eases toward it every frame.
  function pfRefocusCamera(w, h) {
    if (pfFocusedSector && pfClusters) {
      const c = pfClusters.find((cl) => cl.sector === pfFocusedSector);
      if (c) {
        pfCameraTarget = pfComputeClusterCameraTarget(c, w, h);
      } else {
        pfFocusedSector = null;
        pfCameraTarget = { x: w / 2, y: h / 2, scale: 1 };
      }
    } else {
      pfCameraTarget = { x: w / 2, y: h / 2, scale: 1 };
    }
    if (!pfCameraInited) {
      pfCamera = { ...pfCameraTarget };
      pfCameraInited = true;
    }
  }

  function drawGalaxyFrame(ctx, w, h, t, dt) {
    const easeK = pfReduceMotion ? 1 : 1 - Math.exp(-dt * 8);
    pfCamera.x += (pfCameraTarget.x - pfCamera.x) * easeK;
    pfCamera.y += (pfCameraTarget.y - pfCamera.y) * easeK;
    pfCamera.scale += (pfCameraTarget.scale - pfCamera.scale) * easeK;

    const px = pfReduceMotion ? 0 : pfParallax.x, py = pfReduceMotion ? 0 : pfParallax.y;

    // Starfield is drawn in screen space, outside the camera transform
    // below — a fixed backdrop the camera flies past rather than a layer
    // that zooms with the foreground clusters, which reads as depth "for
    // free" (nearby clusters move a lot when zooming in, distant stars
    // barely do).
    if (pfStars) {
      pfStars.forEach((st) => {
        const tw = pfReduceMotion ? 0.7 : 0.4 + 0.6 * Math.abs(Math.sin(t * st.speed + st.phase));
        ctx.beginPath();
        ctx.arc(st.xr * w + px * 0.4, st.yr * h + py * 0.4, st.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(209,212,220,${(tw * 0.8).toFixed(2)})`;
        ctx.fill();
      });
    }

    if (!pfClusters) return;

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(pfCamera.scale, pfCamera.scale);
    ctx.translate(-pfCamera.x, -pfCamera.y);

    pfClusters.forEach((c) => {
      const ccx = c.x + px, ccy = c.y + py;
      c.members.forEach((m) => {
        ctx.beginPath();
        ctx.ellipse(ccx, ccy, m.orbitR, m.orbitR * 0.55, 0, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(124,95,224,0.14)';
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      const glow = ctx.createRadialGradient(ccx, ccy, 0, ccx, ccy, c.starR * 2.4);
      glow.addColorStop(0, 'rgba(124,95,224,0.55)');
      glow.addColorStop(1, 'rgba(124,95,224,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(ccx, ccy, c.starR * 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ccx, ccy, c.starR * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.font = `500 10px ${PF_FONT}`;
      ctx.fillStyle = 'rgba(180,168,235,0.9)';
      ctx.fillText(c.sector, ccx, ccy - c.starR * 2.6 - 6);

      c.members.forEach((m) => {
        const age = m.bornAt === null ? 999 : t - m.bornAt;
        const scale = pfReduceMotion ? 1 : clamp(easeOutBack(clamp(age / 0.6, 0, 1)), 0, 1.06);
        m.angle += m.speed * dt;
        const mx = ccx + Math.cos(m.angle) * m.orbitR;
        const my = ccy + Math.sin(m.angle) * m.orbitR * 0.55;
        m._x = mx; m._y = my;
        drawBubble(ctx, mx, my, m.r, m.hd.pnlPct, m.hd.code, m.hd.name, scale, t);
      });
    });

    ctx.restore();
  }

  // Converts a canvas-relative mouse position into the same world-space
  // coordinates cluster/member positions are stored in, undoing the camera
  // transform drawGalaxyFrame applies — every hit-test below works in world
  // space so it stays correct at any zoom level.
  function pfScreenToWorld(sx, sy, w, h) {
    return {
      x: (sx - w / 2) / pfCamera.scale + pfCamera.x,
      y: (sy - h / 2) / pfCamera.scale + pfCamera.y,
    };
  }

  function pfHitTestMember(x, y) {
    if (!pfClusters) return null;
    for (const c of pfClusters) {
      for (const m of c.members) {
        if (Math.hypot(x - m._x, y - m._y) <= m.r) return m.hd.code;
      }
    }
    return null;
  }

  // A click anywhere within a cluster's orbital footprint (but not on a
  // specific member — that takes priority and navigates instead) zooms in
  // on that sector.
  function pfHitTestCluster(x, y) {
    if (!pfClusters) return null;
    for (const c of pfClusters) {
      if (Math.hypot(x - c.x, y - c.y) <= c.footprint) return c;
    }
    return null;
  }

  function pfFocusSector(sector) {
    pfFocusedSector = sector;
    const { w, h } = pfStageSize();
    if (sector && pfClusters) {
      const c = pfClusters.find((cl) => cl.sector === sector);
      if (c) { pfCameraTarget = pfComputeClusterCameraTarget(c, w, h); return; }
    }
    pfCameraTarget = { x: w / 2, y: h / 2, scale: 1 };
  }

  function renderPortfolio() {
    const holdings = portfolioHoldings();
    if (!holdings.length) {
      pfSummaryEl.classList.add('hidden');
      pfTreemapWrapEl.classList.add('hidden');
      pfEmptyEl.classList.remove('hidden');
      layoutGalaxy(holdings, 0, 0);
      return;
    }
    pfSummaryEl.classList.remove('hidden');
    pfTreemapWrapEl.classList.remove('hidden');
    pfEmptyEl.classList.add('hidden');

    const totalValue = holdings.reduce((s, hd) => s + hd.value, 0);
    const totalCost = holdings.reduce((s, hd) => s + hd.cost, 0);
    const totalPnl = totalValue - totalCost;
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    const totalLots = holdings.reduce((s, hd) => s + hd.lotCount, 0);
    const sign = totalPnl > 0 ? '+' : '';

    pfTotalValueEl.textContent = `${fmt(totalValue, 0)}円`;
    pfTotalCostEl.textContent = `${fmt(totalCost, 0)}円`;
    pfTotalPnlEl.textContent = `${sign}${fmt(totalPnl, 0)}円 (${sign}${fmt(totalPnlPct, 1)}%)`;
    pfTotalPnlEl.className = 'stats-summary__value' +
      (totalPnl > 0 ? ' pf-pnl-profit' : totalPnl < 0 ? ' pf-pnl-loss' : '');
    pfSymbolCountEl.textContent = `${holdings.length}銘柄`;
    pfLotCountEl.textContent = `${totalLots}件`;

    const { w, h } = pfStageSize();
    layoutGalaxy(holdings, w, h);
  }

  function pfStageSize() {
    const rect = pfTreemapWrapEl.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
  }

  const pfDpr = Math.min(window.devicePixelRatio || 1, 2);
  function resizePortfolioCanvas() {
    const { w, h } = pfStageSize();
    if (!w || !h) return;
    pfCanvas.width = Math.round(w * pfDpr);
    pfCanvas.height = Math.round(h * pfDpr);
    pfCtx.setTransform(pfDpr, 0, 0, pfDpr, 0, 0);
    layoutGalaxy(pfLastHoldings, w, h);
  }

  // Click priority: a member bubble navigates to its chart, otherwise a
  // click inside a sector's footprint zooms in on it, otherwise (empty
  // space) zooms back out to the full galaxy.
  pfCanvas.addEventListener('pointerdown', (e) => {
    const rect = pfCanvas.getBoundingClientRect();
    const { w, h } = pfStageSize();
    const world = pfScreenToWorld(e.clientX - rect.left, e.clientY - rect.top, w, h);
    const code = pfHitTestMember(world.x, world.y);
    if (code) { chooseSymbol(code); selectScreen('chart'); return; }
    const cluster = pfHitTestCluster(world.x, world.y);
    pfFocusSector(cluster ? cluster.sector : null);
  });
  pfCanvas.addEventListener('pointermove', (e) => {
    const rect = pfCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const { w, h } = pfStageSize();
    pfParallax.x = (x / rect.width - 0.5) * 10;
    pfParallax.y = (y / rect.height - 0.5) * 10;
    const world = pfScreenToWorld(x, y, w, h);
    if (pfHitTestMember(world.x, world.y)) {
      pfCanvas.style.cursor = 'pointer';
    } else if (pfHitTestCluster(world.x, world.y)) {
      pfCanvas.style.cursor = 'zoom-in';
    } else {
      pfCanvas.style.cursor = pfFocusedSector ? 'zoom-out' : 'default';
    }
  });
  pfCanvas.addEventListener('pointerleave', () => {
    pfParallax.x = 0; pfParallax.y = 0;
  });

  let pfResizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(pfResizeTimer);
    pfResizeTimer = setTimeout(resizePortfolioCanvas, 60);
  }).observe(pfTreemapWrapEl);

  // Single persistent animation loop, started once — decoupled from data
  // updates (renderPortfolio only rebuilds pfClusters) so refreshing the
  // summary never restarts or stutters the orbit motion.
  let pfLastFrameTime = performance.now();
  function pfTick(now) {
    const t = now / 1000;
    const dt = Math.min(0.05, (now - pfLastFrameTime) / 1000);
    pfLastFrameTime = now;
    const { w, h } = pfStageSize();
    if (w && h) {
      pfCtx.clearRect(0, 0, w, h);
      drawGalaxyFrame(pfCtx, w, h, t, dt);
    }
    requestAnimationFrame(pfTick);
  }
  requestAnimationFrame(pfTick);

  // ---- dividends screen (配当): annual dividend per share computed from
  // bars/<code>_finance_summary.json (fetched by jquants_api.py alongside
  // price bars), converted to a "monthly wage" for currently-held symbols and
  // shown as a bar that fills over the real calendar month. There's no way
  // to know the exact dividend for the current fiscal year, so the server
  // returns a provisional estimate (see computeDividendForCode in server.js)
  // along with its basis, which this screen displays alongside the amount. ----
  const divTotalMonthlyEl = el('div-total-monthly');
  const divTotalAnnualEl = el('div-total-annual');
  const divTotalAccruedEl = el('div-total-accrued');
  const divSymbolCountEl = el('div-symbol-count');
  const divArcCircleEl = el('div-arc-circle');
  const divArcPctEl = el('div-arc-pct');
  const divListEl = el('dividends-list');
  const divEmptyEl = el('dividends-empty');
  const divRefreshBtnEl = el('dividends-refresh-btn');
  const divLorenzGiniEl = el('lorenz-gini');
  const divLorenzSvgEl = el('lorenz-svg');
  const divSymbolInputEl = el('dividends-symbol-input');
  const divSymbolSuggestionsEl = el('dividends-symbol-suggestions');
  const divQuantityInputEl = el('dividends-quantity-input');
  const divRegisterFormEl = el('dividends-register-form');
  const divRegisterBtnEl = el('dividends-register-btn');
  const divRegisteredListEl = el('dividends-registered-list');

  const DIV_SOURCE_LABELS = {
    actual_annual: '実績',
    actual_quarters: '四半期実績(暫定)',
    forecast_quarters: '予想',
  };

  const DIV_ARC_RADIUS = 56;
  const DIV_ARC_CIRCUMFERENCE = 2 * Math.PI * DIV_ARC_RADIUS;

  let dividendsInitialized = false;
  let dividendsByCode = {}; // shared master data: code -> computed per-share dividend
  let dividendPositionsByCode = {}; // code -> registered quantity, dividend-purpose only (independent of positions/)
  let divHoldings = [];
  let divTileRefs = new Map(); // code -> { fillEl, accruedEl }
  let divTicking = false;
  let divSelectedCode = null;

  // Heatmap tile color: interpolate from a cool dim brown up to the
  // dividend screen's signature gold, with the hottest tiles (weight > 0.72,
  // i.e. close to the largest holding's monthly rate) blending further into a
  // bright highlight so the top contributor visibly stands out.
  function divHeatColor(weight) {
    const cool = [36, 31, 20];
    const hot = [240, 185, 11];
    const hi = [255, 221, 107];
    let c1 = cool, c2 = hot, t = weight / 0.72;
    if (weight > 0.72) { c1 = hot; c2 = hi; t = (weight - 0.72) / 0.28; }
    const mix = c1.map((v, i) => Math.round(v + (c2[i] - v) * t));
    return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
  }

  function divHeatTextColor(weight) {
    return weight > 0.55 ? '#1a1305' : '#f3e9c9';
  }

  // How far into the current real calendar month we are, 0 (midnight on the
  // 1st) to just under 1 (about to roll to the next month) — driving the
  // bar off actual month boundaries (not a fixed 30-day span) so it resets
  // exactly at midnight on the 1st regardless of the month's real length.
  function monthProgress() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    return (now.getTime() - startOfMonth) / (startOfNextMonth - startOfMonth);
  }

  // Every symbol with both a computed per-share dividend (shared master data)
  // and a registered dividend-purpose quantity — independent of positions/,
  // which portfolio/simulation/stats use for short-term trading holdings.
  function dividendHoldings() {
    const holdings = [];
    symbols.forEach((sym) => {
      const div = dividendsByCode[sym.code];
      if (!div) return;
      const qty = dividendPositionsByCode[sym.code] || 0;
      if (qty <= 0) return;
      const monthlyYen = (div.perShare * qty) / 12;
      holdings.push({
        code: sym.code, name: sym.name, perShare: div.perShare, source: div.source, asOf: div.asOf,
        qty, monthlyYen,
      });
    });
    return holdings;
  }

  // Tile area/color encode each holding's monthly rate relative to the
  // largest holding (flex-grow ∝ rate, so wrapping approximates a treemap);
  // each tile also keeps the original per-symbol "fills over the current
  // calendar month" animation as a liquid-fill overlay, so the heatmap still
  // shows live accrual, not just a static relative-size snapshot.
  function renderDividendsList(holdings) {
    divHoldings = holdings;
    divTileRefs = new Map();
    if (!holdings.length) {
      divListEl.innerHTML = '';
      const hasRegistrations = Object.keys(dividendPositionsByCode).length > 0;
      divEmptyEl.textContent = hasRegistrations
        ? '登録済みの銘柄はありますが、配当データがまだ計算できません。jquants_api.pyで銘柄情報を再取得すると'
          + '（bars/配下に<コード>_finance_summary.jsonが生成されます）反映されます。'
        : '配当目的の保有銘柄が登録されていません。下のフォームから登録してください。';
      divEmptyEl.classList.remove('hidden');
      renderDividendLorenz(holdings);
      return;
    }
    divEmptyEl.classList.add('hidden');
    const maxMonthly = Math.max(...holdings.map((h) => h.monthlyYen));
    const sorted = holdings.slice().sort((a, b) => b.monthlyYen - a.monthlyYen);
    divListEl.innerHTML = sorted.map((h) => {
      const weight = maxMonthly > 0 ? h.monthlyYen / maxMonthly : 0;
      const grow = Math.max(h.monthlyYen, 0.15);
      const basis = Math.min(90, weight * 90);
      return `
      <div class="heat-tile" data-code="${h.code}"
           style="background:${divHeatColor(weight)}; color:${divHeatTextColor(weight)};
                  flex-grow:${grow}; flex-basis:${100 + basis}px;">
        <div class="heat-tile__fill" data-code="${h.code}"></div>
        <div class="heat-tile__top">
          <div class="heat-tile__code">${h.code} <span class="heat-tile__name">${h.name}</span></div>
        </div>
        <span class="heat-tile__basis">${DIV_SOURCE_LABELS[h.source] || h.source}（${h.asOf}）</span>
        <div class="heat-tile__bottom">
          <div class="heat-tile__rate">${fmt(h.monthlyYen, 2)}円/月</div>
          <div class="heat-tile__accrued" data-code="${h.code}">0円</div>
        </div>
      </div>`;
    }).join('');
    holdings.forEach((h) => {
      divTileRefs.set(h.code, {
        fillEl: divListEl.querySelector(`.heat-tile__fill[data-code="${h.code}"]`),
        accruedEl: divListEl.querySelector(`.heat-tile__accrued[data-code="${h.code}"]`),
      });
    });
    renderDividendLorenz(holdings);
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVGNS, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  }

  // Lorenz curve of monthly-wage share across holdings (sorted smallest to
  // largest) against the "perfectly equal" diagonal, plus its Gini
  // coefficient — how concentrated the dividend income is in a few symbols,
  // to guide rebalancing toward more even position sizes. Static per
  // holdings snapshot (not tied to tickDividends' per-frame accrual).
  function renderDividendLorenz(holdings) {
    divLorenzSvgEl.innerHTML = '';
    if (holdings.length < 2) {
      divLorenzGiniEl.textContent = '—';
      return;
    }
    const sortedAsc = holdings.slice().sort((a, b) => a.monthlyYen - b.monthlyYen);
    const n = sortedAsc.length;
    const total = sortedAsc.reduce((s, h) => s + h.monthlyYen, 0);

    const pts = [{ x: 0, y: 0 }];
    let cumN = 0, cumV = 0, giniNum = 0;
    sortedAsc.forEach((h, i) => {
      cumN += 1; cumV += h.monthlyYen;
      pts.push({ x: (cumN / n) * 100, y: total > 0 ? (cumV / total) * 100 : 0 });
      giniNum += (i + 1) * h.monthlyYen;
    });
    const gini = total > 0 ? (2 * giniNum) / (n * total) - (n + 1) / n : 0;
    divLorenzGiniEl.textContent = gini.toFixed(2);

    const S = 220, M = 26;
    const plot = S - M * 2;
    const X = (v) => M + (v / 100) * plot;
    const Y = (v) => (S - M) - (v / 100) * plot;

    [0, 25, 50, 75, 100].forEach((t) => {
      divLorenzSvgEl.appendChild(svgEl('line', {
        x1: X(0), x2: X(100), y1: Y(t), y2: Y(t), stroke: 'var(--border)', 'stroke-width': 1,
      }));
    });
    divLorenzSvgEl.appendChild(svgEl('line', { x1: X(0), x2: X(100), y1: Y(0), y2: Y(0), stroke: 'var(--text-muted)' }));
    divLorenzSvgEl.appendChild(svgEl('line', { x1: X(0), x2: X(0), y1: Y(0), y2: Y(100), stroke: 'var(--text-muted)' }));
    divLorenzSvgEl.appendChild(svgEl('line', {
      x1: X(0), y1: Y(0), x2: X(100), y2: Y(100), stroke: 'var(--text-muted)', 'stroke-dasharray': '4,4',
    }));

    const areaD = 'M' + pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(' L') + ` L${X(100)},${Y(0)} L${X(0)},${Y(0)} Z`;
    divLorenzSvgEl.appendChild(svgEl('path', { d: areaD, fill: 'rgba(240,185,11,0.12)' }));

    const curveD = 'M' + pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(' L');
    divLorenzSvgEl.appendChild(svgEl('path', { d: curveD, fill: 'none', stroke: '#f0b90b', 'stroke-width': 2 }));

    function label(x, y, text, anchor) {
      const node = svgEl('text', { x, y, fill: 'var(--text-muted)', 'font-size': 8, 'text-anchor': anchor || 'middle' });
      node.textContent = text;
      divLorenzSvgEl.appendChild(node);
    }
    label(X(0), Y(0) + 12, '0%');
    label(X(100), Y(0) + 12, '銘柄数 100%');
    label(X(0) - 6, Y(100) + 3, '100%', 'end');
    label(X(0) - 6, Y(0) + 3, '0%', 'end');
  }

  // Ticks every 250ms — cheap enough for the handful of symbols this screen
  // realistically has, so no need for the animation-delay/CSS-timeline
  // tricks a busier screen would justify.
  function tickDividends() {
    const progress = monthProgress();

    let totalMonthly = 0, totalAccrued = 0;
    divHoldings.forEach((h) => {
      totalMonthly += h.monthlyYen;
      const accrued = h.monthlyYen * progress;
      totalAccrued += accrued;
      const refs = divTileRefs.get(h.code);
      if (!refs) return;
      refs.fillEl.style.height = `${(progress * 100).toFixed(3)}%`;
      refs.accruedEl.textContent = `${fmt(accrued, 3)}円`;
    });
    divTotalMonthlyEl.innerHTML = divHoldings.length ? `${fmt(totalMonthly, 1)}円<small>/月</small>` : '—円<small>/月</small>';
    divTotalAnnualEl.textContent = divHoldings.length ? `${fmt(totalMonthly * 12, 0)}円` : '—円';
    divTotalAccruedEl.textContent = divHoldings.length ? `${fmt(totalAccrued, 2)}円` : '—円';
    divSymbolCountEl.textContent = divHoldings.length ? `${divHoldings.length}銘柄` : '—';
    divArcPctEl.textContent = `${Math.round(progress * 100)}%`;
    divArcCircleEl.setAttribute('stroke-dashoffset', String(DIV_ARC_CIRCUMFERENCE * (1 - progress)));
  }

  function startDividendsTicking() {
    if (divTicking) return;
    divTicking = true;
    tickDividends();
    setInterval(tickDividends, 250);
  }

  function renderDividendsRegisteredList() {
    const codes = Object.keys(dividendPositionsByCode).sort();
    if (!codes.length) {
      divRegisteredListEl.innerHTML = '<div class="dividends-registered-empty">登録済みの銘柄はありません。</div>';
      return;
    }
    divRegisteredListEl.innerHTML = codes.map((code) => {
      const sym = symbols.find((s) => s.code === code);
      const name = sym ? sym.name : code;
      return `
        <div class="dividends-registered-row">
          <span class="s-code">${code}</span>
          <span class="dividends-registered-row__name">${name}</span>
          <span class="dividends-registered-row__amount">${fmt(dividendPositionsByCode[code], 0)}株</span>
          <button type="button" class="btn dividends-registered-row__delete" data-code="${code}">削除</button>
        </div>`;
    }).join('');
  }

  async function loadDividendsData() {
    try {
      const [divRes, posRes] = await Promise.all([
        fetch('/api/dividends'),
        fetch('/api/dividend-positions'),
      ]);
      if (!divRes.ok) throw new Error(`HTTP ${divRes.status}`);
      if (!posRes.ok) throw new Error(`HTTP ${posRes.status}`);
      dividendsByCode = await divRes.json();
      const { positions } = await posRes.json();
      dividendPositionsByCode = {};
      Object.entries(positions).forEach(([code, lots]) => {
        dividendPositionsByCode[code] = lots.reduce((s, l) => s + l.quantity, 0);
      });
    } catch {
      dividendsByCode = {};
      dividendPositionsByCode = {};
    }
    renderDividendsList(dividendHoldings());
    renderDividendsRegisteredList();
    startDividendsTicking();
  }

  function updateDivRegisterBtn() {
    divRegisterBtnEl.disabled = !(divSelectedCode && Number(divQuantityInputEl.value) > 0);
  }

  const dividendsSymbolSearch = createSymbolSearchBox({
    containerEl: divSymbolInputEl.closest('.search-box'),
    inputEl: divSymbolInputEl,
    suggestionsEl: divSymbolSuggestionsEl,
    onSelect: (code) => {
      divSelectedCode = code;
      updateDivRegisterBtn();
    },
  });

  divQuantityInputEl.addEventListener('input', updateDivRegisterBtn);

  divRegisterFormEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const quantity = Number(divQuantityInputEl.value);
    if (!divSelectedCode || !Number.isFinite(quantity) || quantity <= 0) return;
    await fetch(`/api/dividend-positions/${divSelectedCode}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity }),
    });
    divSymbolInputEl.value = '';
    divQuantityInputEl.value = '';
    divSelectedCode = null;
    updateDivRegisterBtn();
    await loadDividendsData();
  });

  divRegisteredListEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.dividends-registered-row__delete');
    if (!btn) return;
    await fetch(`/api/dividend-positions/${btn.dataset.code}`, { method: 'DELETE' });
    await loadDividendsData();
  });

  divRefreshBtnEl.addEventListener('click', () => loadDividendsData());

  // ---- init ----
  async function init() {
    try {
      const [res, settings] = await Promise.all([fetch('/api/symbols'), fetchAppSettings()]);
      symbols = await res.json();
      applyStatsSettings(settings.stats);
      applyScreenerSettings(settings.screener);
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
