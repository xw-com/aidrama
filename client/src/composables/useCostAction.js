import { ElMessage } from 'element-plus';
import { useAuthStore } from '../stores/auth';
import { useJobsStore } from '../stores/jobs';
import { useGenConfirmStore } from '../stores/genConfirm';
import i18n from '../i18n';

/**
 * 统一的「模型选择 + 价格确认 → 执行」流程。
 * 全部 AI 生成入口都先弹出 GenConfirmDialog（可在对话框内选模型/分辨率、实时显示价格），
 * 确认后再提交任务；用户取消则中止。覆盖视频/图像/文本及合成等全部入口。
 *
 * 统一的对象 API：
 *   runJob({ modelType, selection, estimateFor, createFor, title, desc, confirmText, onDone })
 *   runJobs({ modelType, selection, items:[{estimateFor,createFor,onDone}], title, desc, confirmText })
 *   run({ modelType, selection, estimateFor, run, title, desc, confirmText, success })  // 同步扣费版
 *
 *   modelType  'video'|'image'|'text'|null —— 是否在对话框内选择模型（合成等非大模型调用传 null）
 *   resolutionOptions  ['480p',…] 无模型场景的静态分辨率档位（合成用；有 modelType 时忽略）
 *   resolutionHint     分辨率行下方常驻提示文案
 *   selection  { modelConfigId, resolution } 初始/记忆默认值（如顶栏当前值）
 *   estimateFor(sel) => Promise<{ credits, perSec?, source, pricing? }>
 *   createFor(sel)   => Promise<{ job }>
 *   run(sel)         => Promise<{ balance, credits_used? }>  （仅 run）
 */
// 汇总多项估算：对全部 items 求和（单项估算失败按 0 计并计入 count）
async function sumEstimate(items, sel) {
  const results = await Promise.all(items.map((it) => it.estimateFor(sel).catch(() => null)));
  const ok = results.filter(Boolean);
  const credits = ok.reduce((n, r) => n + (Number(r.credits) || 0), 0);
  // 同步汇总会员折后价（同一用户 discount 一致，取首项档位信息）
  const discountedCredits = ok.reduce((n, r) => n + (Number(r.discountedCredits) || Number(r.credits) || 0), 0);
  const first = ok[0] || {};
  return { credits, count: ok.length, originalCredits: credits, discountedCredits, discount: Number(first.discount) || 0, tier: first.tier || 'none', promo: ok.map((r) => r.promo).find(Boolean) || null };
}

export function useCostAction() {
  const auth = useAuthStore();

  /**
   * 异步任务版：确认后提交任务(立即返回 job)，注册完成回调；实际扣费在后台任务执行时处理。
   * @returns job（供视图绑定行内进度），用户取消返回 null
   */
  async function runJob(opts = {}) {
    const {
      modelType = null, selection, estimateFor, createFor, onDone, onConfirm,
      title = i18n.global.t('genConfirm.defaultTitle'), desc = '', confirmText = i18n.global.t('genConfirm.defaultConfirmText'),
      allowReferenceImage, referenceImage, uploadReferenceImage, removeReferenceImage,
      allowRequirement, requirementPresets, resolutionOptions, resolutionHint,
    } = opts;
    const gen = useGenConfirmStore();
    const sel = await gen.open({
      title, desc, confirmText, modelType, selection, estimateFor,
      allowReferenceImage, referenceImage, uploadReferenceImage, removeReferenceImage,
      allowRequirement, requirementPresets, resolutionOptions, resolutionHint,
    });
    if (!sel) return null; // 用户取消
    if (onConfirm) onConfirm(sel); // 让调用方回写「记忆默认值」(如顶栏当前模型/分辨率)
    const { job } = await createFor(sel);
    const jobs = useJobsStore();
    if (onDone) jobs.registerOnDone(job.id, onDone);
    jobs.track(job);
    return job;
  }

  /**
   * 批量异步版：共享同一个模型选择，提交前对全部任务汇总积分并只弹一次确认，确认后依次提交。
   * @param {Array<{estimateFor,createFor,onDone?}>} items
   * @returns job[]；用户取消或无有效项返回 null
   */
  async function runJobs(opts = {}) {
    const {
      modelType = null, selection, items = [], onConfirm,
      title = i18n.global.t('genConfirm.batchTitle'), desc = '', confirmText = i18n.global.t('genConfirm.batchConfirmText'),
      allowRequirement, requirementPresets, resolutionOptions, resolutionHint,
    } = opts;
    if (!items.length) return null;

    const gen = useGenConfirmStore();
    const sel = await gen.open({ title, desc, confirmText, modelType, selection, allowRequirement, requirementPresets, resolutionOptions, resolutionHint, estimateFor: (sel) => sumEstimate(items, sel) });
    if (!sel) return null; // 用户取消
    if (onConfirm) onConfirm(sel); // 让调用方回写「记忆默认值」

    // 依次提交（实际生成并发由后台运行器处理）
    const jobs = useJobsStore();
    const out = [];
    for (const it of items) {
      const { job } = await it.createFor(sel);
      if (it.onDone) jobs.registerOnDone(job.id, it.onDone);
      jobs.track(job);
      out.push(job);
    }
    return out;
  }

  /**
   * 同步扣费版：确认后即时执行 run 并刷新积分（保留兼容，目前主要被 runJob 取代）。
   * @returns 结果；用户取消返回 null
   */
  async function run(opts = {}) {
    const {
      modelType = null, selection, estimateFor, run: runFn,
      title = i18n.global.t('genConfirm.defaultTitle'), desc = '', confirmText = i18n.global.t('genConfirm.defaultConfirmText'), success = i18n.global.t('common.opSuccess'),
      allowRequirement, requirementPresets, resolutionOptions, resolutionHint,
    } = opts;
    const gen = useGenConfirmStore();
    const sel = await gen.open({ title, desc, confirmText, modelType, selection, estimateFor, allowRequirement, requirementPresets, resolutionOptions, resolutionHint });
    if (!sel) return null; // 用户取消
    const res = await runFn(sel);
    if (res?.balance !== undefined) auth.credits = res.balance;
    else auth.refreshCredits();
    if (res?.credits_used !== undefined) ElMessage.success(i18n.global.t('genConfirm.doneWithCost', { success, n: res.credits_used }));
    else ElMessage.success(success);
    return res;
  }

  return { run, runJob, runJobs };
}
