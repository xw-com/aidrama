import http from './http.js';
import router from '../router';
import i18n from '../i18n';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

// ===== 鉴权 =====
// 本地注册/登录/改密（账号密码 + 点选验证码）；令牌静默刷新在 http.js（/auth/oauth/refresh）
export const authApi = {
  login: (data) => http.post('/auth/login', data, { _silent: true }),
  register: (data) => http.post('/auth/register', data, { _silent: true }),
  changePassword: (data) => http.post('/auth/password', { oldPassword: data.oldPassword, newPassword: data.newPassword }, { _silent: true }),
  // —— 档案 ——
  me: (opts) => http.get('/auth/me', opts),
  sync: (profile) => http.post('/auth/sync', profile),
};

// ===== 点选文字验证码（本系统公开接口：登录/发验证码前的人机校验）=====
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
  uploadCover: (id, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post(`/projects/${id}/cover`, fd);
  },
  // 一键分享：确保该剧有分享令牌（幂等），返回 { token }
  ensureShare: (id) => http.post(`/projects/${id}/share`),
  // —— AI 生成封面（素材=用户挑选的角色/场景/道具（默认出镜最多的一个）+ 补充描述 + 前三集概要）——
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

// ===== 美术风格（源自 server/skills/art_skills） =====
export const artStyleApi = {
  list: () => http.get('/art-styles'),
  // 叙事类型列表（{key,name}；展示中心等处做 key→名称映射）
  narrativeTypes: () => http.get('/narrative-types'),
  resolve: (style) => http.get('/art-styles/resolve', { params: { style } }),
  // —— admin 管理 ——
  adminList: () => http.get('/admin/art-styles'),
  create: (data) => http.post('/admin/art-styles', data),
  update: (id, data) => http.put(`/admin/art-styles/${id}`, data),
  remove: (id) => http.delete(`/admin/art-styles/${id}`),
  reorder: (ids) => http.post('/admin/art-styles/reorder', { ids }),
  getPrompt: (id, logical) => http.get(`/admin/art-styles/${id}/prompts/${logical}`),
  savePrompt: (id, logical, content) => http.put(`/admin/art-styles/${id}/prompts/${logical}`, { content }),
  uploadImage: (id, file, type) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post(`/admin/art-styles/${id}/images?type=${type}`, fd);
  },
  genImageEstimate: (modelConfigId) => http.get('/admin/art-styles/generate-image/estimate', { params: { modelConfigId } }),
  genImage: (id, modelConfigId) => http.post(`/admin/art-styles/${id}/generate-image`, { modelConfigId }),
};

// ===== 剧本 =====
export const scriptApi = {
  importText: (projectId, text) => http.post(`/projects/${projectId}/script/import`, { text }),
  importFile: (projectId, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post(`/projects/${projectId}/script/import`, fd);
  },
  parseJs: (projectId) => http.post(`/projects/${projectId}/script/parse-js`),
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
  uploadReferenceImage: (aid, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post(`/assets/${aid}/reference-image`, fd);
  },
  uploadImage: (aid, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post(`/assets/${aid}/image`, fd);
  },
  uploadVideo: (aid, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post(`/assets/${aid}/video`, fd);
  },
  // 视频转图片关键帧：上传视频 + 名称 + 个数，服务端同步均匀抽帧生成 material 素材（名称#1..N）
  createKeyframes: (projectId, { file, name, count }) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', name);
    fd.append('count', String(count));
    return http.post(`/projects/${projectId}/assets/keyframes`, fd);
  },
  extractEstimate: (projectId, sel = {}) => http.get(`/projects/${projectId}/extract/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  extract: (projectId, sel = {}) => http.post(`/projects/${projectId}/extract`, { modelConfigId: sel.modelConfigId }),
  extractEpisodeEstimate: (projectId, eid, sel = {}) => http.get(`/projects/${projectId}/episodes/${eid}/extract/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  extractEpisode: (projectId, eid, sel = {}) => http.post(`/projects/${projectId}/episodes/${eid}/extract`, { modelConfigId: sel.modelConfigId }),
  genImageEstimate: (aid, sel = {}) => http.get(`/assets/${aid}/generate-image/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  genImage: (aid, sel = {}) => http.post(`/assets/${aid}/generate-image`, { modelConfigId: sel.modelConfigId }),
  genPromptEstimate: (aid, sel = {}) => http.get(`/assets/${aid}/generate-prompt/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  genPrompt: (aid, sel = {}) => http.post(`/assets/${aid}/generate-prompt`, { modelConfigId: sel.modelConfigId, requirement: sel.requirement || '' }),
  // —— 服饰（每套服饰 = 一张图）——
  costumes: (aid) => http.get(`/assets/${aid}/costumes`),
  createCostume: (aid, data) => http.post(`/assets/${aid}/costumes`, data),
  uploadCostumeImage: (aid, cid, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post(`/assets/${aid}/costumes/${cid}/image`, fd);
  },
  genCostumeImageEstimate: (aid, cid, sel = {}) => http.get(`/assets/${aid}/costumes/${cid}/generate-image/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  genCostumeImage: (aid, cid, sel = {}) => http.post(`/assets/${aid}/costumes/${cid}/generate-image`, { modelConfigId: sel.modelConfigId }),
  genCostumeImageByRequirement: (aid, cid, sel = {}) => http.post(`/assets/${aid}/costumes/${cid}/generate-image-by-requirement`, { modelConfigId: sel.modelConfigId, requirement: sel.requirement || '' }),
  updateCostume: (aid, cid, data) => http.put(`/assets/${aid}/costumes/${cid}`, data),
  setDefaultCostume: (aid, cid) => http.post(`/assets/${aid}/costumes/${cid}/set-default`),
  removeCostume: (aid, cid) => http.delete(`/assets/${aid}/costumes/${cid}`),
  // —— 按集角色服饰配置 ——
  episodeCostumeConfig: (eid) => http.get(`/episodes/${eid}/costume-config`),
  saveEpisodeCostumeConfig: (eid, configs) => http.put(`/episodes/${eid}/costume-config`, { configs }),
};

// ===== 角色自定义（外貌选项注册表 + 自定义角色创建 + admin 示例图管理） =====
export const characterOptionApi = {
  options: () => http.get('/character-options'),
  createEstimate: (projectId, sel = {}) => http.get(`/projects/${projectId}/characters/custom/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  create: (projectId, data) => http.post(`/projects/${projectId}/characters/custom`, data),
  // —— admin：选项示例图管理 ——
  adminList: () => http.get('/admin/character-options'),
  adminGenEstimate: (sel = {}) => http.get('/admin/character-options/generate-image/estimate', { params: { modelConfigId: sel.modelConfigId } }),
  adminGen: (group, key, modelConfigId) => http.post(`/admin/character-options/${group}/${key}/generate-image`, { modelConfigId }),
  adminBatchEstimate: (sel = {}) => http.get('/admin/character-options/generate-missing/estimate', { params: { modelConfigId: sel.modelConfigId } }),
  adminBatch: (modelConfigId) => http.post('/admin/character-options/generate-missing', { modelConfigId }),
};

// ===== 分镜 =====
export const storyboardApi = {
  segments: (eid) => http.get(`/episodes/${eid}/segments`),
  createSegment: (eid, data = {}) => http.post(`/episodes/${eid}/segments`, data),
  genStoryboardEstimate: (eid, sel = {}) => http.get(`/episodes/${eid}/generate-storyboard/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  genStoryboard: (eid, sel = {}) => http.post(`/episodes/${eid}/generate-storyboard`, { modelConfigId: sel.modelConfigId, requirement: sel.requirement || '' }),
  updateSegment: (sid, data) => http.put(`/segments/${sid}`, data),
  // 移动分镜位置：direction = -1 与前一分镜交换 | 1 与后一分镜交换；返回全集最新分镜列表
  moveSegment: (sid, direction) => http.post(`/segments/${sid}/move`, { direction }),
  deleteSegment: (sid) => http.delete(`/segments/${sid}`),
  deleteVideo: (sid) => http.delete(`/segments/${sid}/video`),
  // 审阅/取消审阅分镜视频（换视频后服务端自动重置审阅标记）
  reviewSegment: (sid, reviewed = true) => http.post(`/segments/${sid}/review`, { reviewed }),
  uploadVideo: (sid, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post(`/segments/${sid}/upload-video`, fd);
  },
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
  // 在线剪辑（独立编辑窗口）
  editSource: (jobId) => http.get(`/videos/${jobId}/edit`),
  editEstimate: (jobId, resolution, seconds) => http.get(`/videos/${jobId}/edit/estimate`, { params: { resolution, seconds } }),
  exportEdit: (jobId, body) => http.post(`/videos/${jobId}/edit`, body),
};

// ===== 模型配置 =====
export const modelApi = {
  list: (type, { enabledOnly = false } = {}) => http.get('/model-configs', { params: { type, ...(enabledOnly ? { enabled: '1' } : {}) } }),
  active: (type) => http.get(`/model-configs/active/${type}`),
  create: (data) => http.post('/model-configs', data),
  update: (id, data) => http.put(`/model-configs/${id}`, data),
  remove: (id) => http.delete(`/model-configs/${id}`),
  exportCfg: (withKeys) => http.get('/model-configs/export', { params: { keys: withKeys ? '1' : '0' } }),
  importCfg: (configs) => http.post('/model-configs/import', { configs }),
  // 视频任务状态查询（admin 调试）：按模型配置转发厂商查询，返回原始响应文本
  queryTask: (id, taskId) => http.post(`/model-configs/${id}/task-query`, { task_id: taskId }),
  // 我的私有模型（个人设置；自带 Key，调用不计积分，列表置顶）
  myList: () => http.get('/model-configs/my'),
  myCreate: (data) => http.post('/model-configs/my', data),
  myUpdate: (id, data) => http.put(`/model-configs/my/${id}`, data),
  myRemove: (id) => http.delete(`/model-configs/my/${id}`),
};

// ===== 模型厂商 =====
export const vendorApi = {
  list: () => http.get('/model-vendors'),
  create: (data) => http.post('/model-vendors', data),
  update: (id, data) => http.put(`/model-vendors/${id}`, data),
  remove: (id) => http.delete(`/model-vendors/${id}`),
  exportVendors: () => http.get('/model-vendors/export'),
  importVendors: (vendors) => http.post('/model-vendors/import', { vendors }),
  // 用户侧厂商目录（仅启用项；私有模型配置页选厂商/模型用）
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
  upload: (id, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return http.post(`/voices/${id}/upload`, fd);
  },
};

// ===== 剧本草稿（用户级 · 4 步向导工作台） =====
export const scriptDraftApi = {
  list: () => http.get('/scripts'),
  get: (id) => http.get(`/scripts/${id}`),
  create: (data = {}) => http.post('/scripts', data),
  update: (id, data) => http.put(`/scripts/${id}`, data),
  remove: (id) => http.delete(`/scripts/${id}`),
  // 分集读写（第 2/3 步编辑）
  listEpisodes: (id) => http.get(`/scripts/${id}/episodes`),
  updateEpisode: (id, eid, data) => http.put(`/scripts/${id}/episodes/${eid}`, data),
  // 第 1 步定稿：生成大纲
  outlineEstimate: (id, sel = {}) => http.get(`/scripts/${id}/outline/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  outline: (id, sel = {}) => http.post(`/scripts/${id}/outline`, { modelConfigId: sel.modelConfigId }),
  // 第 2 步：分集 + 概要
  splitEstimate: (id, sel = {}) => http.get(`/scripts/${id}/episodes/split/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  split: (id, body = {}) => http.post(`/scripts/${id}/episodes/split`, body),
  // 第 3 步：逐集细化
  detailEstimate: (id, eid, sel = {}) => http.get(`/scripts/${id}/episodes/${eid}/detail/estimate`, { params: { modelConfigId: sel.modelConfigId } }),
  detail: (id, eid, sel = {}) => http.post(`/scripts/${id}/episodes/${eid}/detail`, { modelConfigId: sel.modelConfigId }),
  // 第 4 步：导出到项目
  exportTo: (id, body) => http.post(`/scripts/${id}/export`, body),
};

/**
 * 第 1 步大纲对话（免费 SSE 流式）：fetch + ReadableStream 读 SSE（不走 axios，避免缓冲）。
 * @returns {Promise<boolean>} 是否正常完成（未出错）
 */
export async function streamOutlineChat({ scriptId, message, narrativeType, modelConfigId, onDelta, onError, signal }) {
  const resp = await fetch(`${API_BASE}/scripts/${scriptId}/outline/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (localStorage.getItem('aidrama-token') || ''),
    },
    body: JSON.stringify({ message, narrativeType, modelConfigId }),
    signal,
  });
  if (!resp.ok) {
    if (resp.status === 401) {
      localStorage.removeItem('aidrama-token');
      router.push('/login');
    }
    let msg = i18n.global.t('errors.requestFailedStatus', { status: resp.status });
    try { const body = await resp.json(); msg = body.message || msg; } catch { /* ignore */ }
    onError?.(msg);
    return false;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) { // eslint-disable-line no-constant-condition
    const { value, done } = await reader.read(); // eslint-disable-line no-await-in-loop
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.replace(/^data:\s*/, '').trim();
      if (!line || line === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.error) onError?.(obj.error);
      else if (obj.delta) onDelta?.(obj.delta);
    }
  }
  return true;
}

// ===== 积分 =====
export const creditApi = {
  balance: () => http.get('/credits/balance'),
  transactions: (page = 1, size = 20) => http.get('/credits/transactions', { params: { page, size } }),
};

// ===== 用户查找（团队共享成员拉取复用） =====
export const userLookupApi = (identifier) => http.get('/users/lookup', { params: { identifier } });

// ===== 支付管理（admin：订单/流水/人工调整/档位/支付配置） =====
export const paymentAdminApi = {
  orders: (params) => http.get('/admin/payments/orders', { params }),
  transactions: (params) => http.get('/admin/payments/transactions', { params }),
  adjust: (data) => http.post('/admin/payments/adjust', data),
  packages: () => http.get('/admin/payments/packages'),
  savePackages: (data) => http.put('/admin/payments/packages', data),
  payConfig: () => http.get('/admin/payments/pay-config'),
  refund: (orderNo, data) => http.post(`/admin/payments/orders/${orderNo}/refund`, data),
  refundStatus: (orderNo) => http.get(`/admin/payments/orders/${orderNo}/refund-status`),
};

// ===== 用户管理（admin：列表/封禁/登录密码重置/登录日志/登录配置） =====
export const userAdminApi = {
  list: (params) => http.get('/admin/users', { params }),
  setStatus: (id, status) => http.put(`/admin/users/${id}/status`, { status }),
  setPassword: (id, password) => http.put(`/admin/users/${id}/password`, { password }),
  loginAs: (id) => http.post(`/admin/users/${id}/login-as`),
  loginLogs: (params) => http.get('/admin/users/login-logs', { params }),
  loginConfig: () => http.get('/admin/users/login-config'),
};

// ===== 任务管理（admin：全员任务列表/取消/删除/批量清理） =====
export const jobAdminApi = {
  list: (params) => http.get('/admin/jobs', { params }),
  get: (id) => http.get(`/admin/jobs/${id}`),
  // 取消：pending 撤队；running 强制取消（绕过 10 分钟），退款给任务属主
  cancel: (id) => http.post(`/admin/jobs/${id}/cancel`),
  remove: (id) => http.delete(`/admin/jobs/${id}`),
  // 批量清理终态记录：{ status: 'all'|'succeeded'|'failed'|'cancelled', before: 'all'|'week'|'month'|'year', user_id? }
  cleanup: (data) => http.post('/admin/jobs/cleanup', data),
};

// ===== 视频生成留档（admin：全员列表/详情，只读） =====
export const videoGenAdminApi = {
  list: (params) => http.get('/admin/video-generations', { params }),
  get: (id) => http.get(`/admin/video-generations/${id}`),
};

// ===== 展示审核（admin：列表/通过/驳回） =====
export const showcaseAdminApi = {
  list: (params) => http.get('/admin/showcase', { params }),
  setStatus: (id, status, reason) => http.put(`/admin/showcase/${id}/status`, { status, reason }),
};

// ===== 充值 =====
export const rechargeApi = {
  packages: () => http.get('/recharge/packages'),
  create: (data) => http.post('/recharge/create', data),
  orders: () => http.get('/recharge/orders'),
  order: (id) => http.get(`/recharge/orders/${id}`),
};

// ===== 定价 =====
export const pricingApi = {
  list: () => http.get('/pricing'),
};

// ===== 功能定价管理（admin，含停用行；行缺失/停用 = 该功能按 0 积分放行） =====
export const pricingAdminApi = {
  list: () => http.get('/admin/pricing'),
  create: (data) => http.post('/admin/pricing', data),
  update: (id, data) => http.put(`/admin/pricing/${id}`, data),
};

// ===== 公开分享（免登录播放页 /share/:token 用；_silent：错误由页面渲染专属错误态，不弹 toast） =====
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

// ===== 团队共享：我的邀请（受邀者） =====
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

// ===== 服务器维护（admin） =====
export const maintenanceApi = {
  status: () => http.get('/admin/maintenance/status'),
  start: (data) => http.post('/admin/maintenance/start', data),
  stop: () => http.post('/admin/maintenance/stop'),
  tasks: () => http.get('/admin/maintenance/tasks'),
};

// ===== 日志管理（admin，AI 提交留档文件） =====
export const logApi = {
  dates: () => http.get('/admin/logs/dates'),
  files: (params) => http.get('/admin/logs/files', { params }),
  detail: (params) => http.get('/admin/logs/detail', { params }),
  removeFile: (params) => http.delete('/admin/logs/file', { params }),
  removeDay: (date) => http.delete(`/admin/logs/date/${date}`),
};

// ===== 展示中心（发布/浏览/观看） =====
export const showcaseApi = {
  list: (params) => http.get('/showcase', { params }),
  detail: (id) => http.get(`/showcase/${id}`),
  status: (projectId) => http.get('/showcase/status', { params: { project_id: projectId } }),
  // episodeIds：勾选发布的分集 id 数组（null=全部可播分集）
  publish: (projectId, description = '', episodeIds = null) => http.post('/showcase/publish', { project_id: projectId, description, episode_ids: episodeIds }),
  remove: (id) => http.delete(`/showcase/${id}`),
};

// ===== 接单中心（任务单：发布托管/接单/交付/验收/仲裁） =====
export const marketApi = {
  orders: (params) => http.get('/market/orders', { params }),
  order: (id) => http.get(`/market/orders/${id}`),
  create: (data) => http.post('/market/orders', data),
  take: (id) => http.post(`/market/orders/${id}/take`),
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
  videoApi, modelApi, vendorApi, creditApi, rechargeApi, pricingApi, jobApi, shareApi, maintenanceApi, memberApi, invitationApi,
  showcaseApi, marketApi, characterOptionApi, logApi,
  paymentAdminApi, userAdminApi, jobAdminApi,
};
