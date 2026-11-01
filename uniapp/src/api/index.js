/**
 * 业务 API 全量移植（自 client/src/api/index.js）。
 * 差异点：
 * - 上传：FormData → http.upload(url, filePath)（uni 临时文件路径）
 * - SSE：fetch 直写 → createSSE 分端适配
 * 契约（URL / 参数 / 返回值）与 client 完全一致。
 */
import http, { bailSession } from './http.js';
import { getItem, KEYS } from '../utils/storage';
import {
  localLogin,
  localRegister,
  localChangePassword,
} from './auth';
import i18n from '../i18n';
import { confirm } from '../utils/ui';
import { createSSE } from './sse';

// ===== 鉴权 =====
// 本地账号体系（用户名/邮箱/手机号 + 密码，注册过点选验证码）；刷新在 http.js、档案同步走本系统 /api
export const authApi = {
  login: (payload) => localLogin(payload),
  register: (payload) => localRegister(payload),
  // axt_ 会话为 AIDrama 自签无状态 JWT：无服务端会话可撤销，本地清令牌登出即可
  // （封禁由服务端每请求重查兜底）
  logout: () => Promise.resolve(),
  changePassword: (data) => localChangePassword(data),
  // 第三方一键登录：AIDrama 服务端持密代理换取（契约同 /auth/login 的 { user, tokens } 信封）。
  // provider: weixin | apple | huawei | google；payload 里 code / authResult 由各端 uni.login 取得
  oauthLogin: (provider, payload) => http.post(`/auth/oauth/${provider}`, payload),
  me: () => http.get('/auth/me'),
  sync: (profile) => http.post('/auth/sync', profile),
};

// ===== 点选文字验证码 =====
export const captchaApi = {
  challenge: () => http.post('/captcha/challenge'),
  verify: (data) => http.post('/captcha/verify', data),
};

// ===== 项目 =====
export const projectApi = {
  list: () => http.get('/projects'),
  get: (id) => http.get(`/projects/${id}`),
  // 分集列表（后端分页）：{ page, size } 拉一页（size>总数即全量）；find=episodeId 直接返回该集所在页
  episodesPage: (id, { page, size, find } = {}) => http.get(`/projects/${id}/episodes`, {
    params: { ...(page ? { page } : {}), ...(size ? { size } : {}), ...(find ? { find } : {}) },
  }),
  create: (data) => http.post('/projects', data),
  update: (id, data) => http.put(`/projects/${id}`, data),
  remove: (id) => http.delete(`/projects/${id}`),
  uploadCover: (id, filePath) => http.upload(`/projects/${id}/cover`, filePath),
  ensureShare: (id) => http.post(`/projects/${id}/share`),
  coverAiMaterials: (id) => http.get(`/projects/${id}/cover/ai/materials`),
  coverAiEstimate: (id, modelConfigId) => http.get(`/projects/${id}/cover/ai/estimate`, { params: { modelConfigId } }),
  coverAi: (id, modelConfigId, picks = {}) => http.post(`/projects/${id}/cover/ai`, {
    modelConfigId,
    character_ids: picks.characterIds,
    scene_ids: picks.sceneIds,
    prop_ids: picks.propIds,
    description: picks.description,
  }),
};

// ===== 美术风格 =====
export const artStyleApi = {
  list: () => http.get('/art-styles'),
  narrativeTypes: () => http.get('/narrative-types'),
  resolve: (style) => http.get('/art-styles/resolve', { params: { style } }),
};

// ===== 剧本 =====
// asJob=true：服务端走任务模式（立即返回 { job }，后台执行+进度上报），配合 utils/job.pollJob 轮询
export const scriptApi = {
  importText: (projectId, text, asJob = false) => http.post(`/projects/${projectId}/script/import`, { text, async: asJob || undefined }),
  importFile: (projectId, filePath, asJob = false) => http.upload(`/projects/${projectId}/script/import`, filePath, { formData: asJob ? { async: '1' } : undefined }),
  parseJs: (projectId, asJob = false) => http.post(`/projects/${projectId}/script/parse-js`, asJob ? { async: true } : undefined),
  getEpisode: (eid) => http.get(`/episodes/${eid}`),
  createEpisode: (projectId, data) => http.post(`/projects/${projectId}/episodes`, data),
  updateEpisode: (eid, data) => http.put(`/episodes/${eid}`, data),
  deleteEpisode: (eid) => http.delete(`/episodes/${eid}`),
};

// ===== 资产 =====
export const assetApi = {
  list: (projectId, type) => http.get(`/projects/${projectId}/assets`, { params: { type } }),
  create: (projectId, data) => http.post(`/projects/${projectId}/assets`, data),
  update: (aid, data) => http.put(`/assets/${aid}`, data),
  remove: (aid) => http.delete(`/assets/${aid}`),
  uploadReferenceImage: (aid, filePath) => http.upload(`/assets/${aid}/reference-image`, filePath),
  uploadImage: (aid, filePath) => http.upload(`/assets/${aid}/image`, filePath),
  uploadVideo: (aid, filePath) => http.upload(`/assets/${aid}/video`, filePath),
  createKeyframes: (projectId, { filePath, name, count }) => http.upload(`/projects/${projectId}/assets/keyframes`, filePath, { formData: { name, count: String(count) } }),
  extractEstimate: (projectId, sel = {}) => http.get(`/projects/${projectId}/extract/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  extract: (projectId, sel = {}) => http.post(`/projects/${projectId}/extract`, { modelConfigId: sel.modelConfigId }),
  extractEpisodeEstimate: (projectId, eid, sel = {}) => http.get(`/projects/${projectId}/episodes/${eid}/extract/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  extractEpisode: (projectId, eid, sel = {}) => http.post(`/projects/${projectId}/episodes/${eid}/extract`, { modelConfigId: sel.modelConfigId }),
  genImageEstimate: (aid, sel = {}) => http.get(`/assets/${aid}/generate-image/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  genImage: (aid, sel = {}) => http.post(`/assets/${aid}/generate-image`, { modelConfigId: sel.modelConfigId }),
  genPromptEstimate: (aid, sel = {}) => http.get(`/assets/${aid}/generate-prompt/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  genPrompt: (aid, sel = {}) => http.post(`/assets/${aid}/generate-prompt`, { modelConfigId: sel.modelConfigId, requirement: sel.requirement || '' }),
  costumes: (aid) => http.get(`/assets/${aid}/costumes`),
  createCostume: (aid, data) => http.post(`/assets/${aid}/costumes`, data),
  uploadCostumeImage: (aid, cid, filePath) => http.upload(`/assets/${aid}/costumes/${cid}/image`, filePath),
  genCostumeImageEstimate: (aid, cid, sel = {}) => http.get(`/assets/${aid}/costumes/${cid}/generate-image/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  genCostumeImage: (aid, cid, sel = {}) => http.post(`/assets/${aid}/costumes/${cid}/generate-image`, { modelConfigId: sel.modelConfigId }),
  genCostumeImageByRequirement: (aid, cid, sel = {}) => http.post(`/assets/${aid}/costumes/${cid}/generate-image-by-requirement`, { modelConfigId: sel.modelConfigId, requirement: sel.requirement || '' }),
  updateCostume: (aid, cid, data) => http.put(`/assets/${aid}/costumes/${cid}`, data),
  setDefaultCostume: (aid, cid) => http.post(`/assets/${aid}/costumes/${cid}/set-default`),
  removeCostume: (aid, cid) => http.delete(`/assets/${aid}/costumes/${cid}`),
  episodeCostumeConfig: (eid) => http.get(`/episodes/${eid}/costume-config`),
  saveEpisodeCostumeConfig: (eid, configs) => http.put(`/episodes/${eid}/costume-config`, { configs }),
};

// ===== 角色自定义 =====
export const characterOptionApi = {
  options: () => http.get('/character-options'),
  createEstimate: (projectId, sel = {}) => http.get(`/projects/${projectId}/characters/custom/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  create: (projectId, data) => http.post(`/projects/${projectId}/characters/custom`, data),
};

// ===== 分镜 =====
export const storyboardApi = {
  segments: (eid) => http.get(`/episodes/${eid}/segments`),
  createSegment: (eid, data = {}) => http.post(`/episodes/${eid}/segments`, data),
  genStoryboardEstimate: (eid, sel = {}) => http.get(`/episodes/${eid}/generate-storyboard/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  genStoryboard: (eid, sel = {}) => http.post(`/episodes/${eid}/generate-storyboard`, { modelConfigId: sel.modelConfigId, requirement: sel.requirement || '' }),
  updateSegment: (sid, data) => http.put(`/segments/${sid}`, data),
  moveSegment: (sid, direction) => http.post(`/segments/${sid}/move`, { direction }),
  deleteSegment: (sid) => http.delete(`/segments/${sid}`),
  deleteVideo: (sid) => http.delete(`/segments/${sid}/video`),
  // 审阅/取消审阅分镜视频（换视频后服务端自动重置审阅标记）
  reviewSegment: (sid, reviewed = true) => http.post(`/segments/${sid}/review`, { reviewed }),
  uploadVideo: (sid, filePath) => http.upload(`/segments/${sid}/upload-video`, filePath),
  selectSegments: (eid, ids, selected) => http.put(`/episodes/${eid}/segments/select`, { ids, selected }),
  auditSegments: (eid) => http.post(`/episodes/${eid}/segments/audit`),
  applyAudit: (eid, body = {}) => http.post(`/episodes/${eid}/segments/audit/apply`, body),
  genEstimate: (sid, params) => http.get(`/segments/${sid}/generate/estimate`, { params }),
  generate: (sid, body) => http.post(`/segments/${sid}/generate`, body),
  generateVideo: (sid, body) => http.post(`/segments/${sid}/generate-video`, body),
  eraseSubtitle: (sid, body) => http.post(`/segments/${sid}/erase-subtitle`, body),
  generateBatch: (eid, body) => http.post(`/episodes/${eid}/segments/generate-video-batch`, body),
  generateBatchConcurrent: (eid, body) => http.post(`/episodes/${eid}/segments/generate-video-batch-concurrent`, body),
  genPromptEstimate: (sid, sel = {}) => http.get(`/segments/${sid}/generate-prompt/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  genPrompt: (sid, sel = {}) => http.post(`/segments/${sid}/generate-prompt`, { modelConfigId: sel.modelConfigId, requirement: sel.requirement || '' }),
};

// ===== 视频 =====
export const videoApi = {
  composeEstimate: (eid, resolution) => http.get(`/episodes/${eid}/compose/estimate`, { params: { resolution } }),
  compose: (eid, body = {}) => http.post(`/episodes/${eid}/compose`, body),
  get: (eid) => http.get(`/episodes/${eid}/video`),
  projectVideos: (pid) => http.get(`/projects/${pid}/videos`),
  deleteFilm: (jobId) => http.delete(`/videos/${jobId}`),
  // 审阅/取消审阅成片（按成片记录 id；每条成片记录独立审阅）
  reviewFilm: (id, reviewed = true) => http.post(`/videos/${id}/review`, { reviewed }),
  subtitleEstimate: (jobId, sel = {}) => http.get(`/videos/${jobId}/subtitle/estimate`, { params: { modelConfigId: sel.modelConfigId || undefined } }),
  addSubtitle: (jobId, sel = {}) => http.post(`/videos/${jobId}/subtitle`, { modelConfigId: sel.modelConfigId || null }),
  subtitleSegments: (jobId) => http.get(`/videos/${jobId}/subtitle/segments`),
  saveSubtitleSegments: (jobId, segments) => http.put(`/videos/${jobId}/subtitle/segments`, { segments }),
  burnSubtitle: (jobId, segments) => http.post(`/videos/${jobId}/subtitle/burn`, { segments }),
  subtitleCorrectEstimate: (jobId, sel = {}) => http.get(`/videos/${jobId}/subtitle/correct/estimate`, { params: { modelConfigId: sel.modelConfigId || undefined } }),
  correctSubtitle: (jobId, segments, sel = {}) => http.post(`/videos/${jobId}/subtitle/correct`, { segments, modelConfigId: sel.modelConfigId || null }),
  editSource: (jobId) => http.get(`/videos/${jobId}/edit`),
  editEstimate: (jobId, resolution, seconds) => http.get(`/videos/${jobId}/edit/estimate`, { params: { resolution, seconds } }),
  exportEdit: (jobId, body) => http.post(`/videos/${jobId}/edit`, body),
};

// ===== 模型配置（用户侧：列出启用模型供确认页选择） =====
export const modelApi = {
  list: (type, { enabledOnly = false } = {}) => http.get('/model-configs', { params: { type, ...(enabledOnly ? { enabled: '1' } : {}) } }),
  active: (type) => http.get(`/model-configs/active/${type}`),
  // 我的私有模型（个人设置；自带 Key，调用不计积分，列表置顶）
  myList: () => http.get('/model-configs/my'),
  myCreate: (data) => http.post('/model-configs/my', data),
  myUpdate: (id, data) => http.put(`/model-configs/my/${id}`, data),
  myRemove: (id) => http.delete(`/model-configs/my/${id}`),
};

// ===== 模型厂商（用户侧目录：私有模型配置页选厂商/模型用） =====
export const vendorApi = {
  catalog: () => http.get('/model-vendors/catalog'),
  // 用用户密钥实时拉取厂商模型清单（仅 OpenAI 兼容厂商；baseUrl 缺省走厂商预设）
  fetchModels: (code, apiKey, baseUrl) => http.post('/model-vendors/fetch-models', { code, api_key: apiKey, ...(baseUrl ? { base_url: baseUrl } : {}) }),
};

// ===== 声音库（用户级） =====
export const voiceApi = {
  list: () => http.get('/voices'),
  create: (data) => http.post('/voices', data),
  update: (id, data) => http.put(`/voices/${id}`, data),
  remove: (id) => http.delete(`/voices/${id}`),
  upload: (id, filePath) => http.upload(`/voices/${id}/upload`, filePath),
};

// ===== 剧本草稿（4 步向导） =====
export const scriptDraftApi = {
  list: () => http.get('/scripts'),
  get: (id) => http.get(`/scripts/${id}`),
  create: (data = {}) => http.post('/scripts', data),
  update: (id, data) => http.put(`/scripts/${id}`, data),
  remove: (id) => http.delete(`/scripts/${id}`),
  listEpisodes: (id) => http.get(`/scripts/${id}/episodes`),
  updateEpisode: (id, eid, data) => http.put(`/scripts/${id}/episodes/${eid}`, data),
  outlineEstimate: (id, sel = {}) => http.get(`/scripts/${id}/outline/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  outline: (id, sel = {}) => http.post(`/scripts/${id}/outline`, { modelConfigId: sel.modelConfigId }),
  splitEstimate: (id, sel = {}) => http.get(`/scripts/${id}/episodes/split/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  split: (id, body = {}) => http.post(`/scripts/${id}/episodes/split`, body),
  detailEstimate: (id, eid, sel = {}) => http.get(`/scripts/${id}/episodes/${eid}/detail/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  detail: (id, eid, sel = {}) => http.post(`/scripts/${id}/episodes/${eid}/detail`, { modelConfigId: sel.modelConfigId }),
  exportTo: (id, body) => http.post(`/scripts/${id}/export`, body),
};

/**
 * 第 1 步大纲对话（免费 SSE 流式）。
 * @returns {Promise<boolean>} 是否正常完成
 */
export function streamOutlineChat({ scriptId, message, narrativeType, modelConfigId, onDelta, onError, signal }) {
  const sse = createSSE({
    url: `/scripts/${scriptId}/outline/chat`,
    body: { message, narrativeType, modelConfigId },
    headers: { Authorization: 'Bearer ' + (getItem(KEYS.token) || '') },
    onDelta,
    onError,
  });
  if (signal) signal.addEventListener('abort', () => sse.abort());
  return sse.run();
}

// ===== 积分 =====
export const creditApi = {
  balance: () => http.get('/credits/balance'),
  transactions: (page = 1, size = 20) => http.get('/credits/transactions', { params: { page, size } }),
};

// ===== 充值 =====
export const rechargeApi = {
  packages: () => http.get('/recharge/packages'),
  create: (data) => http.post('/recharge/create', data),
  orders: () => http.get('/recharge/orders'),
  order: (id) => http.get(`/recharge/orders/${id}`),
  // JSAPI 支付（WECHAT_PAY_METHOD=jsapi 时）：公众号静默授权链接 + code 换 openid（仅 H5 调用）
  jsapiAuthUrl: (redirect) => http.get('/recharge/wechat/jsapi-auth-url', { params: { redirect } }),
  jsapiOpenid: (code) => http.post('/recharge/wechat/jsapi-openid', { code }),
};

// ===== 定价 =====
export const pricingApi = {
  list: () => http.get('/pricing'),
};

// ===== App 版本更新（仅 App 端调用；服务端契约：data = { hasUpdate, latest, notes, url, force }，
//       消费方 utils/appUpdate.js —— Android 弹窗跳 url 下载，iOS 走 App Store 不弹） =====
export const appApi = {
  checkUpdate: (platform, current) => http.get('/app/check-update', { params: { platform, current }, _silent: true }),
};

// ===== 公开分享（免登录，_silent 由页面渲染错误态） =====
export const shareApi = {
  get: (token) => http.get(`/public/share/${token}`, { _silent: true }),
};

// ===== 团队共享：成员管理（owner） =====
export const memberApi = {
  members: (projectId) => http.get(`/projects/${projectId}/members`),
  lookup: (identifier) => http.get('/users/lookup', { params: { identifier } }),
  invite: (projectId, identifier, permissions = []) => http.post(`/projects/${projectId}/members/invitations`, { identifier, permissions }),
  pendingInvites: (projectId) => http.get(`/projects/${projectId}/members/invitations`),
  updatePermissions: (projectId, userId, permissions) => http.put(`/projects/${projectId}/members/${userId}`, { permissions }),
  removeMember: (projectId, userId) => http.delete(`/projects/${projectId}/members/${userId}`),
  leave: (projectId) => http.post(`/projects/${projectId}/leave`),
};

// ===== 团队共享：我的邀请 =====
export const invitationApi = {
  list: () => http.get('/invitations'),
  accept: (id) => http.post(`/invitations/${id}/accept`),
  reject: (id) => http.post(`/invitations/${id}/reject`),
  revoke: (id) => http.post(`/invitations/${id}/revoke`),
};

// ===== 任务中心 =====
export const jobApi = {
  list: (params) => http.get('/jobs', { params }),
  get: (id) => http.get(`/jobs/${id}`),
  cancel: (id) => http.post(`/jobs/${id}/cancel`),
  // 批量删除历史任务：{ status: 'all'|'succeeded'|'failed', before: 'all'|'week'|'month'|'year' }
  cleanup: (data) => http.post('/jobs/cleanup', data),
};

// ===== 展示中心 =====
export const showcaseApi = {
  list: (params) => http.get('/showcase', { params }),
  detail: (id) => http.get(`/showcase/${id}`),
  status: (projectId) => http.get('/showcase/status', { params: { project_id: projectId } }),
  publish: (projectId, description = '', episodeIds = null) => http.post('/showcase/publish', { project_id: projectId, description, episode_ids: episodeIds }),
  remove: (id) => http.delete(`/showcase/${id}`),
};

// ===== 接单中心 =====
export const marketApi = {
  orders: (params) => http.get('/market/orders', { params }),
  order: (id) => http.get(`/market/orders/${id}`),
  create: (data) => http.post('/market/orders', data),
  take: (id, data) => http.post(`/market/orders/${id}/take`, data || {}),
  cancel: (id, reason = '') => http.post(`/market/orders/${id}/cancel`, { reason }),
  quit: (id, reason = '') => http.post(`/market/orders/${id}/quit`, { reason }),
  deliver: (id, data) => http.post(`/market/orders/${id}/deliver`, data),
  reject: (id, reason) => http.post(`/market/orders/${id}/reject`, { reason }),
  accept: (id) => http.post(`/market/orders/${id}/accept`),
  dispute: (id, reason) => http.post(`/market/orders/${id}/dispute`, { reason }),
  arbitrate: (id, decision, note = '') => http.post(`/market/orders/${id}/arbitrate`, { decision, note }),
  myDeliverables: () => http.get('/market/my-deliverables'),
};

export default {
  authApi, projectApi, scriptApi, assetApi, storyboardApi,
  videoApi, modelApi, voiceApi, creditApi, rechargeApi, pricingApi, jobApi, shareApi, memberApi, invitationApi,
  showcaseApi, marketApi, characterOptionApi, artStyleApi, scriptDraftApi,
};

/** 未登录访问需登录区时的统一引导（401 之外的本地拦截用） */
export function requireLogin(redirect) {
  const t = i18n.global.t;
  confirm({
    title: t('common.tip'),
    content: t('login.needLogin'),
    confirmText: t('login.goLogin'),
  }).then((ok) => {
    if (!ok) return;
    const target = redirect ? `?redirect=${encodeURIComponent(redirect)}` : '';
    const url = `/pages/login/index${target}`;
    // 鸿蒙端：导航不能包在 setTimeout 里发（会报 Converting circular structure to
    // JSON 直接失败），也不带 success/fail 回调；在确认框 resolve 的微任务里直发
    uni.navigateTo({ url });
  });
}
