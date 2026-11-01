/* 微信 JSAPI H5 收银台逻辑：
 * 扫码打开 pay.html?no=订单号&t=令牌 →（无 code）取免登录授权链接整页跳微信 OAuth →
 * 回跳带 code → token-pay 换拉起参数 → WeixinJSBridge 拉起支付 → 成功/取消/失败三态。
 * 依赖同源外链脚本（helmet CSP: script-src 'self'），不使用内联脚本。
 */
(function () {
  'use strict';

  // 极简 query 解析（不依赖 URLSearchParams，兼容旧 WebView）
  var QS = {};
  location.search.replace(/^\?/, '').split('&').forEach(function (kv) {
    if (!kv) return;
    var i = kv.indexOf('=');
    var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
    QS[k] = decodeURIComponent(i < 0 ? '' : kv.slice(i + 1));
  });

  // no/t：query 优先；微信授权回跳以 state=no|t 兜底还原
  var st = (QS.state || '').split('|');
  var no = QS.no || st[0] || '';
  var t = QS.t || st[1] || '';
  var code = QS.code || '';

  var STATES = ['st-prepare', 'st-nowechat', 'st-success', 'st-retry', 'st-error'];
  function show(id) {
    STATES.forEach(function (s) { document.getElementById(s).classList.toggle('hidden', s !== id); });
  }
  function $(id) { return document.getElementById(id); }

  // 后端统一响应壳 {code:0,message,data}；非 0 视为业务失败
  function api(path, body) {
    return fetch('/api/recharge/wechat/jsapi' + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.code !== 0) throw new Error(j.message || ('HTTP ' + r.status));
        return j.data;
      });
    });
  }

  function inWechat() { return /MicroMessenger/i.test(navigator.userAgent); }

  var payParams = null; // 拉起参数（prepay_id 2 小时内可重复拉起，取消后直接重试）

  function invokePay() {
    return new Promise(function (resolve, reject) {
      function go() {
        WeixinJSBridge.invoke('getBrandWCPayRequest', payParams, function (res) {
          var r = String(res.get_brand_wcpay_request || res.err_msg || '');
          if (r.indexOf('ok') >= 0) resolve();
          else reject(new Error(r.indexOf('cancel') >= 0 ? 'cancel' : 'fail'));
        });
      }
      if (typeof WeixinJSBridge === 'undefined') {
        document.addEventListener('WeixinJSBridgeReady', go, false);
        setTimeout(function () { if (typeof WeixinJSBridge === 'undefined') reject(new Error('fail')); }, 5000);
      } else {
        go();
      }
    });
  }

  function pay() {
    show('st-prepare');
    $('prepareTip').textContent = '正在拉起微信支付…';
    invokePay().then(function () {
      show('st-success');
    }).catch(function (e) {
      var cancelled = e && e.message === 'cancel';
      $('retryTitle').textContent = cancelled ? '支付已取消' : '未能完成支付';
      $('retryHint').textContent = cancelled
        ? '订单已生成，可随时重新发起支付。'
        : '拉起支付失败，请重试；如多次失败请回到充值页重新下单。';
      $('retryEmoji').textContent = cancelled ? '⚠️' : '😅';
      show('st-retry');
    });
  }

  // 重新发起：已有拉起参数直接再拉；否则回干净 URL 重走授权
  function retry() {
    if (payParams) { pay(); return; }
    location.replace(location.pathname + '?no=' + encodeURIComponent(no) + '&t=' + encodeURIComponent(t));
  }

  function start() {
    if (!no || !t) { show('st-error'); return; }
    if (!inWechat()) { show('st-nowechat'); return; }
    $('orderNo').textContent = no;
    show('st-prepare');
    $('prepareTip').textContent = code ? '正在拉起微信支付…' : '正在跳转微信授权…';

    var flow = code
      ? api('/token-pay', { no: no, t: t, code: code }).then(function (data) {
          if (data && data.already_paid) { show('st-success'); return; }
          payParams = data && data.pay_params;
          if (!payParams) throw new Error('fail');
        })
      : api('/cashier-auth-url?no=' + encodeURIComponent(no) + '&t=' + encodeURIComponent(t)).then(function (data) {
          location.replace(data.auth_url); // 静默授权（snsapi_base），state 带 no|t 回跳还原
          return new Promise(function () {}); // 跳转期间保持界面
        });

    flow.then(function () { if (payParams) pay(); }).catch(function (e) {
      var msg = String((e && e.message) || '');
      // 授权 code 过期/已消费（刷新、重复进入）：去 code 重走授权
      if (code && (/40029|40163|42026/.test(msg) || /授权|code/i.test(msg))) {
        location.replace(location.pathname + '?no=' + encodeURIComponent(no) + '&t=' + encodeURIComponent(t));
        return;
      }
      $('retryTitle').textContent = '无法发起支付';
      $('retryHint').textContent = msg || '支付链接无效或已过期，请回到充值页重新下单。';
      $('retryEmoji').textContent = '🚫';
      show('st-retry');
    });
  }

  $('btnRetry').addEventListener('click', retry);
  start();
})();
