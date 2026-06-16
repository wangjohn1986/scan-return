/* 退貨系統 PWA — 手機收集物流編號，帶到電腦匯入 ERP
   - 模式 A：即時掃二維碼（BarcodeDetector，後備 jsQR）
   - 模式 B：拍照／選照片「批次 OCR」——一張整張清單一次抓出所有 TW＋13 碼
   - 掃到/辨識→存 IndexedDB（防重掃）；可複製清單 / 匯出 CSV / 清除
*/
const $ = (id) => document.getElementById(id);
const RE_TW = /^TW[A-Za-z0-9]{13}$/;
const LS_RELAY = 'sr_relay', LS_KEY = 'sr_key';

let mode = 'A';
let stream = null, scanning = false, lastHitAt = 0, bd = null;
let ocrWorker = null;
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
// 從 QR 內容取出 TW＋13 碼（QR 編號格式與文字掃碼相同）
function extractOneTW(raw) { const m = (raw || '').toUpperCase().match(/TW[A-Z0-9]{13}/); return m ? m[0] : null; }
// 模式 A 即時掃：單筆，含節流與音效
async function addCodeLive(raw) {
  if (Date.now() - lastHitAt < 1200) return;
  lastHitAt = Date.now();
  const code = extractOneTW(raw);
  if (!code) { flashFrame('err'); beep(false); toast('QR 格式不符（需 TW＋13碼）', true); return; }
  if (seen.has(code)) { flashFrame('err'); beep(false); toast('重複，已略過：' + code, true); return; }
  if (await addCode(code, 'A')) { flashFrame('ok'); beep(true); toast('✅ ' + code); render(); }
}

/* ---------- 模式 A：即時鏡頭 ---------- */
async function startCamera() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream; await video.play();
    $('start-cam').hidden = true;
    scanning = true; loop();
  } catch (e) {
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
function fileToCanvas(file, maxDim) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      const x = cv.getContext('2d'); x.drawImage(img, 0, 0, cv.width, cv.height);
      // 灰階＋簡單二值化，提高文字辨識率
      const im = x.getImageData(0, 0, cv.width, cv.height), d = im.data;
      for (let i = 0; i < d.length; i += 4) { const g = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; const v = g > 145 ? 255 : (g < 95 ? 0 : g); d[i] = d[i + 1] = d[i + 2] = v; }
      x.putImageData(im, 0, 0); resolve(cv);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('影像載入失敗')); };
    img.src = url;
  });
}
async function ensureOcr() {
  if (ocrWorker || !window.Tesseract) return;
  ocrWorker = await Tesseract.createWorker('eng');
  await ocrWorker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', preserve_interword_spaces: '1' });
}
function extractCodes(text) {
  const up = (text || '').toUpperCase(); const set = new Set();
  up.split(/[^A-Z0-9]+/).forEach(t => { if (RE_TW.test(t)) set.add(t); });        // 逐 token
  const concat = up.replace(/[^A-Z0-9]/g, ''); let m; const re = /TW[A-Z0-9]{13}/g;  // 補抓連在一起的
  while ((m = re.exec(concat))) set.add(m[0]);
  return [...set];
}
async function processPhoto(file) {
  if (!file) return;
  if (!window.Tesseract) { dialog('OCR 函式庫尚未載入（需連網），請稍後再試。', [{ label: '知道了' }]); return; }
  showBusy('讀取影像…');
  try {
    const cv = await fileToCanvas(file, 2000);
    showBusy('辨識中…（整張數十筆需數秒）');
    await ensureOcr();
    const { data } = await ocrWorker.recognize(cv);
    const codes = extractCodes(data.text || '');
    if (!codes.length) { hideBusy(); dialog('沒有辨識到 TW＋13 碼。\n請拍清楚、對正、光線充足，或靠近一點再拍。', [{ label: '知道了' }]); return; }
    let added = 0, dup = 0;
    for (const code of codes) { if (await addCode(code, 'B')) added++; else dup++; }
    hideBusy(); render(); beep(true);
    dialog(`辨識完成：抓到 ${codes.length} 筆\n新增 ${added} 筆${dup ? `，重複略過 ${dup} 筆` : ''}。`, [{ label: '好' }]);
  } catch (e) { hideBusy(); dialog('辨識失敗：' + (e && e.message ? e.message : e), [{ label: '知道了' }]); }
}

/* ---------- 模式切換 / 框色 / Busy ---------- */
function setMode(m) {
  mode = m; const a = (m === 'A');
  $('fab').classList.toggle('mode-b', !a);
  $('fab-mode').textContent = m;
  $('fab-label').textContent = a ? '條碼' : '拍照';
  $('guide').textContent = a ? '請掃描二維碼' : '拍整張清單 → 批次辨識';
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
  $('hdr-count').textContent = '已掃 ' + all.length;
  $('counter').textContent = `已掃描 ${all.length} 筆`;
  $('empty').hidden = all.length > 0;
  const list = $('list'); list.innerHTML = '';
  all.forEach((r, i) => {
    const row = document.createElement('div'); row.className = 'row';
    const ml = r.mode === 'A' ? 'QR掃碼' : '文字掃碼';
    row.innerHTML = `<span class="idx">#${i + 1}</span><span class="code">${r.code}</span><span class="time">${timeShort(r.ts)}</span><span class="mode-tag">${ml}</span><button class="del" data-code="${r.code}" aria-label="刪除">✕</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('.del').forEach(b => b.onclick = async () => { await dbDel(b.dataset.code); seen.delete(b.dataset.code); render(); });
  list.scrollTop = list.scrollHeight;
  $('copy-list').disabled = all.length === 0;
  $('export-csv').disabled = all.length === 0;
  $('clear-all').disabled = all.length === 0;
}
function timeShort(ts) { return (ts || '').split(' ')[1] || ts; }

/* ---------- 複製 / 匯出 / 清除 ---------- */
/* 組出 LINE 回報文字 */
function composeReport(all) {
  const a = all.filter(r => r.mode === 'A').map(r => r.code);
  const b = all.filter(r => r.mode === 'B').map(r => r.code);
  let t = `未取貨明細 ${nowStr()}\n\n-----\n\n`;
  t += `QR掃碼 (一般) 合計${a.length}筆\n` + (a.length ? a.join('\n') : '（無）') + '\n\n';
  t += `文字掃碼 (無包裝) 合計${b.length}筆\n` + (b.length ? b.join('\n') : '（無）');
  return t;
}
/* 上傳至 LINE：用系統分享(iOS)選 LINE，後備開 LINE 分享連結／複製 */
async function uploadToLine() {
  const all = (await dbAll()).sort((x, y) => (x.ts < y.ts ? -1 : 1));
  if (!all.length) { dialog('沒有資料可上傳。', [{ label: '知道了' }]); return; }
  const text = composeReport(all);
  // 優先：透過中繼讓機器人自動推送
  const relay = localStorage.getItem(LS_RELAY) || '';
  if (relay) {
    try {
      await fetch(relay, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: localStorage.getItem(LS_KEY) || '', text }) });
      toast('已送出 LINE 回報'); beep(true); return;
    } catch (e) { dialog('送出中繼失敗：' + (e && e.message ? e.message : e) + '\n改用系統分享。', [{ label: '知道了' }]); }
  }
  // 後備：系統分享 / LINE 連結
  if (navigator.share) {
    try { await navigator.share({ text }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { window.location.href = 'https://line.me/R/msg/text/?' + encodeURIComponent(text); }
  catch (e) {
    try { await navigator.clipboard.writeText(text); dialog('已複製回報內容，請手動貼到 LINE。', [{ label: '知道了' }]); }
    catch (e2) { dialog('無法開啟 LINE。', [{ label: '知道了' }]); }
  }
}
async function exportCSV() {
  const all = (await dbAll()).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (!all.length) { dialog('沒有資料可匯出。', [{ label: '知道了' }]); return; }
  const rows = [['序號', '物流編號', '模式', '時間']]; all.forEach((r, i) => rows.push([i + 1, r.code, '模式' + r.mode, r.ts]));
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `退貨清單_${nowStr().replace(/[: ]/g, '-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已匯出 ${all.length} 筆 CSV`);
}
async function clearAll() {
  const all = await dbAll(); if (!all.length) return;
  dialog(`確定清除全部 ${all.length} 筆？（無法復原）`, [{ label: '取消' }, { label: '清除全部', danger: true, onClick: async () => { await dbClear(); seen.clear(); render(); } }]);
}

/* ---------- 小工具 ---------- */
let toastT = null;
function toast(msg, warn) { const t = $('toast'); t.textContent = msg; t.classList.toggle('warn', !!warn); t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1600); }
function beep(ok) {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const o = actx.createOscillator(), g = actx.createGain(); o.type = 'square'; o.frequency.value = ok ? 1000 : 300;
    g.gain.value = 0.0001; o.connect(g); g.connect(actx.destination); const t0 = actx.currentTime;
    g.gain.exponentialRampToValueAtTime(0.6, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + (ok ? 0.18 : 0.32));
    o.start(t0); o.stop(t0 + (ok ? 0.2 : 0.34));
  } catch (e) {}
  try { navigator.vibrate && navigator.vibrate(ok ? 60 : [40, 40, 40]); } catch (e) {}
}
function nowStr() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function openSettings() { $('relay-url').value = localStorage.getItem(LS_RELAY) || ''; $('relay-key').value = localStorage.getItem(LS_KEY) || ''; $('settings').hidden = false; }
function closeSettings() { $('settings').hidden = true; }
function saveSettings() { localStorage.setItem(LS_RELAY, $('relay-url').value.trim()); localStorage.setItem(LS_KEY, $('relay-key').value.trim()); closeSettings(); toast('設定已儲存'); }
function dialog(text, buttons) {
  const box = $('dialog'); $('dialog-text').textContent = text; const foot = $('dialog-foot'); foot.innerHTML = '';
  buttons.forEach(b => { const el = document.createElement('button'); el.className = 'btn ' + (b.danger ? 'up' : b.onClick ? 'save' : 'cancel'); if (b.danger) el.style.background = 'var(--red)'; el.textContent = b.label; el.onclick = () => { box.hidden = true; if (b.onClick) b.onClick(); }; foot.appendChild(el); });
  box.hidden = false;
}

/* ---------- 啟動 ---------- */
async function init() {
  db = await openDB();
  (await dbAll()).forEach(r => seen.add(r.code));
  if ('BarcodeDetector' in window) { try { bd = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { bd = null; } }
  setMode('A'); render();

  $('start-cam').onclick = startCamera;
  $('fab').onclick = () => setMode(mode === 'A' ? 'B' : 'A');
  $('batch-btn').onclick = () => $('photo-input').click();
  $('photo-input').onchange = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; processPhoto(f); };
  $('copy-list').onclick = uploadToLine;
  $('export-csv').onclick = exportCSV;
  $('clear-all').onclick = clearAll;
  $('settings-btn').onclick = openSettings;
  $('settings-close').onclick = closeSettings;
  $('settings-cancel').onclick = closeSettings;
  $('settings-save').onclick = saveSettings;

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
