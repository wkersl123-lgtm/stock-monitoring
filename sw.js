// ⚠️ Cloudflare Worker 배포 후 아래 주소를 실제 Worker 주소로 교체하세요.
// 예: https://stock-monitor-proxy.your-subdomain.workers.dev
const WORKER_BASE_URL = 'https://stock-monitoring.wkersl123.workers.dev';

document.addEventListener('DOMContentLoaded', () => {
  const el = {
    tickerInput: document.getElementById('tickerInput'),
    fairValueInput: document.getElementById('fairValueInput'),
    addStockBtn: document.getElementById('addStockBtn'),
    editSelectedBtn: document.getElementById('editSelectedBtn'),
    deleteSelectedBtn: document.getElementById('deleteSelectedBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    selectAllCheckbox: document.getElementById('selectAllCheckbox'),
    stockTableBody: document.getElementById('stockTableBody'),
    helpBtn: document.getElementById('helpBtn'),
    helpModal: document.getElementById('helpModal'),
    closeBtn: document.querySelector('.close-btn')
  };

  let stocks = [];
  let updateTimer = null;
  const domCache = {};

  // --- 저장소: chrome.storage.local → localStorage ---
  const STORAGE_KEY = 'stocks';
  function loadStocks() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }
  function saveStocks(callback) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stocks));
    if (callback) callback();
  }

  // 1. 저장된 주식 데이터 로드
  stocks = loadStocks();
  if (stocks.length > 0) renderTable();

  // 2. 주식 추가 이벤트
  el.addStockBtn.addEventListener('click', () => {
    const ticker = el.tickerInput.value.trim().toUpperCase();
    const fairValue = parseFloat(el.fairValueInput.value);

    if (!ticker || isNaN(fairValue)) return alert('티커와 정확한 적정주가를 입력해주세요.');
    if (stocks.some(s => s.ticker === ticker)) return alert('이미 등록된 티커입니다.');

    stocks.push({ ticker, fairValue });
    saveStocks(() => {
      el.tickerInput.value = '';
      el.fairValueInput.value = '';
      if (el.selectAllCheckbox) el.selectAllCheckbox.checked = false;
      renderTable();
    });
  });

  // 3. 전체 선택/해제 체크박스 이벤트
  if (el.selectAllCheckbox) {
    el.selectAllCheckbox.addEventListener('change', (e) => {
      document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = e.target.checked);
    });
  }

  // 4. 선택 삭제 버튼 이벤트
  el.deleteSelectedBtn.addEventListener('click', () => {
    const rowCheckboxes = document.querySelectorAll('.row-checkbox');
    const indicesToRemove = [];

    rowCheckboxes.forEach(cb => {
      if (cb.checked) indicesToRemove.push(parseInt(cb.getAttribute('data-index')));
    });

    if (indicesToRemove.length === 0) return alert('삭제할 주식을 선택해주세요.');

    if (confirm(`선택한 ${indicesToRemove.length}개의 주식을 삭제하시겠습니까?`)) {
      indicesToRemove.sort((a, b) => b - a).forEach(idx => stocks.splice(idx, 1));
      saveStocks(() => {
        if (el.selectAllCheckbox) el.selectAllCheckbox.checked = false;
        renderTable();
      });
    }
  });

  // 5. 선택 수정 버튼 이벤트
  el.editSelectedBtn.addEventListener('click', () => {
    let editCount = 0;
    document.querySelectorAll('.row-checkbox').forEach(cb => {
      if (cb.checked) {
        const idx = cb.getAttribute('data-index');
        const input = document.querySelector(`.edit-fair-input[data-index="${idx}"]`);
        if (input) {
          input.disabled = false;
          editCount++;
        }
      }
    });

    if (editCount === 0) alert('수정할 주식의 체크박스를 선택한 후 [수정]을 눌러주세요.');
  });

  // 6. 수동 갱신 버튼 이벤트
  if (el.refreshBtn) {
    el.refreshBtn.addEventListener('click', () => {
      if (stocks.length === 0) return;
      el.refreshBtn.innerText = '갱신중...';
      el.refreshBtn.disabled = true;

      Promise.all(stocks.map(stock => fetchYahooData(stock.ticker)))
        .then(() => {
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

  // 6-3. 터치/마우스 드래그로 순서 변경 (Pointer Events - 터치/마우스/펜을 동일하게 처리하므로
  // 안드로이드 터치에서도 확실하게 동작함. 예전 HTML5 draggable 방식은 모바일 브라우저에서
  // 기본 지원되지 않아 동작하지 않았음)
  let dragState = null; // { startIndex, currentIndex, pointerId }

  if (el.stockTableBody) {
    el.stockTableBody.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.drag-icon');
      if (!handle) return;
      e.preventDefault();

      const row = handle.closest('.board-row');
      const startIndex = parseInt(handle.getAttribute('data-index'));
      dragState = { startIndex, currentIndex: startIndex, pointerId: e.pointerId };
      row.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 일부 브라우저는 미지원 - 무시 */ }
    });

    el.stockTableBody.addEventListener('pointermove', (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      e.preventDefault();

      document.querySelectorAll('.board-row').forEach(r => r.classList.remove('drag-over'));

      const rows = Array.from(el.stockTableBody.querySelectorAll('.board-row'));
      for (const r of rows) {
        const rect = r.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          dragState.currentIndex = parseInt(r.getAttribute('data-index'));
          r.classList.add('drag-over');
          break;
        }
      }
    });

    const finishDrag = () => {
      if (!dragState) return;
      const { startIndex, currentIndex } = dragState;
      document.querySelectorAll('.board-row').forEach(r => r.classList.remove('dragging', 'drag-over'));
      dragState = null;

      if (startIndex !== currentIndex) {
        const movedItem = stocks.splice(startIndex, 1)[0];
        stocks.splice(currentIndex, 0, movedItem);
        saveStocks(() => renderTable());
      }
    };

    el.stockTableBody.addEventListener('pointerup', (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      finishDrag();
    });

    el.stockTableBody.addEventListener('pointercancel', () => {
      document.querySelectorAll('.board-row').forEach(r => r.classList.remove('dragging', 'drag-over'));
      dragState = null;
    });
  }

  // 7. 카드 리스트 렌더링 (순서 변경은 위 Pointer Events 드래그 앤 드롭으로 처리)
  function renderTable() {
    if (!el.stockTableBody) return;
    el.stockTableBody.innerHTML = '';

    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }

    for (const key in domCache) delete domCache[key];

    const listCount = document.getElementById('listCount');
    if (listCount) listCount.innerText = stocks.length > 0 ? `${stocks.length}개 종목` : '';

    if (stocks.length === 0) return;

    const fragment = document.createDocumentFragment();

    stocks.forEach((stock, index) => {
      const row = document.createElement('div');
      row.className = 'board-row';
      row.setAttribute('data-index', index);

      row.innerHTML = `
        <span class="board-col-ctrl">
          <input type="checkbox" class="row-checkbox" data-index="${index}">
          <span class="drag-icon" data-index="${index}" aria-label="순서 변경(드래그)">⠿</span>
        </span>
        <span class="board-ticker">${stock.ticker}</span>
        <span class="board-fair">
          <input type="text" class="edit-fair-input" data-index="${index}" value="${stock.fairValue.toFixed(2)}" inputmode="decimal" disabled>
        </span>
        <span class="stat-value cell-price board-num">로딩중</span>
        <span class="stat-value cell-rsi board-num">로딩중</span>
        <span class="stat-value cell-sma board-num">로딩중</span>
        <span class="stat-value cell-earnings board-num">로딩중</span>
      `;

      domCache[stock.ticker] = {
        row: row,
        price: row.querySelector('.cell-price'),
        rsi: row.querySelector('.cell-rsi'),
        sma: row.querySelector('.cell-sma'),
        earnings: row.querySelector('.cell-earnings')
      };

      fragment.appendChild(row);
    });

    el.stockTableBody.appendChild(fragment);

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

    stocks.forEach(stock => fetchYahooData(stock.ticker));
    updateTimer = setInterval(() => {
      stocks.forEach(stock => fetchYahooData(stock.ticker));
    }, 60 * 1000);
  }

  // 8. 데이터 패치 함수 (Cloudflare Worker 프록시 경유)
  async function fetchYahooData(ticker) {
    const cache = domCache[ticker];
    if (!cache) return;

    const chartUrl = `${WORKER_BASE_URL}/chart?ticker=${encodeURIComponent(ticker)}&_=${Date.now()}`;

    try {
      // 1) 차트 / 지표 데이터 수집
      const response = await fetch(chartUrl, { cache: 'no-store' });
      const data = await response.json();

      const result = data?.chart?.result?.[0];
      const rawCloses = result?.indicators?.quote?.[0]?.close;

      if (!result || !rawCloses) {
        cache.price.innerText = '오류'; cache.price.className = 'stat-value cell-price board-num';
        cache.rsi.innerText = '-'; cache.rsi.className = 'stat-value cell-rsi board-num'; cache.rsi.title = '';
        cache.sma.innerText = '-'; cache.sma.className = 'stat-value cell-sma board-num'; cache.sma.title = '';
      } else {
        const prices = rawCloses.filter(p => p !== null);
        const meta = result.meta;
        const currentPrice = meta.regularMarketPrice;

        let previousClose = null;
        if (rawCloses.length > 0) {
          const marketStillOpenToday = rawCloses[rawCloses.length - 1] === null;
          previousClose = marketStillOpenToday
            ? (prices.length > 0 ? prices[prices.length - 1] : null)
            : (prices.length > 1 ? prices[prices.length - 2] : null);
        }
        if (previousClose === null) {
          previousClose = meta.previousClose || meta.chartPreviousClose || null;
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
              cache.price.className = 'stat-value cell-price board-num price-buy-zone';
              cache.price.title = `현재가가 적정가($${targetStock.fairValue.toFixed(2)})보다 낮습니다! (저평가 구간)`;
            } else if (currentPrice > targetStock.fairValue) {
              cache.price.className = 'stat-value cell-price board-num price-high-zone';
              cache.price.title = `현재가가 적정가($${targetStock.fairValue.toFixed(2)})보다 높습니다.`;
            } else {
              cache.price.className = 'stat-value cell-price board-num';
              cache.price.title = "현재가가 적정가와 일치합니다.";
            }
          }
          if (prices.length > 0) prices[prices.length - 1] = currentPrice;
        }

        // RSI 계산 및 툴팁
        if (prices.length > 14) {
          const rsiValue = calculateRSI(prices, 14);
          cache.rsi.innerText = rsiValue.toFixed(2);

          if (rsiValue <= 30) {
            cache.rsi.className = 'stat-value cell-rsi board-num rsi-low';
            cache.rsi.title = "RSI가 30 이하입니다! 침체 구간 (과매도 매수 신호)";
          } else if (rsiValue >= 70) {
            cache.rsi.className = 'stat-value cell-rsi board-num rsi-high';
            cache.rsi.title = "RSI가 70 이상입니다! 과열 구간 (과매수 경계 신호)";
          } else {
            cache.rsi.className = 'stat-value cell-rsi board-num';
            cache.rsi.title = "안정적인 중간 흐름 구간입니다.";
          }
        } else {
          cache.rsi.innerText = '부족';
          cache.rsi.title = "RSI 계산 데이터가 부족합니다.";
        }

        // 200일선 계산 및 툴팁
        if (prices.length >= 200) {
          const sma200 = calculateSMA(prices, 200);
          cache.sma.innerText = `$${sma200.toFixed(2)}`;

          if (currentPrice && currentPrice <= sma200) {
            cache.sma.className = 'stat-value cell-sma board-num sma-buy-zone';
            cache.sma.title = "현재가가 200일 이동평균선 이하입니다! (장기 매수구간)";
          } else {
            cache.sma.className = 'stat-value cell-sma board-num';
            cache.sma.title = "현재가가 200일선 위에 있습니다.";
          }
        } else {
          cache.sma.innerText = `부족 (${prices.length}/200)`;
          cache.sma.title = "200일선 계산을 위한 과거 일수가 부족합니다.";
        }
      }

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
      console.log(`[실적발표일 진단] ${ticker} isRetry=${isRetry} 응답:`, data, 'cache.earnings 요소가 문서에 붙어있는가:', document.body.contains(cache.earnings));

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

        console.log(`[실적발표일 진단] ${ticker} 계산된 날짜: ${year}-${month}-${day}, 쓰기 직전 innerText:`, cache.earnings.innerText);
        cache.earnings.innerText = `${year}-${month}-${day}`;
        cache.earnings.title = '';
        console.log(`[실적발표일 진단] ${ticker} 쓰기 직후 innerText:`, cache.earnings.innerText, ', 실제 화면 텍스트:', document.getElementById('stockTableBody')?.textContent.includes(`${year}-${month}-${day}`));
        return;
      }

      if (!isRetry) {
        // 일시적인 오류일 수 있으니 잠깐 대기 후 한 번만 재시도
        await new Promise(r => setTimeout(r, 700));
        return fetchEarningsFromWorker(ticker, cache, true);
      }

      // 재시도까지 실패한 경우: 이미 정상 날짜가 표시되어 있었다면 그대로 유지 (깜빡임/후퇴 방지)
      const alreadyValid = /^\d{4}-\d{2}-\d{2}$/.test(cache.earnings.innerText);
      console.log(`[실적발표일 진단] ${ticker} 재시도까지 실패. alreadyValid=${alreadyValid}, 현재 innerText:`, cache.earnings.innerText);
      if (!alreadyValid) {
        cache.earnings.innerText = '미정';
        cache.earnings.title = 'Worker에서 실적발표일 데이터를 가져오지 못했습니다.';
      }
    } catch (e) {
      console.log(`[실적발표일 진단] ${ticker} 예외 발생:`, e);
      const alreadyValid = /^\d{4}-\d{2}-\d{2}$/.test(cache.earnings.innerText);
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
