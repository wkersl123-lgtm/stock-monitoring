// ⚠️ Cloudflare Worker 배포 후 아래 주소를 실제 Worker 주소로 교체하세요.
// 예: https://stock-monitor-proxy.your-subdomain.workers.dev
const WORKER_BASE_URL = 'https://stock-monitoring.wkersl123.workers.dev';

// ⚠️ Worker에 등록한 SYNC_SECRET과 반드시 똑같은 값으로 맞춰주세요.
// (PWA와 크롬 확장프로그램 코드 양쪽 다 이 값이 일치해야 서로 동기화됩니다)
const SYNC_KEY = 'YOUR-OWN-SECRET-PASSPHRASE';

document.addEventListener('DOMContentLoaded', () => {
  const el = {
    tickerInput: document.getElementById('tickerInput'),
    fairValueInput: document.getElementById('fairValueInput'),
    addStockBtn: document.getElementById('addStockBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    holdingsBody: document.getElementById('holdingsBody'),
    watchBody: document.getElementById('watchBody'),
    holdingsWrap: document.getElementById('holdingsWrap'),
    watchWrap: document.getElementById('watchWrap'),
    boardsWrapper: document.getElementById('boardsWrapper'),
    helpBtn: document.getElementById('helpBtn'),
    helpModal: document.getElementById('helpModal'),
    closeBtn: document.querySelector('.close-btn'),
    earningsModal: document.getElementById('earningsModal'),
    earningsCloseBtn: document.getElementById('earningsCloseBtn'),
    earningsModalTicker: document.getElementById('earningsModalTicker'),
    earningsModalBody: document.getElementById('earningsModalBody')
  };

  let stocks = [];
  let updateTimer = null;
  const domCache = {};

  // --- 로컬 저장소: localStorage (오프라인에서도 즉시 로딩되는 캐시 역할) ---
  const STORAGE_KEY = 'stocks';
  function loadStocks() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      // 기존에 저장된 데이터(카테고리 없음)는 관심 종목으로 마이그레이션
      return parsed.map(s => ({ category: 'watch', ...s }));
    } catch (e) {
      return [];
    }
  }
  function saveLocalOnly() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stocks));
  }
  function saveStocks(callback) {
    saveLocalOnly();
    if (callback) callback();
    syncPush(); // 서버(Worker)에도 반영해서 다른 기기와 동기화
  }

  // --- 서버 동기화: Cloudflare Worker + KV를 거쳐 PWA/확장프로그램이 같은 목록을 공유 ---
  async function syncPull() {
    try {
      const res = await fetch(`${WORKER_BASE_URL}/sync`, {
        headers: { 'X-Sync-Key': SYNC_KEY },
        cache: 'no-store'
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.stocks) ? data.stocks : null; // null = 서버에 아직 저장된 게 없음
    } catch (e) {
      return null; // 오프라인이거나 Worker 연결 실패 - 로컬 데이터로 계속 진행
    }
  }

  async function syncPush() {
    try {
      await fetch(`${WORKER_BASE_URL}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
        body: JSON.stringify({ stocks })
      });
    } catch (e) {
      // 오프라인이면 무시 - 로컬엔 이미 저장돼 있고, 다음 저장 시점에 다시 시도됨
    }
  }

  // 1. 저장된 주식 데이터 로드: 로컬 캐시로 먼저 빠르게 그린 뒤, 서버 최신본으로 갱신
  stocks = loadStocks();
  if (stocks.length > 0) renderTable();

  syncPull().then((serverStocks) => {
    if (serverStocks) {
      stocks = serverStocks.map(s => ({ category: 'watch', ...s }));
      saveLocalOnly(); // 서버 → 로컬 캐시만 갱신 (다시 서버로 밀어올리지 않음)
      renderTable();
    } else if (stocks.length > 0) {
      // 서버에 아직 데이터가 없는데(첫 사용) 로컬엔 있는 경우 - 서버에 최초 업로드
      syncPush();
    }
  });

  // 2. 주식 추가 이벤트
  el.addStockBtn.addEventListener('click', () => {
    const ticker = el.tickerInput.value.trim().toUpperCase();
    const fairValue = parseFloat(el.fairValueInput.value);

    if (!ticker || isNaN(fairValue)) return alert('티커와 정확한 적정주가를 입력해주세요.');
    if (stocks.some(s => s.ticker === ticker)) return alert('이미 등록된 티커입니다.');

    stocks.push({ ticker, fairValue, category: 'watch' });
    saveStocks(() => {
      el.tickerInput.value = '';
      el.fairValueInput.value = '';
      renderTable();
    });
  });

  // 6. 수동 갱신 버튼 이벤트
  if (el.refreshBtn) {
    el.refreshBtn.addEventListener('click', () => {
      if (stocks.length === 0) return;
      el.refreshBtn.innerText = '갱신중...';
      el.refreshBtn.disabled = true;

      Promise.all(stocks.map((stock, i) =>
        new Promise((resolve) => {
          setTimeout(() => fetchYahooData(stock.ticker).finally(resolve), i * 150);
        })
      )).then(() => {
        el.refreshBtn.innerText = '갱신';
        el.refreshBtn.disabled = false;
      });
    });
  }

  // 6-2. 도움말 모달 제어 이벤트
  if (el.helpBtn && el.helpModal && el.closeBtn) {
    el.helpBtn.addEventListener('click', () => { el.helpModal.style.display = 'block'; });
    el.closeBtn.addEventListener('click', () => { el.helpModal.style.display = 'none'; });
    window.addEventListener('click', (e) => {
      if (e.target === el.helpModal) el.helpModal.style.display = 'none';
    });
  }

  // 6-2-2. 직전 분기 실적 모달 제어 이벤트
  if (el.earningsModal && el.earningsCloseBtn) {
    el.earningsCloseBtn.addEventListener('click', () => { el.earningsModal.style.display = 'none'; });
    window.addEventListener('click', (e) => {
      if (e.target === el.earningsModal) el.earningsModal.style.display = 'none';
    });
  }

  function formatRevenue(n) {
    if (n === null || n === undefined) return '-';
    if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    return `$${n.toLocaleString()}`;
  }

  function openEarningsModal(ticker) {
    if (!el.earningsModal) return;
    const cache = domCache[ticker];
    const last = cache && cache.lastEarnings;

    el.earningsModalTicker.innerText = `${ticker} · 직전 분기 실적`;

    if (!last) {
      el.earningsModalBody.innerHTML = `<p class="earnings-empty">아직 직전 분기 실적 데이터를 불러오지 못했어요. 갱신 후 다시 눌러주세요.</p>`;
      el.earningsModal.style.display = 'block';
      return;
    }

    const epsEst = last.epsEstimate;
    const epsAct = last.epsActual;
    const revEst = last.revenueEstimate;
    const revAct = last.revenueActual;

    const epsBeat = (typeof epsEst === 'number' && typeof epsAct === 'number') ? epsAct - epsEst : null;
    const epsBeatPct = (epsBeat !== null && epsEst) ? (epsBeat / Math.abs(epsEst)) * 100 : null;
    const epsClass = epsBeat === null ? '' : (epsBeat >= 0 ? 'text-buy' : 'text-sell');

    const revBeat = (typeof revEst === 'number' && typeof revAct === 'number') ? revAct - revEst : null;
    const revClass = revBeat === null ? '' : (revBeat >= 0 ? 'text-buy' : 'text-sell');

    el.earningsModalBody.innerHTML = `
      <p class="earnings-date">발표일: ${last.date}</p>
      <div class="earnings-row">
        <span class="earnings-label">EPS</span>
        <span class="earnings-value">
          예상 ${typeof epsEst === 'number' ? '$' + epsEst.toFixed(2) : '-'}
          → 실제 <b class="${epsClass}">${typeof epsAct === 'number' ? '$' + epsAct.toFixed(2) : '-'}</b>
          ${epsBeatPct !== null ? `<span class="${epsClass}">(${epsBeatPct >= 0 ? '+' : ''}${epsBeatPct.toFixed(1)}%)</span>` : ''}
        </span>
      </div>
      <div class="earnings-row">
        <span class="earnings-label">매출</span>
        <span class="earnings-value">
          예상 ${formatRevenue(revEst)}
          → 실제 <b class="${revClass}">${formatRevenue(revAct)}</b>
        </span>
      </div>
    `;
    el.earningsModal.style.display = 'block';
  }

  // 6-3. 터치/마우스 드래그로 순서 변경 + 섹션(보유/관심) 간 자유로운 이동 (Pointer Events -
  // 터치/마우스/펜을 동일하게 처리하므로 안드로이드 터치에서도 확실하게 동작함)
  let dragState = null; // { startIndex, currentIndex, pointerId, hoverCategory }

  function categoryOf(stock) {
    return stock.category === 'holding' ? 'holding' : 'watch';
  }

  function sectionAtPoint(clientY) {
    if (el.holdingsWrap) {
      const r = el.holdingsWrap.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return 'holding';
    }
    if (el.watchWrap) {
      const r = el.watchWrap.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return 'watch';
    }
    return null;
  }

  function clearDragVisuals() {
    document.querySelectorAll('.stock-tile').forEach(r => r.classList.remove('dragging', 'drag-over'));
    if (el.holdingsWrap) el.holdingsWrap.classList.remove('section-drop-target');
    if (el.watchWrap) el.watchWrap.classList.remove('section-drop-target');
  }

  if (el.boardsWrapper) {
    el.boardsWrapper.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.drag-icon');
      if (!handle) return;
      e.preventDefault();

      const row = handle.closest('.stock-tile');
      const startIndex = parseInt(handle.getAttribute('data-index'));
      dragState = { startIndex, currentIndex: startIndex, pointerId: e.pointerId, hoverCategory: categoryOf(stocks[startIndex]) };
      row.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 일부 브라우저는 미지원 - 무시 */ }
    });

    el.boardsWrapper.addEventListener('pointermove', (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      e.preventDefault();

      const hoverCategory = sectionAtPoint(e.clientY);
      dragState.hoverCategory = hoverCategory;

      document.querySelectorAll('.stock-tile').forEach(r => r.classList.remove('drag-over'));
      if (el.holdingsWrap) el.holdingsWrap.classList.toggle('section-drop-target', hoverCategory === 'holding');
      if (el.watchWrap) el.watchWrap.classList.toggle('section-drop-target', hoverCategory === 'watch');

      if (hoverCategory) {
        const container = hoverCategory === 'holding' ? el.holdingsBody : el.watchBody;
        const rows = container ? Array.from(container.querySelectorAll('.stock-tile')) : [];
        for (const r of rows) {
          const rect = r.getBoundingClientRect();
          if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
            dragState.currentIndex = parseInt(r.getAttribute('data-index'));
            r.classList.add('drag-over');
            break;
          }
        }
      }
    });

    const finishDrag = () => {
      if (!dragState) return;
      const { startIndex, currentIndex, hoverCategory } = dragState;
      clearDragVisuals();
      dragState = null;

      if (!hoverCategory) return; // 어느 섹션 위에도 놓지 않았으면 취소

      const item = stocks[startIndex];
      const originCategory = categoryOf(item);

      if (originCategory !== hoverCategory) {
        // 다른 섹션으로 이동: 카테고리 변경 후 해당 섹션 맨 끝으로 이동
        stocks.splice(startIndex, 1);
        item.category = hoverCategory;
        stocks.push(item);
        saveStocks(() => renderTable());
      } else if (startIndex !== currentIndex) {
        // 같은 섹션 내 순서 변경
        const movedItem = stocks.splice(startIndex, 1)[0];
        stocks.splice(currentIndex, 0, movedItem);
        saveStocks(() => renderTable());
      }
    };

    el.boardsWrapper.addEventListener('pointerup', (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      finishDrag();
    });

    el.boardsWrapper.addEventListener('pointercancel', () => {
      clearDragVisuals();
      dragState = null;
    });
  }

  // 7. 카드 리스트 렌더링 (순서 변경은 위 Pointer Events 드래그 앤 드롭으로 처리)
  function renderTable() {
    if (!el.holdingsBody || !el.watchBody) return;
    el.holdingsBody.innerHTML = '';
    el.watchBody.innerHTML = '';

    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }

    for (const key in domCache) delete domCache[key];

    const holdingCount = stocks.filter(s => s.category === 'holding').length;
    const watchCount = stocks.filter(s => s.category !== 'holding').length;
    const listCount = document.getElementById('listCount');
    if (listCount) {
      listCount.innerText = stocks.length > 0 ? `보유 ${holdingCount} · 관심 ${watchCount}` : '';
    }

    if (stocks.length === 0) return;

    const holdingsFragment = document.createDocumentFragment();
    const watchFragment = document.createDocumentFragment();

    stocks.forEach((stock, index) => {
      const isHolding = stock.category === 'holding';
      const row = document.createElement('div');
      row.className = 'stock-tile';
      row.setAttribute('data-index', index);

      row.innerHTML = `
        <div class="tile-top">
          <span class="drag-icon" data-index="${index}" aria-label="순서 변경(드래그)">⠿</span>
          <div class="tile-actions">
            <button type="button" class="tile-edit-btn" data-index="${index}" aria-label="적정가 수정"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.9 3.6l3.5 3.5-9.6 9.6-4 .9.9-4z"/></svg></button>
            <button type="button" class="tile-delete-btn" data-index="${index}" aria-label="삭제">🗑</button>
          </div>
        </div>
        <div class="tile-ticker">${stock.ticker}</div>
        <div class="tile-price cell-price">로딩중</div>
        <div class="tile-meta">
          <div class="meta-row"><span>RSI</span><span class="cell-rsi">-</span></div>
          <div class="meta-row"><span>200D</span><span class="cell-sma">-</span></div>
          <div class="meta-row"><span>실적일</span><span class="cell-earnings">-</span></div>
          <div class="meta-row">
            <span>적정</span>
            <input type="text" class="edit-fair-input" data-index="${index}" value="${stock.fairValue.toFixed(2)}" inputmode="decimal" disabled>
          </div>
        </div>
      `;

      row.querySelector('.tile-edit-btn').addEventListener('click', () => {
        const input = row.querySelector('.edit-fair-input');
        if (input.disabled) {
          input.disabled = false;
          input.focus();
          input.select();
        } else {
          input.blur(); // blur 핸들러가 저장 처리
        }
      });

      row.querySelector('.tile-delete-btn').addEventListener('click', () => {
        if (confirm(`${stock.ticker}을(를) 삭제하시겠습니까?`)) {
          stocks.splice(index, 1);
          saveStocks(() => renderTable());
        }
      });

      // 타일 탭/클릭 시 직전 분기 실적 모달 오픈 (드래그 손잡이/수정/삭제/입력창 클릭은 제외)
      row.addEventListener('click', (e) => {
        if (e.target.closest('.drag-icon, .tile-edit-btn, .tile-delete-btn, .edit-fair-input')) return;
        openEarningsModal(stock.ticker);
      });

      domCache[stock.ticker] = {
        row: row,
        price: row.querySelector('.cell-price'),
        rsi: row.querySelector('.cell-rsi'),
        sma: row.querySelector('.cell-sma'),
        earnings: row.querySelector('.cell-earnings'),
        fairInput: row.querySelector('.edit-fair-input')
      };

      (isHolding ? holdingsFragment : watchFragment).appendChild(row);
    });

    el.holdingsBody.appendChild(holdingsFragment);
    el.watchBody.appendChild(watchFragment);

    if (holdingCount === 0) {
      el.holdingsBody.innerHTML = '<div class="board-empty">보유 종목이 없습니다.</div>';
    }
    if (watchCount === 0) {
      el.watchBody.innerHTML = '<div class="board-empty">관심 종목이 없습니다.</div>';
    }

    document.querySelectorAll('.edit-fair-input').forEach(input => {
      input.addEventListener('input', e => e.target.value = e.target.value.replace(/[^0-9.]/g, ''));
      input.addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
      input.addEventListener('blur', e => {
        const idx = e.target.getAttribute('data-index');
        const newValue = parseFloat(e.target.value);

        if (isNaN(newValue) || newValue < 0) {
          alert('올바른 적정주가를 입력해주세요.');
          e.target.value = stocks[idx].fairValue.toFixed(2);
          e.target.disabled = true;
          return;
        }

        stocks[idx].fairValue = newValue;
        e.target.value = newValue.toFixed(2);
        e.target.disabled = true;

        saveStocks(() => fetchYahooData(stocks[idx].ticker));
      });
    });

    fetchAllStaggered();
    updateTimer = setInterval(fetchAllStaggered, 60 * 1000);
  }

  // 종목이 많을 때 한꺼번에 요청이 몰려 rate limit에 걸리지 않도록 살짝 시간차를 두고 순차 발사
  function fetchAllStaggered() {
    stocks.forEach((stock, i) => {
      setTimeout(() => fetchYahooData(stock.ticker), i * 150);
    });
  }

  // 8. 데이터 패치 함수 (Cloudflare Worker 프록시 경유)
  async function fetchYahooData(ticker) {
    const cache = domCache[ticker];
    if (!cache) return;

    // 타일 배경색: 저평가 / RSI 과열·과매도 / 200일선 이탈 조건을 종합해서 결정 (우선순위 적용)
    let isBuyZone = false, isRsiHigh = false, isRsiLow = false, isSmaZone = false;

    const chartUrl = `${WORKER_BASE_URL}/chart?ticker=${encodeURIComponent(ticker)}&_=${Date.now()}`;

    try {
      // 1) 차트 / 지표 데이터 수집
      const response = await fetch(chartUrl, { cache: 'no-store' });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.includes('application/json')) {
        throw new Error(`차트 응답 이상 (status ${response.status})`);
      }
      const data = await response.json();

      const result = data?.chart?.result?.[0];
      const rawCloses = result?.indicators?.quote?.[0]?.close;

      if (!result || !rawCloses) {
        cache.price.innerText = '오류';
        cache.rsi.innerText = '-'; cache.rsi.title = '';
        cache.sma.innerText = '-'; cache.sma.title = '';
      } else {
        const prices = rawCloses.filter(p => p !== null);
        const meta = result.meta;
        const currentPrice = meta.regularMarketPrice; // 장중엔 실시간가, 장마감 후엔 종가로 야후가 자동 전환

        // 전일 종가: null을 걸러낸 종가 배열에서 "가장 최근(오늘) 바로 앞" 값을 그대로 사용.
        // 날짜 문자열을 비교해서 "오늘 봉"을 가려내던 방식은 타임존 경계에서 미묘하게 어긋날 수 있어 제거함.
        let previousClose = prices.length > 1 ? prices[prices.length - 2] : null;
        if (previousClose === null) {
          previousClose = meta.previousClose || null;
        }

        // 안전장치: 계산될 등락률이 비정상적으로 크면(하루 만에 ±20%를 넘는 급등락은 극히 드묾)
        // 데이터가 잘못 짝지어졌다고 보고 meta.previousClose로 다시 시도
        if (previousClose && currentPrice) {
          const testChangePercent = Math.abs((currentPrice - previousClose) / previousClose) * 100;
          if (testChangePercent > 20 && meta.previousClose && meta.previousClose !== previousClose) {
            previousClose = meta.previousClose;
          }
        }

        // 현재가 렌더링
        if (currentPrice) {
          let changeHtml = '';
          if (previousClose) {
            const changePercent = ((currentPrice - previousClose) / previousClose) * 100;
            const isUp = changePercent > 0;
            const isDown = changePercent < 0;
            const changeClass = isUp ? 'change-up' : (isDown ? 'change-down' : 'change-flat');
            const changeSign = isUp ? '▲' : (isDown ? '▼' : '');

            changeHtml = `<br><span class="price-change-percent ${changeClass}">${changeSign}${Math.abs(changePercent).toFixed(2)}%</span>`;
          } else {
            changeHtml = `<br><span class="price-change-percent change-flat">-%</span>`;
          }

          cache.price.innerHTML = `<span class="current-price-val">$${currentPrice.toFixed(2)}</span>${changeHtml}`;

          const targetStock = stocks.find(s => s.ticker === ticker);
          if (targetStock) {
            if (currentPrice < targetStock.fairValue) {
              isBuyZone = true;
              cache.price.title = `현재가가 적정가($${targetStock.fairValue.toFixed(2)})보다 낮습니다! (저평가 구간)`;
            } else if (currentPrice > targetStock.fairValue) {
              cache.price.title = `현재가가 적정가($${targetStock.fairValue.toFixed(2)})보다 높습니다.`;
            } else {
              cache.price.title = "현재가가 적정가와 일치합니다.";
            }
            if (cache.fairInput) cache.fairInput.classList.toggle('text-buy-zone', isBuyZone);
          }
          if (prices.length > 0) prices[prices.length - 1] = currentPrice;
        }

        // RSI 계산 및 툴팁 (글자 색 + 타일 배경 둘 다에 반영)
        if (prices.length > 14) {
          const rsiValue = calculateRSI(prices, 14);
          cache.rsi.innerText = rsiValue.toFixed(2);
          cache.rsi.classList.remove('text-rsi-high', 'text-rsi-low');

          if (rsiValue <= 30) {
            isRsiLow = true;
            cache.rsi.classList.add('text-rsi-low');
            cache.rsi.title = "RSI가 30 이하입니다! 침체 구간 (과매도 매수 신호)";
          } else if (rsiValue >= 70) {
            isRsiHigh = true;
            cache.rsi.classList.add('text-rsi-high');
            cache.rsi.title = "RSI가 70 이상입니다! 과열 구간 (과매수 경계 신호)";
          } else {
            cache.rsi.title = "안정적인 중간 흐름 구간입니다.";
          }
        } else {
          cache.rsi.innerText = '부족';
          cache.rsi.title = "RSI 계산 데이터가 부족합니다.";
        }

        // 200일선 계산 및 툴팁 (글자 색 + 타일 배경 둘 다에 반영)
        if (prices.length >= 200) {
          const sma200 = calculateSMA(prices, 200);
          cache.sma.innerText = `$${sma200.toFixed(2)}`;
          cache.sma.classList.remove('text-sma-zone');

          if (currentPrice && currentPrice <= sma200) {
            isSmaZone = true;
            cache.sma.classList.add('text-sma-zone');
            cache.sma.title = "현재가가 200일 이동평균선 이하입니다! (장기 매수구간)";
          } else {
            cache.sma.title = "현재가가 200일선 위에 있습니다.";
          }
        } else {
          cache.sma.innerText = `부족 (${prices.length}/200)`;
          cache.sma.title = "200일선 계산을 위한 과거 일수가 부족합니다.";
        }
      }

      // 타일 전체 배경: 저평가 + RSI 과매도(30 이하) + 200일선 이탈이 동시에 전부 충족될 때만 강조
      const isTripleSignal = isBuyZone && isRsiLow && isSmaZone;
      cache.row.classList.toggle('tile-triple-signal', isTripleSignal);

      // 2) 실적발표일 (Worker가 crumb 인증까지 처리한 결과를 받음)
      await fetchEarningsFromWorker(ticker, cache);

    } catch (error) {
      console.error(error);
      cache.price.innerText = '에러';
      cache.rsi.innerText = '에러';
      cache.sma.innerText = '에러';
      cache.earnings.innerText = '에러';
    }
  }

  // 실적발표일: Worker의 /earnings 엔드포인트 호출 (crumb/쿠키 인증은 Worker가 서버 사이드에서 처리)
  // Finnhub 무료 티어의 일시적인 지연/오류로 간헐적으로 실패할 수 있어 1회 재시도하고,
  // 그래도 실패하면 이전에 이미 확인된 정상 날짜가 있는 경우 덮어쓰지 않고 그대로 유지함
  async function fetchEarningsFromWorker(ticker, cache, isRetry = false) {
    try {
      const res = await fetch(`${WORKER_BASE_URL}/earnings?ticker=${encodeURIComponent(ticker)}&_=${Date.now()}`, { cache: 'no-store' });
      const data = await res.json();
      const timestamp = typeof data?.timestamp === 'number' ? data.timestamp : null;

      // 직전 분기 실적(EPS/매출 예상 vs 실제)은 타일 탭 시 보여줄 용도로 캐시에 저장
      if (data?.last) cache.lastEarnings = data.last;

      if (timestamp) {
        let earnDate = new Date(timestamp * 1000);

        // 미국 날짜 기준으로 오는 값이라 한국 날짜와 하루 어긋남 - 보정
        earnDate.setDate(earnDate.getDate() + 1);

        const now = new Date();

        // 실적발표가 이미 끝났다면 다음 분기(3개월 뒤) 일정으로 자동 업데이트
        while (earnDate < now) {
          earnDate.setMonth(earnDate.getMonth() + 3);
        }

        const year = earnDate.getFullYear();
        const month = String(earnDate.getMonth() + 1).padStart(2, '0');
        const day = String(earnDate.getDate()).padStart(2, '0');
        const fullDateStr = `${year}-${month}-${day}`;

        // D-day 카운트다운 계산 (자정 기준 날짜 차이만 비교)
        const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const earnMid = new Date(earnDate.getFullYear(), earnDate.getMonth(), earnDate.getDate());
        const diffDays = Math.round((earnMid - todayMid) / (1000 * 60 * 60 * 24));
        const dDayText = diffDays <= 0 ? 'D-DAY' : `D-${diffDays}`;

        cache.earnings.innerText = dDayText;
        cache.earnings.title = `실적발표 예정일: ${fullDateStr}`;
        return;
      }

      if (!isRetry) {
        // 일시적인 오류일 수 있으니 잠깐 대기 후 한 번만 재시도
        await new Promise(r => setTimeout(r, 700));
        return fetchEarningsFromWorker(ticker, cache, true);
      }

      // 재시도까지 실패한 경우: 이미 정상 값이 표시되어 있었다면 그대로 유지 (깜빡임/후퇴 방지)
      const alreadyValid = /^D-(DAY|\d+)$/.test(cache.earnings.innerText);
      if (!alreadyValid) {
        cache.earnings.innerText = '미정';
        cache.earnings.title = 'Worker에서 실적발표일 데이터를 가져오지 못했습니다.';
      }
    } catch (e) {
      const alreadyValid = /^D-(DAY|\d+)$/.test(cache.earnings.innerText);
      if (!alreadyValid) {
        cache.earnings.innerText = '미정';
        cache.earnings.title = 'Worker 연결에 실패했습니다.';
      }
    }
  }

  function calculateRSI(prices, period = 14) {
    let gains = [], losses = [];
    for (let i = 1; i < prices.length; i++) {
      const diff = prices[i] - prices[i - 1];
      gains.push(diff > 0 ? diff : 0);
      losses.push(diff < 0 ? Math.abs(diff) : 0);
    }
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < gains.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    return avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }

  function calculateSMA(prices, period = 200) {
    let sum = 0;
    const len = prices.length;
    for (let i = len - period; i < len; i++) sum += prices[i];
    return sum / period;
  }
});

// --- 서비스워커 등록 (오프라인 지원 및 "홈 화면에 추가" 설치 가능하게 함) ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.error('SW 등록 실패:', err));
  });
}
