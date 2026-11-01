import { defineStore } from 'pinia';
import { modelApi } from '../api';
import i18n from '../i18n';

/**
 * 「生成确认」对话框的全局状态。
 * 由 useCostAction.run/runJob/runJobs 触发：open() 返回一个 Promise，
 * 对话框内可切换模型/分辨率并实时重算价格，确认→resolve(selection)，取消→resolve(null)。
 * _resolver / _estimateFor 放在模块级（非 reactive），避免被 Pinia 序列化。
 */
let _resolver = null; // (selection|null) => void
let _estimateFor = null; // (sel) => Promise<{credits, perSec?, source, pricing?}>
let _uploadRefImage = null; // (file) => Promise<string> 上传参考图，返回参考图 URL
let _removeRefImage = null; // () => Promise<string|void> 移除参考图

export const useGenConfirmStore = defineStore('genConfirm', {
  state: () => ({
    visible: false,
    title: i18n.global.t('genConfirm.defaultTitle'),
    desc: '',
    confirmText: i18n.global.t('genConfirm.defaultConfirmText'),
    modelType: null, // 'video' | 'image' | 'text' | null
    hideResolution: false, // 强制隐藏分辨率选择（模型档位带 resolutions 但接口不消费时，如 AI 封面）
    models: [],
    selection: { modelConfigId: null, resolution: null },
    resolutionOptions: [], // 静态分辨率档位（compose 等无模型场景）：[{value:'1080p'}...]；有 modelType 时忽略
    resolutionHint: '',    // 分辨率行下方常驻提示（如合成 2K/4K 为放大编码的说明）
    estimate: null, // { credits, perSec?, source, pricing? }
    estimating: false,
    error: '',
    // 参考图（图生图，可选）：仅图像生成为资产设置时启用
    allowReferenceImage: false,
    referenceImage: '', // 当前参考图 URL（仅展示，实际生成由后端读取资产 meta）
    refUploading: false,
    refError: '',
    // 「本次要求」（可选）：仅润色提示词入口启用，确认后随任务一并提交给 LLM
    allowRequirement: false,
    requirement: '',
    requirementPresets: [], // 快捷输入候选（点击追加/移除）；默认不展示，需要时由调用方显式传入
  }),
  getters: {
    // 是否需要在对话框里展示模型选择（compose 等非大模型调用不需要）
    showModelSelect: (s) => !!s.modelType,
    showReferenceImage: (s) => !!s.allowReferenceImage,
    showRequirement: (s) => !!s.allowRequirement,
    activeModel: (s) => s.models.find((m) => m.id === s.selection.modelConfigId) || null,
    // 私有模型（用户自带 Key）：估价 source='private'，全程 0 积分
    isPrivateEst: (s) => s.estimate?.source === 'private',
    // 分辨率选项：模型档位优先（video 模型的 resolutions，带每秒价）；无模型场景回退静态档位
    resolutions: (s) => {
      if (s.hideResolution) return [];
      if (s.modelType) {
        const m = s.models.find((mm) => mm.id === s.selection.modelConfigId);
        return m && Array.isArray(m.resolutions) ? m.resolutions : [];
      }
      return Array.isArray(s.resolutionOptions) ? s.resolutionOptions : [];
    },
    // 展示/确认按钮口径：优先估价接口的折后价（限时折扣活动），无折扣时等于原价
    credits: (s) => Number(s.estimate?.discountedCredits ?? s.estimate?.credits) || 0,
    // 促销折扣信息（估价接口返回 promo 时）：原价/折后价/已省积分/优惠百分比；折后不低于原价不当作促销
    promo: (s) => {
      const e = s.estimate;
      if (!e || !e.promo) return null;
      // 积分一位小数精度：服务端已按 0.1 归一，这里仅消除浮点尾巴，不再向上取整
      const orig = Math.round((Number(e.originalCredits) || 0) * 10) / 10;
      const disc = Math.round((Number(e.discountedCredits ?? e.credits) || 0) * 10) / 10;
      if (!orig || disc >= orig) return null;
      const percent = Number(e.promo.percent) || 100;
      return {
        ...e.promo,
        originalCredits: orig,
        discountedCredits: disc,
        saved: orig - disc,
        offPercent: Math.round((100 - percent) * 100) / 100,
      };
    },
  },
  actions: {
    /**
     * 打开确认对话框。
     * @returns Promise<selection|null> —— 确认返回 {modelConfigId, resolution}，取消返回 null
     */
    async open({ title, desc, confirmText, modelType, selection, estimateFor,
      allowReferenceImage, referenceImage, uploadReferenceImage, removeReferenceImage,
      allowRequirement, requirementPresets, resolutionOptions, resolutionHint, hideResolution }) {
      this.title = title || i18n.global.t('genConfirm.defaultTitle');
      this.desc = desc || '';
      this.confirmText = confirmText || i18n.global.t('genConfirm.defaultConfirmText');
      this.modelType = modelType || null;
      this.hideResolution = !!hideResolution;
      _estimateFor = typeof estimateFor === 'function' ? estimateFor : null;
      // 静态分辨率档位（compose 等无模型场景）：归一化为 [{value}]；行下方常驻提示文案
      this.resolutionOptions = Array.isArray(resolutionOptions)
        ? resolutionOptions.map((v) => (typeof v === 'string' ? { value: v } : v)).filter((r) => r && r.value)
        : [];
      this.resolutionHint = typeof resolutionHint === 'string' ? resolutionHint : '';
      // 参考图：是否展示区块、初始值、上传/移除回调（由调用方实现持久化）
      this.allowReferenceImage = !!allowReferenceImage;
      this.referenceImage = referenceImage || '';
      this.refUploading = false;
      this.refError = '';
      _uploadRefImage = typeof uploadReferenceImage === 'function' ? uploadReferenceImage : null;
      _removeRefImage = typeof removeReferenceImage === 'function' ? removeReferenceImage : null;
      // 「本次要求」：仅润色提示词入口启用，每次打开重置；快捷输入默认不展示
      // （分镜文字规范两条预设已隐藏），需要时由调用方显式传 requirementPresets
      this.allowRequirement = !!allowRequirement;
      this.requirement = '';
      const normPresets = (arr) => (Array.isArray(arr) ? arr.map((p) => String(p || '').trim()).filter(Boolean) : null);
      this.requirementPresets = normPresets(requirementPresets) ?? [];

      // 按模型类型载入候选模型列表（只取启用项；被 admin 停用的模型不进扣费确认页）
      if (this.modelType) {
        try {
          this.models = ((await modelApi.list(this.modelType, { enabledOnly: true })) || [])
            .filter((m) => m.enabled !== false); // 前端兜底：后端旧版本/缓存未过滤时不展示禁用项
        } catch {
          this.models = [];
        }
      } else {
        this.models = [];
      }

      // 初始 selection：入参(顶栏记忆的默认，须仍在可用列表中) > 默认/首条模型；视频补首个分辨率
      const init = selection || {};
      const initModelId = (init.modelConfigId && this.models.some((m) => m.id === init.modelConfigId) && init.modelConfigId)
        || (this.models.length ? (this.models.find((m) => m.is_default) || this.models[0]).id : null);
      let initRes = init.resolution || null;
      if (this.modelType === 'video' && initModelId) {
        const m = this.models.find((mm) => mm.id === initModelId);
        const list = m && Array.isArray(m.resolutions) ? m.resolutions : [];
        initRes = list.length ? list[0].value : null;
      } else if (!this.modelType && this.resolutionOptions.length && !initRes) {
        initRes = this.resolutionOptions[0].value; // 静态档位默认取首档（调用方一般已传记忆值，此处兜底）
      }
      this.selection = { modelConfigId: initModelId, resolution: initRes };

      this.estimate = null;
      this.error = '';
      this.visible = true;

      const p = new Promise((res) => { _resolver = res; });
      await this.recompute();
      return p;
    },

    // 用当前 selection 重新估算价格
    async recompute() {
      if (!_estimateFor) {
        this.estimate = { credits: 0 };
        return;
      }
      this.estimating = true;
      this.error = '';
      try {
        const est = await _estimateFor({ ...this.selection });
        this.estimate = est || { credits: 0 };
      } catch (e) {
        this.error = e?.message || i18n.global.t('genConfirm.estimateFailed');
        this.estimate = null;
      } finally {
        this.estimating = false;
      }
    },

    async setModel(id) {
      this.selection.modelConfigId = id;
      // 视频切模型后重置到该模型首个分辨率
      if (this.modelType === 'video') {
        const m = this.models.find((mm) => mm.id === id);
        const list = m && Array.isArray(m.resolutions) ? m.resolutions : [];
        this.selection.resolution = list.length ? list[0].value : null;
      }
      await this.recompute();
    },

    async setResolution(r) {
      this.selection.resolution = r;
      await this.recompute();
    },

    // 私有模型保存后回灌（仅确认弹层还开着时有意义）：重拉模型列表并重估价。
    // preferId 有值且在列表中则自动选中（「使用自己的模型」入口加完模型回来直接就绪）；
    // 原选中模型已不在（被删）时回落默认/首条。视频模型对齐该模型首个分辨率档位。
    async refreshModels(preferId) {
      if (!this.visible || !this.modelType) return;
      try {
        this.models = ((await modelApi.list(this.modelType, { enabledOnly: true })) || [])
          .filter((m) => m.enabled !== false);
      } catch {
        return; // 拉取失败保持原列表（旧列表仍可估价确认）
      }
      const list = this.models;
      if (preferId && list.some((m) => m.id === preferId)) {
        this.selection.modelConfigId = preferId;
      } else if (this.selection.modelConfigId && !list.some((m) => m.id === this.selection.modelConfigId)) {
        this.selection.modelConfigId = list.length ? (list.find((m) => m.is_default) || list[0]).id : null;
      }
      if (this.modelType === 'video') {
        const m = list.find((mm) => mm.id === this.selection.modelConfigId);
        const rs = m && Array.isArray(m.resolutions) ? m.resolutions : [];
        this.selection.resolution = rs.length ? rs[0].value : null;
      }
      await this.recompute();
    },

    // 设置「本次要求」（不改价格，无需 recompute）
    setRequirement(v) {
      this.requirement = typeof v === 'string' ? v : '';
    },

    // 快捷输入：点击把预设追加到「本次要求」末尾（换行分隔），再次点击移除（toggle）
    toggleRequirementPreset(text) {
      const cur = this.requirement || '';
      if (cur.includes(text)) {
        this.requirement = cur.split(text).join('')
          .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n') // 收敛删除遗留的连续空行
          .replace(/\n{2,}/g, '\n') // 两条预设各占一行，删除任一条后残留的空行收敛为单换行
          .replace(/^\n+|\n+$/g, '')
          .trim();
      } else {
        const base = cur.replace(/\s+$/, '');
        this.requirement = base ? `${base}\n${text}` : text;
      }
    },

    // 上传参考图（调用方负责持久化并回传新 URL）
    async uploadReferenceImage(file) {
      if (!_uploadRefImage) return;
      this.refUploading = true;
      this.refError = '';
      try {
        const url = await _uploadRefImage(file);
        this.referenceImage = url || '';
      } catch (e) {
        this.refError = e?.message || i18n.global.t('genConfirm.refUploadFailed');
      } finally {
        this.refUploading = false;
      }
    },

    // 移除参考图
    async removeReferenceImage() {
      if (!_removeRefImage) { this.referenceImage = ''; return; }
      this.refError = '';
      try {
        const url = await _removeRefImage();
        this.referenceImage = url || '';
      } catch (e) {
        this.refError = e?.message || i18n.global.t('genConfirm.refRemoveFailed');
      }
    },

    confirm() {
      const sel = { ...this.selection, requirement: (this.requirement || '').trim() };
      this.visible = false;
      if (_resolver) { _resolver(sel); _resolver = null; }
    },

    cancel() {
      this.visible = false;
      if (_resolver) { _resolver(null); _resolver = null; }
    },
  },
});
