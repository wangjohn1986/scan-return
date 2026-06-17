/* 未取貨助手 PWA — 手機掃描物流編號，回報未取貨明細到 LINE 群組
   - 模式 A：即時掃二維碼（BarcodeDetector，後備 jsQR）
   - 模式 B：拍照／選照片「批次 OCR」——一張整張清單一次抓出所有 TW＋13 碼
   - 掃到/辨識→存 IndexedDB（防重掃）→「上傳至 LINE」經中繼讓機器人推到群組
*/
const $ = (id) => document.getElementById(id);
const RE_TW = /^TW[A-Za-z0-9]{13}$/;                    // 模式B（拍照OCR）：TW+13，共15字
const RE_QR = /^[\d\s-]+$/;                             // 模式A（即時掃QR）：內容須純數字(可含連字號/空白)，取後8碼當交易序號
const LS_RELAY = 'sr_relay', LS_KEY = 'sr_key';
// 內建預設（免每台手機手動設定；可在 ⚙ 覆寫）
const DEFAULT_RELAY = 'https://script.google.com/macros/s/AKfycbx7iFTntfKD26-dLDndTPqZMPNsBY5QISXcopbLk2knpHLxOb2Jcr4IhQFr3in3pUKiUA/exec';
const DEFAULT_KEY = '1234';
// （音效設定已移除；提示音固定「上升鈴」、音量由手機調整）

let mode = 'A';
let stream = null, scanning = false, lastHitAt = 0, bd = null;
let ocrWorker = null;
let cropImg = null, cropScale = 1, sel = null, dragging = false, cropStart = { x: 0, y: 0 }; // A 框選欄位狀態
let actx = null;
let db = null;
const seen = new Set();

const video = $('video');
const canvas = $('frame-canvas');
const cctx = canvas.getContext('2d', { willReadFrequently: true });

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('returns-db', 3);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'code' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const store = (m) => db.transaction('records', m).objectStore('records');
function dbAll() { return new Promise((res) => { const out = []; const c = store('readonly').openCursor(); c.onsuccess = (e) => { const cur = e.target.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out); }; }); }
function dbAdd(rec) { return new Promise((res, rej) => { const r = store('readwrite').add(rec); r.onsuccess = () => res(true); r.onerror = () => rej(r.error); }); }
function dbDel(code) { return new Promise((res) => { store('readwrite').delete(code).onsuccess = () => res(); }); }
function dbClear() { return new Promise((res) => { store('readwrite').clear().onsuccess = () => res(); }); }

/* ---------- 收集（含防重掃） ---------- */
async function addCode(raw, m) {
  const code = (raw || '').trim();
  if (!code) return false;
  if (seen.has(code)) return false;
  try { await dbAdd({ code, mode: m, ts: nowStr() }); seen.add(code); return true; } catch (e) { return false; }
}
// 從 QR 內容取「後8碼純數字」當交易序號（例 "0350000-11318691" 或 "035000011318691" → "11318691"）
function extractOneQR(raw) {
  const s = (raw || '').trim();
  if (!s || !RE_QR.test(s)) return null;    // 排除網址/含字母等非預期內容
  const digits = s.replace(/\D/g, '');      // 去掉連字號/空白，只留數字
  if (digits.length < 8) return null;
  return digits.slice(-8);                   // 取後8碼（= USale 交易序號 TxnNum）
}
// 模式 A 即時掃：單筆，含節流與音效
async function addCodeLive(raw) {
  if (Date.now() - lastHitAt < 1200) return;
  lastHitAt = Date.now();
  const code = extractOneQR(raw);
  if (!code) { flashFrame('err'); beep(false); toast('QR 格式不符（需數字QR，取後8碼）', true); return; }
  if (seen.has(code)) { flashFrame('err'); beep(false); toast('重複，已略過：' + code, true); return; }
  if (await addCode(code, 'A')) { flashFrame('ok'); beep(true); toast('✅ ' + code); render(); }
}

/* ---------- 模式 A：即時鏡頭 ---------- */
async function startCamera(auto) {
  try {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) {}
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream; await video.play();
    $('start-cam').hidden = true;
    scanning = true; loop();
  } catch (e) {
    // 自動嘗試失敗（iOS 需手勢）→ 安靜顯示按鈕，不跳錯誤
    if (auto) { $('start-cam').hidden = false; return; }
    dialog('無法開啟鏡頭：' + (e && e.message ? e.message : e) + '\n請確認已允許相機權限，且使用 HTTPS 開啟。', [{ label: '知道了' }]);
  }
}
async function loop() {
  if (!scanning) return;
  if (mode === 'A' && video.readyState >= 2 && Date.now() - lastHitAt > 1200) {
    try {
      let value = null;
      if (bd) { const codes = await bd.detect(video); if (codes && codes.length) value = codes[0].rawValue; }
      else if (window.jsQR) { const w = video.videoWidth, h = video.videoHeight; if (w && h) { canvas.width = w; canvas.height = h; cctx.drawImage(video, 0, 0, w, h); const im = cctx.getImageData(0, 0, w, h); const r = jsQR(im.data, w, h); if (r) value = r.data; } }
      if (value) addCodeLive(value);
    } catch (e) {}
  }
  requestAnimationFrame(loop);
}

/* ---------- 模式 B：拍照／選照片 批次 OCR ---------- */
// 從已載入的 Image 取(子)區域，縮放到 maxDim 內，灰階(偏重藍通道→淡化藍筆圈註)＋二值化
function imgToCanvas(img, sx, sy, sw, sh, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const cv = document.createElement('canvas'); cv.width = Math.round(sw * scale); cv.height = Math.round(sh * scale);
  const x = cv.getContext('2d'); x.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  const im = x.getImageData(0, 0, cv.width, cv.height), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const g = 0.10 * d[i] + 0.20 * d[i + 1] + 0.70 * d[i + 2]; const v = g > 140 ? 255 : (g < 110 ? 0 : g); d[i] = d[i + 1] = d[i + 2] = v; }
  x.putImageData(im, 0, 0); return cv;
}
async function ensureOcr() {
  if (ocrWorker || !window.Tesseract) return;
  ocrWorker = await Tesseract.createWorker('eng');
  await ocrWorker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', preserve_interword_spaces: '1' });
}
// 取出精確的 TW+13；另把「TW 開頭、字數接近但不對」列為疑似(多半少認/多認一碼)
function extractAll(text) {
  const up = (text || '').toUpperCase(); const exact = new Set(), sus = new Set();
  up.split(/[^A-Z0-9]+/).forEach(t => {
    if (RE_TW.test(t)) exact.add(t);
    else if (/^TW[A-Z0-9]{10,16}$/.test(t)) sus.add(t);
  });
  return { exact: [...exact], suspects: [...sus].filter(s => !exact.has(s)) };
}

/* ---- A：框選欄位 —— 先讓使用者在照片上框出「物流編號」那一欄再辨識 ---- */
function openCrop(file) {
  if (!file) return;
  if (!window.Tesseract) { dialog('OCR 函式庫尚未載入（需連網），請稍後再試。', [{ label: '知道了' }]); return; }
  const url = URL.createObjectURL(file); const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url); cropImg = img; sel = null;
    const cv = $('crop-cv');
    const maxW = Math.min(window.innerWidth * 0.92, 900), maxH = window.innerHeight * 0.58;
    cropScale = Math.min(maxW / img.width, maxH / img.height, 1);
    cv.width = Math.round(img.width * cropScale); cv.height = Math.round(img.height * cropScale);
    drawCrop(); $('crop').hidden = false;
  };
  img.onerror = () => { URL.revokeObjectURL(url); dialog('影像載入失敗。', [{ label: '知道了' }]); };
  img.src = url;
}
function drawCrop() {
  const cv = $('crop-cv'), x = cv.getContext('2d');
  x.clearRect(0, 0, cv.width, cv.height); x.drawImage(cropImg, 0, 0, cv.width, cv.height);
  if (sel) { x.fillStyle = 'rgba(255,212,0,.18)'; x.fillRect(sel.x, sel.y, sel.w, sel.h); x.strokeStyle = '#ffd400'; x.lineWidth = 3; x.strokeRect(sel.x, sel.y, sel.w, sel.h); }
}
function cropPos(e) {
  const cv = $('crop-cv'), r = cv.getBoundingClientRect(), p = (e.touches && e.touches[0]) || e;
  return { x: (p.clientX - r.left) * (cv.width / r.width), y: (p.clientY - r.top) * (cv.height / r.height) };
}
function bindCrop() {
  const cv = $('crop-cv');
  const down = (e) => { e.preventDefault(); const p = cropPos(e); cropStart = p; sel = { x: p.x, y: p.y, w: 0, h: 0 }; dragging = true; drawCrop(); };
  const move = (e) => { if (!dragging) return; e.preventDefault(); const p = cropPos(e); sel.x = Math.min(cropStart.x, p.x); sel.y = Math.min(cropStart.y, p.y); sel.w = Math.abs(p.x - cropStart.x); sel.h = Math.abs(p.y - cropStart.y); drawCrop(); };
  const up = () => { if (!dragging) return; dragging = false; if (sel && (sel.w < 8 || sel.h < 8)) sel = null; drawCrop(); };
  cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up); cv.addEventListener('pointerleave', up);
}
function cropConfirm(whole) {
  if (!cropImg) return;
  let region;
  if (whole) region = [0, 0, cropImg.width, cropImg.height];
  else {
    if (!sel || sel.w < 8 || sel.h < 8) { toast('請先在圖上框出範圍', true); return; }
    region = [sel.x / cropScale, sel.y / cropScale, sel.w / cropScale, sel.h / cropScale];
  }
  $('crop').hidden = true;
  const cv = imgToCanvas(cropImg, region[0], region[1], region[2], region[3], 2600);
  cropImg = null; runOcr(cv);
}

/* 執行 OCR（傳入已前處理的 canvas）→ 精確碼直接加入；疑似碼進手動修正清單 */
async function runOcr(cv) {
  showBusy('辨識中…（數十筆需數秒）');
  try {
    await ensureOcr();
    const { data } = await ocrWorker.recognize(cv);
    const { exact, suspects } = extractAll(data.text || '');
    let added = 0, dup = 0;
    for (const code of exact) { if (await addCode(code, 'B')) added++; else dup++; }
    hideBusy(); render(); if (added) beep(true);
    if (!exact.length && !suspects.length) { dialog('沒有辨識到 TW＋13 碼。\n小技巧：靠近只拍「物流編號」那一欄、對正、光線足、紙壓平；藍筆別圈在編號上。', [{ label: '知道了' }]); return; }
    let msg = `辨識完成：精確 ${exact.length} 筆，新增 ${added}${dup ? `，重複略過 ${dup}` : ''} 筆。`;
    if (suspects.length) dialog(msg + `\n另有 ${suspects.length} 筆「疑似」字數不符，要手動修正嗎？`, [{ label: '修正疑似', onClick: () => openSuspect(suspects) }, { label: '略過' }]);
    else dialog(msg, [{ label: '好' }]);
  } catch (e) { hideBusy(); dialog('辨識失敗：' + (e && e.message ? e.message : e), [{ label: '知道了' }]); }
}

/* ---- B：疑似清單 —— 列出字數不對的碼，修正成 TW+13 後逐筆加入 ---- */
function openSuspect(list) {
  const box = $('suspect-list'); box.innerHTML = '';
  list.forEach(code => {
    const row = document.createElement('div'); row.className = 'sus-row';
    row.innerHTML = `<input class="sus-inp" value="${code}" maxlength="15" autocapitalize="characters" autocomplete="off" spellcheck="false"><button class="btn save sus-add" type="button">加入</button>`;
    const inp = row.querySelector('.sus-inp'), btn = row.querySelector('.sus-add');
    inp.oninput = () => inp.classList.remove('bad');
    btn.onclick = async () => {
      const v = inp.value.trim().toUpperCase();
      if (!RE_TW.test(v)) { inp.classList.add('bad'); toast('需 TW＋13 碼（共 15 字）', true); return; }
      const ok = await addCode(v, 'B'); render();
      if (ok) { beep(true); toast('已加入 ' + v); } else toast('已存在，略過', true);
      row.remove(); if (!box.children.length) closeSuspect();
    };
    box.appendChild(row);
  });
  $('suspect').hidden = false;
}
function closeSuspect() { $('suspect').hidden = true; }

/* ---------- 模式切換 / 框色 / Busy ---------- */
function setMode(m) {
  mode = m; const a = (m === 'A');
  $('fab').classList.toggle('mode-b', !a);
  $('fab-mode').textContent = a ? 'QR' : '文字';
  $('fab-label').textContent = a ? '掃碼' : '掃描';
  $('guide').textContent = a ? '掃描 QR Code' : '拍攝物流單號';
  $('frame').style.display = a ? '' : 'none';
  $('frame').classList.toggle('mode-a', a);
  $('batch-btn').hidden = a;
  $('start-cam').hidden = a ? !!stream : true;   // A 模式未開鏡頭才顯示；B 模式不需要
  lastHitAt = Date.now();
}
function flashFrame(state) { const f = $('frame'); f.classList.remove('ok', 'err'); void f.offsetWidth; f.classList.add(state); clearTimeout(f._t); f._t = setTimeout(() => f.classList.remove(state), 700); }
function showBusy(msg) { $('busy-sub').textContent = msg || ''; $('busy').hidden = false; }
function hideBusy() { $('busy').hidden = true; }

/* ---------- 清單渲染 ---------- */
async function render() {
  const all = (await dbAll()).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  $('cnt').textContent = all.length;
  const _qa = all.filter(r => r.mode === 'A').length, _qb = all.length - _qa;
  $('hdr-count').textContent = `QR掃碼 ${_qa}　文字掃描 ${_qb}　合計 ${all.length}`;
  $('empty').hidden = all.length > 0;
  const list = $('list'); list.innerHTML = '';
  all.forEach((r, i) => {
    const row = document.createElement('div'); row.className = 'row';
    const ml = r.mode === 'A' ? 'QR掃碼' : '文字掃碼';
    row.innerHTML = `<span class="idx">#${i + 1}</span><span class="code">${r.code}</span><span class="time">${timeShort(r.ts)}</span><span class="mode-tag">${ml}</span><button class="del" data-code="${r.code}" aria-label="刪除">✕</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('.del').forEach(b => b.onclick = () => {
    const code = b.dataset.code;
    dialog(`確定刪除這筆？\n${code}`, [
      { label: '刪除', danger: true, onClick: async () => { await dbDel(code); seen.delete(code); render(); } },
      { label: '取消' }
    ]);
  });
  list.scrollTop = list.scrollHeight;
  $('copy-list').disabled = all.length === 0;
  $('clear-all').disabled = all.length === 0;
}
function timeShort(ts) { return (ts || '').split(' ')[1] || ts; }

/* ---------- LINE 回報 / 清除 ---------- */
/* 組出 LINE 回報文字 */
function composeReport(all) {
  const a = all.filter(r => r.mode === 'A').map(r => r.code);
  const b = all.filter(r => r.mode === 'B').map(r => r.code);
  let t = `蝦皮助手：未取貨明細通知\n\n`;
  t += `查詢時間：${nowStr()}\n`;
  t += `處理總數：${all.length} 筆\n\n`;
  t += `QR掃碼（一般）合計 ${a.length} 筆\n` + (a.length ? a.join('\n') : '（無）') + `\n\n`;
  t += `文字掃碼（無包裝）合計 ${b.length} 筆\n` + (b.length ? b.join('\n') : '（無）');
  return t;
}
/* 執行未取入庫：先確認，再把整批號碼上傳到中繼站，電腦端擴充會自動帶出處理 */
async function uploadToLine() {
  const all = (await dbAll()).sort((x, y) => (x.ts < y.ts ? -1 : 1));
  if (!all.length) { dialog('沒有資料可上傳。', [{ label: '知道了' }]); return; }
  dialog(`確定上傳 ${all.length} 筆給電腦「執行未取入庫」？`, [
    { label: '上傳', onClick: () => sendToUsale(all) },
    { label: '取消' }
  ]);
}
async function sendToUsale(all) {
  const numbers = all.map(r => r.code);
  const relay = (localStorage.getItem(LS_RELAY) || DEFAULT_RELAY).trim();
  const key = localStorage.getItem(LS_KEY) || DEFAULT_KEY;
  if (!relay) { dialog('尚未設定中繼網址（右上 ⚙）。', [{ label: '知道了' }]); return; }
  try {
    const r = await fetch(relay, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key, action: 'usale-upload', numbers }) });
    const t = await r.text().catch(() => '');
    if (/bad key/.test(t)) { dialog('通關碼不符，請到 ⚙ 確認。', [{ label: '知道了' }]); return; }
    toast('✅ 已上傳，電腦端會自動帶出'); beep(true); askClearAfterUpload(numbers.length);
  } catch (e) {
    dialog('送出失敗：' + (e && e.message ? e.message : e) + '\n請確認網路，或到 ⚙ 檢查中繼網址。', [{ label: '知道了' }]); return;
  }
}
function askClearAfterUpload(n) {
  dialog(
    `系統已同步 ${n} 筆資料至 ERP。\n\n⚠️ 作業規範：請先至 ERP 核對接收數量是否為 ${n} 筆（核對為作業人員之責任）。確認無誤後再執行清空；若數量不符，請保留畫面並聯繫技術支援。`,
    [
      { label: '確認無誤，清空畫面', onClick: async () => { await dbClear(); seen.clear(); render(); } },
      { label: '數量有誤，保留畫面' }
    ],
    `請核對同步數量（共 ${n} 筆）`
  );
}
async function clearAll() {
  const all = await dbAll(); if (!all.length) return;
  dialog(`確定清除全部 ${all.length} 筆？（無法復原）`, [{ label: '清除', danger: true, onClick: async () => { await dbClear(); seen.clear(); render(); } }, { label: '取消' }]);
}

/* ---------- 小工具 ---------- */
let toastT = null;
function toast(msg, warn) { const t = $('toast'); t.textContent = msg; t.classList.toggle('warn', !!warn); t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1600); }
function ensureActx() { try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) {} }
function tone(freq, dur, wave, vol, delay) {
  if (!actx) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = wave || 'square'; o.frequency.value = freq; o.connect(g); g.connect(actx.destination);
  const t0 = actx.currentTime + (delay || 0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.start(t0); o.stop(t0 + dur + 0.03);
}
const SND_VOL = 0.95; // 固定音量（設大聲；實際大小請用手機音量鍵調）
// 成功音：固定「上升鈴」（880→1320）
function playSuccess() {
  ensureActx(); if (!actx) return;
  tone(880, 0.16, 'triangle', SND_VOL, 0);
  tone(1320, 0.26, 'triangle', SND_VOL, 0.15);
}
function beep(ok) {
  ensureActx();
  if (actx) {
    if (ok) playSuccess();
    else { tone(320, 0.16, 'square', SND_VOL, 0); tone(250, 0.18, 'square', SND_VOL, 0.17); } // 錯誤：低音雙嗶
  }
  try { navigator.vibrate && navigator.vibrate(ok ? 60 : [40, 40, 40]); } catch (e) {}
}
function nowStr() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function dialog(text, buttons, title) {
  const box = $('dialog'); const tEl = $('dialog-title');
  if (title) { tEl.textContent = title; tEl.hidden = false; } else { tEl.hidden = true; }
  $('dialog-text').textContent = text; const foot = $('dialog-foot'); foot.innerHTML = '';
  buttons.forEach(b => { const el = document.createElement('button'); el.className = 'btn ' + (b.danger ? 'up' : b.onClick ? 'save' : 'cancel'); if (b.danger) el.style.background = 'var(--red)'; el.textContent = b.label; el.onclick = () => { box.hidden = true; if (b.onClick) b.onClick(); }; foot.appendChild(el); });
  box.hidden = false;
}

/* ---------- 啟動 ---------- */
async function init() {
  db = await openDB();
  (await dbAll()).forEach(r => seen.add(r.code));
  if ('BarcodeDetector' in window) { try { bd = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { bd = null; } }
  setMode('A'); render();

  $('start-cam').onclick = () => startCamera(false);
  $('fab').onclick = () => setMode(mode === 'A' ? 'B' : 'A');
  $('batch-btn').onclick = () => $('photo-input').click();
  $('photo-input').onchange = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; openCrop(f); };
  $('crop-cancel').onclick = () => { $('crop').hidden = true; cropImg = null; };
  $('crop-whole').onclick = () => cropConfirm(true);
  $('crop-ok').onclick = () => cropConfirm(false);
  $('suspect-close').onclick = closeSuspect;
  $('suspect-done').onclick = closeSuspect;
  bindCrop();
  $('copy-list').onclick = uploadToLine;
  $('clear-all').onclick = clearAll;

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // 一進來自動嘗試開鏡頭（電腦/Android 會直接開；iPhone 需手勢時會安靜顯示按鈕）
  startCamera(true);
}
init();
