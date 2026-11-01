import { Router } from 'express';
import db from '../db/index.js';
import { asyncHandler, ok, badRequest } from '../utils/index.js';
import { logger } from '../utils/index.js';
import { authRequired } from '../middleware/auth.js';
import { loadOwnedProject } from '../utils/ownership.js';
import { deleteUrlFiles } from '../utils/fileUtil.js';
import { estimateTextCost, assertBalance, attachTierPricing, applyModelPromo } from '../services/pricing.service.js';
import { withCredits } from '../services/credits.service.js';
import { getConfig, resolveConfig } from '../services/modelConfig.service.js';
import { createJob, submit, deleteEpisodeArtifacts } from '../services/job.service.js';
import { chatStream } from '../services/llm.service.js';
import {
  buildOutlineMessages, generateOutline, formatOutline, splitEpisodes, expandEpisode,
} from '../services/ai/scriptWriter.service.js';

const router = Router();
const { Script, ScriptEpisode, Project, Episode, StoryboardSegment } = db;

// 解析文本生成所用模型配置（用于计费）：指定 id > 默认文本模型 > null（走全局定价兜底）
async function loadTextCfg(userId, modelConfigId) {
  try {
    if (modelConfigId) return await getConfig(userId, modelConfigId);
    return await resolveConfig(userId, 'text');
  } catch { return null; }
}

async function loadOwnedScript(userId, scriptId, { includeEpisodes = false } = {}) {
  const row = await Script.findOne({
    where: { id: scriptId, user_id: userId },
    ...(includeEpisodes && {
      include: [{ association: 'episodes', separate: true, order: [['idx', 'ASC']] }],
    }),
  });
  if (!row) throw badRequest('common.not_found');
  return row;
}

async function loadOwnedScriptEpisode(userId, scriptId, episodeId) {
  const script = await Script.findOne({ where: { id: scriptId, user_id: userId } });
  if (!script) throw badRequest('common.not_found');
  const episode = await ScriptEpisode.findOne({ where: { id: episodeId, script_id: scriptId } });
  if (!episode) throw badRequest('common.not_found');
  return { script, episode };
}

// ============ 草稿 CRUD ============

// 列表：当前用户的剧本草稿（最近更新在前）
router.get('/', authRequired, asyncHandler(async (req, res) => {
  const rows = await Script.findAll({
    where: { user_id: req.user.id },
    order: [['updated_at', 'DESC']],
    attributes: { exclude: ['chat'] }, // 列表不带对话历史，减小载荷
  });
  return ok(res, rows);
}));

// 详情（含分集）
router.get('/:id', authRequired, asyncHandler(async (req, res) => {
  const row = await loadOwnedScript(req.user.id, req.params.id, { includeEpisodes: true });
  return ok(res, row);
}));

// 新建
router.post('/', authRequired, asyncHandler(async (req, res) => {
  const { title, content } = req.body;
  const row = await Script.create({
    user_id: req.user.id,
    title: title || '未命名剧本',
    content: content || '',
  });
  return ok(res, row, 'scriptDraft.created');
}));

// 更新（自动保存：标题 / 手写正文 / 大纲 / 题材 / 当前步骤）
router.put('/:id', authRequired, asyncHandler(async (req, res) => {
  const row = await loadOwnedScript(req.user.id, req.params.id);
  const { title, content, outline, narrative_type, stage } = req.body;
  await row.update({
    ...(title !== undefined && { title }),
    ...(content !== undefined && { content }),
    ...(outline !== undefined && { outline }),
    ...(narrative_type !== undefined && { narrative_type }),
    ...(stage !== undefined && { stage }),
  });
  return ok(res, row, 'scriptDraft.saved');
}));

// 删除（级联删除分集）
router.delete('/:id', authRequired, asyncHandler(async (req, res) => {
  const row = await loadOwnedScript(req.user.id, req.params.id);
  await row.destroy();
  return ok(res, null, 'scriptDraft.deleted');
}));

// ============ 第 1 步：对话打磨创意（免费 SSE 流式） ============

/**
 * POST /api/scripts/:id/outline/chat  body: { message, narrativeType?, modelConfigId? }
 * 免费、不接入积分。先 prime 一次（使 resolveConfig / 上游错误在写 SSE 头之前作为 JSON 抛出），
 * 再以 text/event-stream 逐段推送 {delta}，结束推送 {done:true}，并把对话历史落库。
 */
router.post('/:id/outline/chat', authRequired, asyncHandler(async (req, res) => {
  const script = await loadOwnedScript(req.user.id, req.params.id);
  const message = String(req.body?.message || '').trim();
  if (!message) throw badRequest('scriptDraft.message_required');

  // 首次选择题材时记录
  const narrativeType = req.body?.narrativeType || script.narrative_type || null;
  if (req.body?.narrativeType && !script.narrative_type) {
    await script.update({ narrative_type: req.body.narrativeType });
  }

  const chat = Array.isArray(script.chat) ? script.chat : [];
  const newChat = [...chat, { role: 'user', content: message }];
  const messages = buildOutlineMessages(newChat, narrativeType);
  const gen = chatStream(req.user.id, messages, { modelConfigId: req.body?.modelConfigId || null });

  // prime：让 resolveConfig / 上游错误在写 SSE 头之前抛出 → 标准 JSON
  let first;
  try {
    first = await gen.next();
  } catch (e) {
    throw badRequest(e.message || 'scriptDraft.outline_planner_unavailable');
  }

  let aborted = false;
  let assistantText = '';
  const onClose = () => { aborted = true; try { gen.return(); } catch { /* ignore */ } };
  req.on('close', onClose);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write = (obj) => {
    if (aborted || res.writableEnded) return false;
    return res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    if (!first.done && first.value) { assistantText += first.value; write({ delta: first.value }); }
    while (true) { // eslint-disable-line no-constant-condition
      const { value, done } = await gen.next(); // eslint-disable-line no-await-in-loop
      if (done) break;
      if (value) { assistantText += value; write({ delta: value }); }
    }
    write({ done: true });
  } catch (e) {
    logger.error('[剧本策划→流式异常]', e.message);
    write({ error: e.message || '生成失败，请稍后重试' });
  } finally {
    req.off('close', onClose);
    if (!res.writableEnded) res.end();
    // 落库对话历史（含本次 assistant 回复）
    try {
      const hist = assistantText.trim() ? [...newChat, { role: 'assistant', content: assistantText }] : newChat;
      await script.update({ chat: hist });
    } catch { /* ignore */ }
  }
}));

// ============ 第 1 步定稿：生成大纲（计费 job） ============

router.get('/:id/outline/estimate', authRequired, asyncHandler(async (req, res) => {
  await loadOwnedScript(req.user.id, req.params.id);
  const cfg = await loadTextCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const { credits, source, pricing } = await estimateTextCost(cfg, 'script_outline', 1);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { credits, source, pricing, ...tierPricing });
}));

router.post('/:id/outline', authRequired, asyncHandler(async (req, res) => {
  const script = await loadOwnedScript(req.user.id, req.params.id);
  const modelConfigId = req.body.modelConfigId || null;
  const cfg = await loadTextCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateTextCost(cfg, 'script_outline', 1);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const history = Array.isArray(script.chat) ? script.chat : [];
  const job = await createJob(req.user.id, {
    type: 'script_outline', refId: script.id,
    meta: { feature: 'script_outline', label: '剧本大纲生成', targetName: script.title, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est,
      { feature: 'script_outline', jobId: job.id, refId: script.id, remark: '剧本大纲生成' },
      async () => {
        await ctx.reportProgress(30, '调用大模型生成大纲…');
        const data = await generateOutline(req.user.id, { history, narrativeType: script.narrative_type, modelConfigId });
        await ctx.reportProgress(80, '整理大纲');
        const outline = formatOutline(data);
        // 用户已自定义剧名时不覆盖，仅在仍为默认占位时采用 AI 标题
        const keepUserTitle = !!script.title && script.title !== '未命名剧本';
        await script.update({ outline, stage: 'outline', ...(!keepUserTitle && data.title && { title: data.title }) });
        return { _actualCredits: est };
      });
    await script.reload();
    return { outline: script.outline, stage: script.stage, title: script.title, credits_used: spent, balance };
  });
  return ok(res, { job }, 'scriptDraft.outline_queued');
}));

// ============ 第 2 步：分集 + 概要（计费 job） ============

router.get('/:id/episodes/split/estimate', authRequired, asyncHandler(async (req, res) => {
  await loadOwnedScript(req.user.id, req.params.id);
  const cfg = await loadTextCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const { credits, source, pricing } = await estimateTextCost(cfg, 'episode_split', 1);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { credits, source, pricing, ...tierPricing });
}));

router.post('/:id/episodes/split', authRequired, asyncHandler(async (req, res) => {
  const script = await loadOwnedScript(req.user.id, req.params.id);
  if (!script.outline || !script.outline.trim()) throw badRequest('scriptDraft.outline_required_first');

  const modelConfigId = req.body.modelConfigId || null;
  const targetCount = Number(req.body.targetCount) || 0;
  const cfg = await loadTextCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateTextCost(cfg, 'episode_split', 1);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'episode_split', refId: script.id,
    meta: { feature: 'episode_split', label: '分集概要生成', targetName: script.title, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est,
      { feature: 'episode_split', jobId: job.id, refId: script.id, remark: '分集概要生成' },
      async () => {
        await ctx.reportProgress(30, '调用大模型规划分集…');
        const eps = await splitEpisodes(req.user.id, { outline: script.outline, targetCount, narrativeType: script.narrative_type, modelConfigId });
        await ctx.reportProgress(80, '写入分集');
        await ScriptEpisode.destroy({ where: { script_id: script.id } });
        const rows = [];
        for (const e of eps) {
          rows.push(await ScriptEpisode.create({ script_id: script.id, idx: e.idx, title: e.title, summary: e.summary, status: 'pending' }));
        }
        if (!rows.length) rows.push(await ScriptEpisode.create({ script_id: script.id, idx: 1, title: '第1集', summary: '', status: 'pending' }));
        await script.update({ stage: 'episodes' });
        return { _actualCredits: est };
      });
    const eps2 = await ScriptEpisode.findAll({ where: { script_id: script.id }, order: [['idx', 'ASC']] });
    return { episodes: eps2, stage: 'episodes', credits_used: spent, balance };
  });
  return ok(res, { job }, 'scriptDraft.episodes_queued');
}));

// ============ 分集读写（第 2/3 步编辑用） ============

router.get('/:id/episodes', authRequired, asyncHandler(async (req, res) => {
  await loadOwnedScript(req.user.id, req.params.id);
  const eps = await ScriptEpisode.findAll({ where: { script_id: req.params.id }, order: [['idx', 'ASC']] });
  return ok(res, eps);
}));

router.put('/:id/episodes/:eid', authRequired, asyncHandler(async (req, res) => {
  const { episode } = await loadOwnedScriptEpisode(req.user.id, req.params.id, req.params.eid);
  const { title, summary, content } = req.body;
  const hasContent = content !== undefined && String(content).trim();
  await episode.update({
    ...(title !== undefined && { title }),
    ...(summary !== undefined && { summary }),
    ...(content !== undefined && { content }),
    ...(hasContent && { status: 'done' }),
  });
  return ok(res, episode, 'scriptDraft.saved');
}));

// ============ 第 3 步：逐集细化正文（计费 job，可批量） ============

router.get('/:id/episodes/:eid/detail/estimate', authRequired, asyncHandler(async (req, res) => {
  await loadOwnedScriptEpisode(req.user.id, req.params.id, req.params.eid);
  const cfg = await loadTextCfg(req.user.id, req.query.modelConfigId ? Number(req.query.modelConfigId) : null);
  const { credits, source, pricing } = await estimateTextCost(cfg, 'episode_detail', 1);
  const tierPricing = await attachTierPricing(req.user, credits, cfg);
  return ok(res, { credits, source, pricing, ...tierPricing });
}));

router.post('/:id/episodes/:eid/detail', authRequired, asyncHandler(async (req, res) => {
  const { script, episode } = await loadOwnedScriptEpisode(req.user.id, req.params.id, req.params.eid);
  const modelConfigId = req.body.modelConfigId || null;
  const cfg = await loadTextCfg(req.user.id, modelConfigId);
  const { credits: nominal } = await estimateTextCost(cfg, 'episode_detail', 1);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(req.user, est);

  const job = await createJob(req.user.id, {
    type: 'episode_detail', refId: episode.id, projectId: null,
    meta: { feature: 'episode_detail', label: `第${episode.idx}集细化`, targetName: `${script.title}·${episode.title}`, estimate: est },
  });
  submit(job.id, async (ctx) => {
    const { spent, balance } = await withCredits(req.user.id, est,
      { feature: 'episode_detail', jobId: job.id, refId: episode.id, remark: `第${episode.idx}集细化` },
      async () => {
        await ctx.reportProgress(30, `调用大模型细化第${episode.idx}集…`);
        const { content } = await expandEpisode(req.user.id, {
          outline: script.outline,
          episode: { idx: episode.idx, title: episode.title, summary: episode.summary },
          narrativeType: script.narrative_type, modelConfigId,
        });
        await ctx.reportProgress(80, '写入正文');
        await episode.update({ content, status: 'done' });
        return { _actualCredits: est };
      });
    await episode.reload();
    return { episode, credits_used: spent, balance };
  });
  return ok(res, { job }, 'scriptDraft.episode_detail_queued');
}));

// ============ 第 4 步：导出到项目（非 AI） ============

/**
 * POST /api/scripts/:id/export  body: { projectId?(导入已有) | name?(新建项目名), style?, aspect_ratio?, narrative_type? }
 * 把草稿分集按 idx 映射为目标项目的 Episode（带 summary + content）。
 */
router.post('/:id/export', authRequired, asyncHandler(async (req, res) => {
  const script = await loadOwnedScript(req.user.id, req.params.id, { includeEpisodes: true });
  const { projectId, name, style, aspect_ratio, narrative_type } = req.body || {};
  const episodes = (script.episodes || []).slice().sort((a, b) => a.idx - b.idx);

  let project;
  if (projectId) {
    // 导入已有项目 = 覆盖该项目分集，按剧本编辑权限收口
    project = await loadOwnedProject(req.user.id, projectId, 'script.edit');
    // 覆盖已有分集：先收集旧分集成片与各分镜视频/关键帧/尾帧并删文件，再删库
    const oldEpisodes = await Episode.findAll({ where: { project_id: project.id }, attributes: ['id', 'video_url'] });
    const oldSegments = await StoryboardSegment.findAll({
      where: { episode_id: { [db.Sequelize.Op.in]: oldEpisodes.map((e) => e.id) } },
      attributes: ['video_url', 'keyframe_url', 'last_frame_url'],
    });
    deleteUrlFiles([
      ...oldEpisodes.map((e) => e.video_url),
      ...oldSegments.flatMap((s) => [s.video_url, s.keyframe_url, s.last_frame_url]),
    ]);
    await deleteEpisodeArtifacts(oldEpisodes.map((e) => e.id)); // 历史 Job 产物：多次合成成片 + 字幕版 mp4/srt/ass
    await Episode.destroy({ where: { project_id: project.id } }); // 覆盖已有分集
  } else {
    const projName = ((name && String(name).trim()) || script.title || '未命名项目').slice(0, 128);
    project = await Project.create({
      user_id: req.user.id,
      name: projName,
      status: 'outline',
      style: (style && String(style).trim()) || '古偶唯美柔光',
      aspect_ratio: (aspect_ratio && String(aspect_ratio).trim()) || '9:16',
    });
  }

  const fullText = episodes
    .map((e) => `第${e.idx}集${e.title ? ` ${e.title}` : ''}\n\n${e.content || e.summary || ''}`)
    .join('\n\n');
  await project.update({
    raw_script: fullText || script.outline || script.content || '',
    // 优先采用导出时显式选择的叙事类型，回退到剧本草稿 / 目标项目已有值
    narrative_type: narrative_type || script.narrative_type || project.narrative_type || null,
    status: 'outline',
  });

  const rows = [];
  for (const e of episodes) {
    rows.push(await Episode.create({
      project_id: project.id, idx: e.idx, title: e.title || `第${e.idx}集`,
      content: e.content || '', summary: e.summary || '', status: 'outline',
    }));
  }
  if (!rows.length && script.outline) {
    rows.push(await Episode.create({ project_id: project.id, idx: 1, title: '第1集', content: script.outline, status: 'outline' }));
  }

  await script.update({ stage: 'done' });
  return ok(res, { project: { id: project.id, name: project.name }, episodeCount: rows.length }, 'scriptDraft.exported');
}));

export default router;
