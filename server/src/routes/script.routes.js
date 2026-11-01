import { Router } from 'express';
import multer from 'multer';
import db from '../db/index.js';
import { asyncHandler, ok, badRequest } from '../utils/index.js';
import { authRequired } from '../middleware/auth.js';
import { loadOwnedProject, loadOwnedEpisode } from '../utils/ownership.js';
import { parseScriptJS } from '../services/ai/script.service.js';
import { extractPdfText, isPdfFile } from '../services/pdf.service.js';
import { createJob, submit, deleteEpisodeArtifacts } from '../services/job.service.js';
import { deleteUrlFiles } from '../utils/fileUtil.js';

const router = Router();
// 允许 PDF 剧本（含少量图）上传，适当放宽至 20MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const { Episode } = db;

// 解码上传的 .txt：先严格 UTF-8，失败则回退 GB18030（涵盖 GBK/GB2312）。
// 很多中文下载站（如 txt80.com）的文本是 GBK 编码，强制按 UTF-8 解会乱码。
function decodeScriptBuffer(buffer) {
  let buf = buffer;
  // 去掉 UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    buf = buf.subarray(3);
  }
  try {
    // fatal: true → 遇到非法字节序列抛错，借此判定是否真的是 UTF-8
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('utf8'); // 兜底：尽力而为
    }
  }
}

// 清空项目全部分集（重新导入 / 重新拆分前调用）：连同各集成片、分镜视频/关键帧/尾帧文件、
// 集-服饰配置与历史 Job 产物（多次合成成片/字幕版/剪辑版）一并删除，再删分集行——与删除单集路由同口径
async function purgeProjectEpisodes(projectId) {
  const oldEpisodes = await Episode.findAll({ where: { project_id: projectId }, attributes: ['id', 'video_url'] });
  if (oldEpisodes.length) {
    const ids = oldEpisodes.map((e) => e.id);
    const segments = await db.StoryboardSegment.findAll({
      where: { episode_id: { [db.Sequelize.Op.in]: ids } },
      attributes: ['video_url', 'keyframe_url', 'last_frame_url'],
    });
    deleteUrlFiles([
      ...oldEpisodes.map((e) => e.video_url),
      ...segments.flatMap((s) => [s.video_url, s.keyframe_url, s.last_frame_url]),
    ]);
    await deleteEpisodeArtifacts(ids);
    await db.EpisodeAsset.destroy({ where: { episode_id: { [db.Sequelize.Op.in]: ids } } });
  }
  await Episode.destroy({ where: { project_id: projectId } });
}

// ===== 导入/拆分：同步（旧客户端默认）与任务模式（async=1，后台执行+进度上报）共用工作函数 =====

// 导入工作：解析文本（PDF 提取是耗时点）→ 写 raw_script → 清空旧分集
// returnText：同步模式回传 raw_script 全文（旧客户端依赖）；任务模式只存 length，避免大文本落 jobs.result
function buildImportWorkFn(project, { file, bodyText, returnText = false }) {
  return async (ctx) => {
    await ctx.reportProgress(10, '读取剧本内容');
    let text = '';
    if (file) {
      if (isPdfFile(file)) {
        await ctx.reportProgress(25, '解析 PDF 文字层');
        text = await extractPdfText(file.buffer);
      } else {
        text = decodeScriptBuffer(file.buffer);
      }
    } else {
      text = bodyText;
    }
    if (!text.trim()) {
      // PDF 提取为空通常是扫描版/纯图片 PDF，给更精确的提示
      throw badRequest(file && isPdfFile(file) ? 'script.pdf_no_text' : 'script.no_script_content');
    }
    await ctx.reportProgress(55, `已读取 ${text.length} 字，写入项目`);
    await project.update({ raw_script: text, status: 'outline' });
    await ctx.reportProgress(75, '清理旧分集及其产物');
    // 移除已有分集及其全部产物文件（重新导入；分镜视频/成片随分集一并清理）
    await purgeProjectEpisodes(project.id);
    await ctx.reportProgress(100, '导入完成');
    // 任务模式只存长度，raw_script 大文本不落 jobs.result
    return returnText ? { raw_script: text, length: text.length } : { length: text.length };
  };
}

// 拆分工作：按集标记切分 → 清空旧分集 → 逐集建行（大剧本的耗时点，逐集报进度）
function buildParseJsWorkFn(project) {
  return async (ctx) => {
    await ctx.reportProgress(10, '按集标记切分剧本');
    const episodes = parseScriptJS(project.raw_script);
    await ctx.reportProgress(25, `切分出 ${episodes.length} 集，清理旧分集`);
    await purgeProjectEpisodes(project.id);
    const rows = [];
    for (let i = 0; i < episodes.length; i++) {
      const e = episodes[i];
      rows.push(await Episode.create({
        project_id: project.id, idx: e.idx, title: e.title, content: e.content,
        status: 'outline',
      }));
      await ctx.reportProgress(30 + Math.round(((i + 1) / episodes.length) * 60), `写入第 ${e.idx} 集「${e.title}」`);
    }
    if (!rows.length) {
      // 兜底：整篇作为一集
      rows.push(await Episode.create({ project_id: project.id, idx: 1, title: '第1集', content: project.raw_script, status: 'outline' }));
    }
    await project.update({ status: 'outline' });
    await ctx.reportProgress(100, '拆分完成');
    return { count: rows.length };
  };
}

// 导入剧本（粘贴文本 或 上传 .txt/.pdf；async=1 走任务模式，默认同步兼容旧客户端）
router.post('/projects/:id/script/import', authRequired, upload.single('file'), asyncHandler(async (req, res) => {
  const project = await loadOwnedProject(req.user.id, req.params.id, 'script.edit');
  const file = req.file || null;
  const bodyText = req.body.text || req.body.script || '';
  const asJob = req.body?.async === true || req.body?.async === '1' || req.query?.async === '1';
  if (asJob) {
    const job = await createJob(req.user.id, {
      type: 'script_import', projectId: project.id,
      meta: { label: '剧本导入', projectName: project.name, fileName: file?.originalname || null, size: file?.size || bodyText.length },
    });
    // memoryStorage 的 buffer 由闭包持有，请求结束后任务执行时仍可读
    submit(job.id, buildImportWorkFn(project, { file, bodyText }));
    return ok(res, { job }, 'script.import_queued');
  }
  const workFn = buildImportWorkFn(project, { file, bodyText, returnText: true });
  // 同步模式：直接以内联 ctx 执行同一工作函数（进度调用为空操作）
  const result = await workFn({ reportProgress: async () => {} });
  return ok(res, result, 'script.imported');
}));

// 拆分集（JS 本地、零积分；async=1 走任务模式可上报逐集进度，默认同步兼容旧客户端）
router.post('/projects/:id/script/parse-js', authRequired, asyncHandler(async (req, res) => {
  // withRawScript：拆分需读 raw_script 全文（默认查询不下发该大字段）
  const project = await loadOwnedProject(req.user.id, req.params.id, 'script.edit', { withRawScript: true });
  if (!project.raw_script || !project.raw_script.trim()) throw badRequest('script.raw_script_required');

  const asJob = req.body?.async === true || req.body?.async === '1' || req.query?.async === '1';
  if (asJob) {
    const job = await createJob(req.user.id, {
      type: 'script_parse', projectId: project.id,
      meta: { label: '剧本拆分', projectName: project.name },
    });
    submit(job.id, buildParseJsWorkFn(project));
    return ok(res, { job }, 'script.parse_queued');
  }
  const workFn = buildParseJsWorkFn(project);
  await workFn({ reportProgress: async () => {} });
  const eps = await Episode.findAll({ where: { project_id: project.id }, order: [['idx', 'ASC']] });
  return ok(res, { episodes: eps }, 'script.parsed');
}));

// 新增分集（手动追加）
router.post('/projects/:id/episodes', authRequired, asyncHandler(async (req, res) => {
  const project = await loadOwnedProject(req.user.id, req.params.id, 'script.edit');
  const { title, content } = req.body || {};
  // 计算下一个集号，保证 idx 连续
  const last = await Episode.findOne({ where: { project_id: project.id }, order: [['idx', 'DESC']] });
  const nextIdx = last ? (last.idx + 1) : 1;
  const episode = await Episode.create({
    project_id: project.id,
    idx: nextIdx,
    title: (title && String(title).trim()) ? String(title).trim() : `第${nextIdx}集`,
    content: content || '',
    status: 'outline',
  });
  await project.update({ status: 'outline' });
  return ok(res, episode, 'script.episode_added');
}));

// 删除分集（删除后重新编号，保证集号连续）；连同该集成片与各分镜视频/关键帧/尾帧文件一并删除
router.delete('/episodes/:eid', authRequired, asyncHandler(async (req, res) => {
  const { episode, project } = await loadOwnedEpisode(req.user.id, req.params.eid, 'script.edit');
  const segments = await db.StoryboardSegment.findAll({
    where: { episode_id: episode.id },
    attributes: ['video_url', 'keyframe_url', 'last_frame_url'],
  });
  deleteUrlFiles([episode.video_url, ...segments.flatMap((s) => [s.video_url, s.keyframe_url, s.last_frame_url])]);
  await deleteEpisodeArtifacts([episode.id]); // 历史 Job 产物：多次合成成片 + 字幕版 mp4/srt/ass
  await episode.destroy();
  const rest = await Episode.findAll({ where: { project_id: project.id }, order: [['idx', 'ASC']] });
  let i = 1;
  for (const e of rest) {
    if (e.idx !== i) await e.update({ idx: i });
    i += 1;
  }
  return ok(res, { id: episode.id }, 'script.episode_deleted');
}));

// 获取/更新单集
router.get('/episodes/:eid', authRequired, asyncHandler(async (req, res) => {
  const { episode, project } = await loadOwnedEpisode(req.user.id, req.params.eid);
  const segments = await db.StoryboardSegment.findAll({ where: { episode_id: episode.id }, attributes: ['id'], order: [['idx', 'ASC']] });
  return ok(res, { ...episode.toJSON(), project, segments });
}));

router.put('/episodes/:eid', authRequired, asyncHandler(async (req, res) => {
  const { episode } = await loadOwnedEpisode(req.user.id, req.params.eid, 'script.edit');
  const { title, content, status, director_requirements } = req.body;
  await episode.update({
    ...(title !== undefined && { title }),
    ...(content !== undefined && { content }),
    ...(status !== undefined && { status }),
    ...(director_requirements !== undefined && { director_requirements }),
  });
  return ok(res, episode, 'script.episode_updated');
}));

export default router;
