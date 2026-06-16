/* 退貨助手 PWA — 手機掃描物流編號，回報未取貨明細到 LINE 群組
   - 模式 A：即時掃二維碼（BarcodeDetector，後備 jsQR）
   - 模式 B：拍照／選照片「批次 OCR」——一張整張清單一次抓出所有 TW＋13 碼
   - 掃到/辨識→存 IndexedDB（防重掃）→「上傳至 LINE」經中繼讓機器人推到群組
*/
const $ = (id) => document.getElementById(id);
const RE_TW = /^TW[A-Za-z0-9]{13}$/;
const LS_RELAY = 'sr_relay', LS_KEY = 'sr_key';
// 內建預設（免每台手機手動設定；可在 ⚙ 覆寫）
const DEFAULT_RELAY = 'https://script.google.com/macros/s/AKfycbx7iFTntfKD26-dLDndTPqZMPNsBY5QISXcopbLk2knpHLxOb2Jcr4IhQFr3in3pUKiUA/exec';
const DEFAULT_KEY = '1234';
// 音效設定 localStorage 鍵
const LS_SND_ON = 'sr_snd_on', LS_SND_VOL = 'sr_snd_vol', LS_SND_TYPE = 'sr_snd_type';

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
function extractOneTW(raw) {
  // 只接受獨立的 TW+13（前後不可黏其他英數，例如 SPXTW... 不算）
  const tokens = (raw || '').toUpperCase().split(/[^A-Z0-9]+/);
  for (const t of tokens) { if (RE_TW.test(t)) return t; }
  return null;
}
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
  // 只接受「獨立的」TW+13 token；前後黏其他英數（如 SPXTW...）一律排除
  up.split(/[^A-Z0-9]+/).forEach(t => { if (RE_TW.test(t)) set.add(t); });
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
/* 上傳至 LINE：先確認，再透過中繼讓「機器人」推到群組 */
async function uploadToLine() {
  const all = (await dbAll()).sort((x, y) => (x.ts < y.ts ? -1 : 1));
  if (!all.length) { dialog('沒有資料可上傳。', [{ label: '知道了' }]); return; }
  dialog(`確定上傳 ${all.length} 筆到 LINE 群組？`, [
    { label: '上傳', onClick: () => sendToLine(all) },
    { label: '取消' }
  ]);
}
async function sendToLine(all) {
  const text = composeReport(all);
  const relay = (localStorage.getItem(LS_RELAY) || DEFAULT_RELAY).trim();
  const key = localStorage.getItem(LS_KEY) || DEFAULT_KEY;
  if (!relay) { dialog('尚未設定 LINE 中繼網址（右上 ⚙）。', [{ label: '知道了' }]); return; }
  let ok = false;
  try {
    const r = await fetch(relay, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key, text }) });
    const t = await r.text().catch(() => '');
    if (/line 200/.test(t)) ok = true;
    else if (/bad key/.test(t)) { dialog('通關碼不符，請到 ⚙ 確認。', [{ label: '知道了' }]); return; }
    else if (/line \d/.test(t)) { dialog('LINE 拒絕推送（' + t + '）。\n多半是 token 失效或群組設定問題。', [{ label: '知道了' }]); return; }
    else ok = true; // 讀不到內容，多半已送出
  } catch (e) {
    dialog('送出失敗：' + (e && e.message ? e.message : e) + '\n請確認網路，或到 ⚙ 檢查中繼網址。', [{ label: '知道了' }]); return;
  }
  if (ok) { toast('已送出 LINE 回報'); beep(true); askClearAfterUpload(); }
}
function askClearAfterUpload() {
  dialog('已送出。是否清空目前清單，準備掃下一批？', [
    { label: '清空', danger: true, onClick: async () => { await dbClear(); seen.clear(); render(); } },
    { label: '取消' }
  ]);
}
async function clearAll() {
  const all = await dbAll(); if (!all.length) return;
  dialog(`確定清除全部 ${all.length} 筆？（無法復原）`, [{ label: '清除', danger: true, onClick: async () => { await dbClear(); seen.clear(); render(); } }, { label: '取消' }]);
}

/* ---------- 小工具 ---------- */
let toastT = null;
function toast(msg, warn) { const t = $('toast'); t.textContent = msg; t.classList.toggle('warn', !!warn); t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1600); }
function sndCfg() {
  return {
    on: localStorage.getItem(LS_SND_ON) !== '0',                       // 預設開
    vol: (parseInt(localStorage.getItem(LS_SND_VOL) || '60', 10)) / 100, // 預設 0.6
    type: localStorage.getItem(LS_SND_TYPE) || 'beep'
  };
}
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
// 成功音（依選擇的種類）
function playSuccess(type, v) {
  ensureActx(); if (!actx) return;
  switch (type) {
    case 'ding': tone(1320, 0.3, 'sine', v, 0); break;
    case 'double': tone(1000, 0.12, 'square', v, 0); tone(1000, 0.12, 'square', v, 0.16); break;
    case 'low': tone(620, 0.22, 'square', v, 0); break;
    case 'chime': tone(880, 0.14, 'triangle', v, 0); tone(1320, 0.22, 'triangle', v, 0.14); break;
    default: tone(1000, 0.18, 'square', v, 0); // beep
  }
}
function beep(ok) {
  const s = sndCfg();
  if (s.on) {
    ensureActx();
    if (actx) {
      if (ok) playSuccess(s.type, s.vol);
      else { tone(320, 0.16, 'square', s.vol, 0); tone(250, 0.18, 'square', s.vol, 0.17); } // 錯誤：低音雙嗶
    }
  }
  try { navigator.vibrate && navigator.vibrate(ok ? 60 : [40, 40, 40]); } catch (e) {}
}
function nowStr() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }

/* 音效設定視窗 */
function openSettings() {
  const s = sndCfg();
  $('snd-type').value = s.type;
  $('snd-on').checked = s.on;
  $('snd-vol').value = Math.round(s.vol * 100);
  $('snd-vol-v').textContent = Math.round(s.vol * 100);
  $('settings').hidden = false;
}
function closeSettings() { $('settings').hidden = true; }
function saveSettings() {
  localStorage.setItem(LS_SND_TYPE, $('snd-type').value);
  localStorage.setItem(LS_SND_ON, $('snd-on').checked ? '1' : '0');
  localStorage.setItem(LS_SND_VOL, String(parseInt($('snd-vol').value, 10)));
  closeSettings(); toast('音效設定已儲存');
}
function testSound() {
  if (!$('snd-on').checked) { toast('音效目前為關閉'); return; }
  ensureActx();
  playSuccess($('snd-type').value, parseInt($('snd-vol').value, 10) / 100);
}
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

  $('start-cam').onclick = () => startCamera(false);
  $('fab').onclick = () => setMode(mode === 'A' ? 'B' : 'A');
  $('batch-btn').onclick = () => $('photo-input').click();
  $('photo-input').onchange = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; processPhoto(f); };
  $('copy-list').onclick = uploadToLine;
  $('clear-all').onclick = clearAll;
  $('settings-btn').onclick = openSettings;
  $('settings-close').onclick = closeSettings;
  $('settings-cancel').onclick = closeSettings;
  $('settings-save').onclick = saveSettings;
  $('snd-test').onclick = testSound;
  $('snd-vol').oninput = function () { $('snd-vol-v').textContent = this.value; };

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // 一進來自動嘗試開鏡頭（電腦/Android 會直接開；iPhone 需手勢時會安靜顯示按鈕）
  startCamera(true);
}
init();
