/* ============================================================
   LINE 回報中繼 + 群組 groupId 抓取（Google Apps Script Web App）
   一支程式同時做兩件事：
   (1) PWA 把報表丟來 → 用機器人推到 LINE（群組/廣播）
   (2) 當作機器人的 Webhook：機器人進群或群裡有訊息時，
       自動把該群的 groupId 回覆到群裡，並記起來。
   ------------------------------------------------------------
   部署：script.google.com → 貼上 → 填下面的值 →
   部署→新增部署作業→網頁應用程式（執行身分:我、存取:所有人）→ 取得 /exec 網址
   ※ 改完程式要「部署→管理部署作業→編輯(鉛筆)→版本選『新版本』→部署」才生效
   ============================================================ */

// 【必填】LINE Developers → Messaging API → Channel access token (long-lived)
const LINE_TOKEN = '貼上你的 Channel access token';

// 【群組推送】先留空 → 照下方步驟抓到 groupId 後，貼進這裡（例如 'Cxxxxxxxx...'）
//             留空時 = 廣播給所有加好友的人
const TARGET_ID = '';

// 【自訂】通關碼：要和 PWA ⚙ 設定的「通關碼」一致
const KEY = '改成你自訂的通關碼';

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || '{}';
    var body = JSON.parse(raw);

    // (1) 這是 LINE 的 webhook 事件 → 抓 groupId
    if (body.events) {
      body.events.forEach(function (ev) {
        var src = (ev && ev.source) || {};
        if (src.groupId) {
          PropertiesService.getScriptProperties().setProperty('LAST_GROUP_ID', src.groupId);
          if (ev.replyToken) {
            UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
              method: 'post', contentType: 'application/json',
              headers: { Authorization: 'Bearer ' + LINE_TOKEN },
              payload: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: 'text', text: '✅ 這個群組的 groupId：\n' + src.groupId + '\n\n請複製貼到中繼程式的 TARGET_ID。' }] }),
              muteHttpExceptions: true
            });
          }
        } else if (src.userId) {
          PropertiesService.getScriptProperties().setProperty('LAST_USER_ID', src.userId);
        }
      });
      return out('webhook ok');
    }

    // (1.5) 手機「執行未取入庫」→ 把整批號碼存起來給擴充來拿（不推 LINE）
    if (body.action === 'usale-upload') {
      if (body.key !== KEY) return out('bad key');
      var batch = { batchId: Date.now(), numbers: (body.numbers || []), uploadedAt: new Date().toISOString() };
      PropertiesService.getScriptProperties().setProperty('USALE_BATCH', JSON.stringify(batch));
      return out('usale-upload ok ' + batch.numbers.length);
    }

    // (1.6) 蝦皮助手後台：LINE 範本「統一管理」雲端儲存（後台改 → 寫這裡 → 各機器/PWA 來讀）
    if (body.action === 'setTemplate') {
      if (body.key !== KEY) return out('bad key');
      PropertiesService.getScriptProperties().setProperty('LINE_TEMPLATES', JSON.stringify(body.templates || []));
      return out('setTemplate ok ' + (body.templates || []).length);
    }

    // (1.7) 後台「忘記密碼／寄測試信」→ 由 Google 端 MailApp 寄出
    if (body.action === 'forgotPassword') {
      if (body.key !== KEY) return out('bad key');
      MailApp.sendEmail(String(body.email || ''), '【蝦皮助手】管理後台密碼', '您的管理後台密碼為：' + String(body.password || '') + '\n\n（此信由蝦皮助手後台「忘記密碼」自動寄出，請勿外流。）');
      return out('forgotPassword mail sent');
    }
    if (body.action === 'testMail') {
      if (body.key !== KEY) return out('bad key');
      MailApp.sendEmail(String(body.email || ''), '【蝦皮助手】寄信測試', '這是一封測試信，代表後台的寄信中繼設定正常 ✅');
      return out('testMail sent');
    }

    // (2) PWA / 電腦端來的 LINE 推送請求（電腦退貨成功後的回報也走這條）
    if (body.key !== KEY) return out('bad key');
    var text = String(body.text || '').slice(0, 4900);
    if (!text) return out('empty');

    var url, payload;
    if (TARGET_ID) {
      url = 'https://api.line.me/v2/bot/message/push';
      payload = { to: TARGET_ID, messages: [{ type: 'text', text: text }] };
    } else {
      url = 'https://api.line.me/v2/bot/message/broadcast';
      payload = { messages: [{ type: 'text', text: text }] };
    }
    var resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + LINE_TOKEN },
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    return out('line ' + resp.getResponseCode());
  } catch (err) {
    return out('err: ' + err);
  }
}

// 用瀏覽器開 /exec 可看到目前抓到的 groupId / userId
function doGet(e) {
  var p = PropertiesService.getScriptProperties();
  // 擴充輪詢：拿最新的 USale 批次（?action=usale-latest&key=KEY）
  if (e && e.parameter && e.parameter.action === 'usale-latest') {
    if (e.parameter.key !== KEY) return outJson({ error: 'bad key' });
    var b = p.getProperty('USALE_BATCH');
    return outJson(b ? JSON.parse(b) : { batchId: 0, numbers: [] });
  }
  // 後台/PWA 讀 LINE 範本（?action=getTemplate&key=KEY）
  if (e && e.parameter && e.parameter.action === 'getTemplate') {
    if (e.parameter.key !== KEY) return outJson({ error: 'bad key' });
    var tpl = p.getProperty('LINE_TEMPLATES');
    return outJson({ templates: tpl ? JSON.parse(tpl) : [] });
  }
  return out('relay alive\nlastGroupId=' + (p.getProperty('LAST_GROUP_ID') || '(尚未抓到)') + '\nlastUserId=' + (p.getProperty('LAST_USER_ID') || '(尚未抓到)'));
}
function out(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }
function outJson(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
