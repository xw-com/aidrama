/**
 * 单视频保存（进度条弹层版）：H5 fetch 流式下载（Content-Length 计算进度，跨域无 CORS
 * 时回退浏览器原生下载）；App/小程序 uni.downloadFile 任务 onProgressUpdate 上报进度后
 * 存入系统相册（微信小程序相册权限被拒时引导 openSetting）。
 * 进度/取消由 stores/download 承载，页面挂 <AdDownloadDialog /> 渲染。
 * 自 episodes.vue downloadFilm 迁出共用：剪辑器导出完成面板、分镜本镜下载同样要走；
 * saveVideos 为批量版（episodes.vue 批量下载成片用）。
 * ok/fail/perm 等结果文案仍由调用方传入；busy/canceled 为共用文案走 common 命名空间。
 */

import { toast } from './ui';
import i18n from '../i18n';
import { useDownloadStore } from '../stores/download';

const t = (...args) => i18n.global.t(...args);

/**
 * 批量下载：H5 逐个触发浏览器下载（400ms 间隔防被判批量拦截，浏览器自行接管存储）；
 * App/小程序 顺序下载并逐个存入系统相册，复用进度弹层展示「i/n 文件名」与整体进度，
 * 支持取消（中断当前任务及后续）。返回 Promise，全部处理完毕后 resolve。
 * 结果文案由调用方传入（ok 为批量汇总文案；非 H5 相册权限被拒时同单片逻辑引导设置）。
 */
export async function saveVideos(list, msgs = {}) {
  if (!list || !list.length) return;
  const dl = useDownloadStore();
  if (dl.visible) { toast(t('common.downloadBusy')); return; }

  /* #ifdef H5 */
  for (const { url, filename } of list) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((resolve) => setTimeout(resolve, 400)); // 逐个间隔触发，避免被判定批量下载拦截
  }
  toast(msgs.ok, 'success');
  /* #endif */

  /* #ifndef H5 */
  const n = list.length;
  const label = (i) => (n > 1 ? `${i + 1}/${n} ${list[i].filename}` : list[i].filename);
  let task = null;
  let canceled = false;
  let permDenied = false;
  let failCount = 0;
  dl.start(label(0)); // 先 start（会重置取消句柄），再注册 cancelFn，顺序不能反
  dl.setCancelFn(() => { if (task) task.abort(); });
  for (let i = 0; i < n; i++) {
    dl.name = label(i);
    const base = (i / n) * 100; // 本个起点的整体进度
    const ok = await new Promise((resolve) => {
      task = uni.downloadFile({
        url: list[i].url,
        success: (res) => {
          if (res.statusCode !== 200 || !res.tempFilePath) { resolve(false); return; }
          dl.setProgress(((i + 1) / n) * 100); // 下载完成，弹层保持到相册写入结束（大文件写入也有间隔）
          uni.saveVideoToPhotosAlbum({
            filePath: res.tempFilePath,
            success: () => resolve(true),
            fail: (e2) => {
              // 相册权限被拒：后续每个都会同样失败，直接中止整批
              if (/auth|deny/i.test(e2?.errMsg || '')) permDenied = true;
              resolve(false);
            },
          });
        },
        fail: (e) => {
          if (/abort/i.test(e?.errMsg || '')) canceled = true;
          resolve(false);
        },
      });
      task.onProgressUpdate((res) => dl.setProgress(base + res.progress / n));
    });
    if (canceled || permDenied) break;
    if (!ok) failCount++;
  }
  dl.finish();
  if (canceled) { toast(t('common.downloadCanceled')); return; }
  if (permDenied) {
    /* #ifdef MP-WEIXIN */
    uni.showModal({
      title: msgs.tip || '',
      content: msgs.perm || '',
      confirmText: msgs.okBtn || 'OK',
      success: (r) => { if (r.confirm) uni.openSetting(); },
    });
    return;
    /* #endif */
    /* #ifndef MP-WEIXIN */
    toast(msgs.perm || msgs.fail);
    return;
    /* #endif */
  }
  if (failCount) toast(msgs.fail);
  else toast(msgs.ok, 'success');
  /* #endif */
}

export function saveVideo(url, filename, msgs = {}) {
  if (!url) return;
  const dl = useDownloadStore();
  if (dl.visible) { toast(t('common.downloadBusy')); return; }

  /* #ifdef H5 */
  dl.start(filename);
  const ctrl = new AbortController();
  dl.setCancelFn(() => ctrl.abort());
  (async () => {
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`http ${resp.status}`);
      const total = Number(resp.headers.get('content-length')) || 0;
      const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
      const chunks = [];
      let received = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total) dl.setProgress((received / total) * 100);
        }
      }
      const blob = new Blob(chunks, { type: 'video/mp4' });
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl; // blob 落盘：浏览器原生存储对话框/下载管理器接管，不用再拉一次
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
      dl.finish();
      toast(msgs.ok, 'success');
    } catch (e) {
      if (e?.name === 'AbortError') { dl.finish(); toast(t('common.downloadCanceled')); return; }
      // 回退：跨域无 CORS 等场景 fetch 不可用，交给浏览器原生下载（浏览器自带进度，无进度条弹层）
      dl.finish();
      const a = document.createElement('a');
      a.href = url; // 同源（dev proxy / 线上同域）直接落盘；跨域时浏览器自行打开
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  })();
  /* #endif */

  /* #ifndef H5 */
  dl.start(filename);
  const task = uni.downloadFile({
    url,
    success: (res) => {
      if (res.statusCode !== 200 || !res.tempFilePath) { dl.finish(); toast(msgs.fail); return; }
      dl.setProgress(100); // 下载完成，弹层保持到相册写入结束（大文件写入也有间隔）
      uni.saveVideoToPhotosAlbum({
        filePath: res.tempFilePath,
        success: () => { dl.finish(); toast(msgs.ok, 'success'); },
        fail: (e2) => {
          dl.finish();
          // 相册权限被拒：引导去设置开启（微信小程序）；其余错误原样提示
          /* #ifdef MP-WEIXIN */
          if (/auth|deny/i.test(e2?.errMsg || '')) {
            uni.showModal({
              title: msgs.tip || '',
              content: msgs.perm || '',
              confirmText: msgs.okBtn || 'OK',
              success: (r) => { if (r.confirm) uni.openSetting(); },
            });
            return;
          }
          /* #endif */
          toast(msgs.fail || e2?.errMsg);
        },
      });
    },
    fail: (e) => {
      dl.finish();
      if (/abort/i.test(e?.errMsg || '')) toast(t('common.downloadCanceled'));
      else toast(e?.errMsg || msgs.fail);
    },
  });
  task.onProgressUpdate((res) => dl.setProgress(res.progress));
  dl.setCancelFn(() => task.abort());
  /* #endif */
}
