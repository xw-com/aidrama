import fs from 'fs';
import sharp from 'sharp';
import db from '../db/index.js';
import { badRequest } from '../utils/index.js';
import { genFilePath, toUrl, urlToPath, deleteUrlFiles } from '../utils/fileUtil.js';
import { config } from '../config/index.js';
import { generateImage } from './image.service.js';
import { getConfig, resolveConfig } from './modelConfig.service.js';
import { estimateImageCost, assertBalance, applyModelPromo } from './pricing.service.js';
import { withCredits } from './credits.service.js';
import { createJob, submit } from './job.service.js';
import { makeThumbUrl } from './thumbnail.service.js';
import { resolveStyleKey, getStyleName, resolveNarrativeKey, getNarrativeName } from './artSkills.service.js';

/**
 * AI 生成项目封面：素材 = 用户挑选的角色/场景/道具（默认各类取「使用地方最多」的一个，
 * 按分镜 asset_refs 引用次数统计，均须已有图片，可多选）+ 可选一句补充描述 + 前三集剧本概要；
 * 生成 2:3 竖版（720×1080）PNG，剧名作为标题文字融入画面（排版由模型设计），写回 project.cover。
 * 缺分镜 / 缺资产图片 / 缺剧本概要 → 报错提示（不生成）。
 */

/** 出镜次数降序，并列取 id 小者（保证稳定；首名即默认勾选项） */
function byRefDesc(refCount) {
  return (a, b) => ((refCount[b.id] || 0) - (refCount[a.id] || 0)) || (a.id - b.id);
}

/**
 * 封面素材公共前置：统计出镜次数 + 拉全量资产 + 取前三集概要。
 * @throws badRequest('project.cover_ai_no_storyboard' | 'project.cover_ai_no_script')
 */
async function collectCoverContext(project) {
  const episodes = await db.Episode.findAll({
    where: { project_id: project.id },
    order: [['idx', 'ASC']],
    attributes: ['id', 'idx', 'title', 'summary', 'content'],
  });

  // 出镜统计：全部分镜 asset_refs 引用次数（角色/场景/道具同口径）
  const segments = episodes.length
    ? await db.StoryboardSegment.findAll({
        where: { episode_id: { [db.Sequelize.Op.in]: episodes.map((e) => e.id) } },
        attributes: ['asset_refs'],
      })
    : [];
  if (!segments.length) throw badRequest('project.cover_ai_no_storyboard');
  const refCount = {};
  for (const seg of segments) {
    for (const r of seg.asset_refs || []) {
      const id = Number(r?.id);
      if (Number.isFinite(id)) refCount[id] = (refCount[id] || 0) + 1;
    }
  }

  const assets = await db.Asset.findAll({ where: { project_id: project.id } });

  // 前三集剧本概要：优先 summary，缺失回退正文前 300 字；一集都取不到即判缺剧本
  const synopses = episodes.slice(0, 3).map((e) => {
    const s = String(e.summary || '').trim();
    if (s) return `第${e.idx}集《${e.title || ''}》：${s}`;
    const c = String(e.content || '').trim();
    return c ? `第${e.idx}集《${e.title || ''}》：${c.slice(0, 300)}${c.length > 300 ? '…' : ''}` : '';
  }).filter(Boolean);
  if (!synopses.length) throw badRequest('project.cover_ai_no_script');

  return { assets, refCount, synopses };
}

/**
 * 候选素材列表（素材选择弹窗数据）：每类有图资产按出镜次数降序，首项即默认勾选。
 * @returns {{characters: Array, scenes: Array, props: Array, synopsis_count: number}}
 * @throws badRequest('project.cover_ai_no_*') 素材不齐时
 */
export async function listCoverCandidates(project) {
  const { assets, refCount, synopses } = await collectCoverContext(project);
  const groups = {};
  for (const kind of ['character', 'scene', 'prop']) {
    groups[kind] = assets
      .filter((a) => a.kind === kind && a.image_url)
      .sort(byRefDesc(refCount))
      .map((a) => ({ id: a.id, name: a.name, image_url: a.image_url, ref_count: refCount[a.id] || 0 }));
  }
  if (!groups.character.length || !groups.scene.length || !groups.prop.length) {
    throw badRequest('project.cover_ai_no_assets');
  }
  return { characters: groups.character, scenes: groups.scene, props: groups.prop, synopsis_count: synopses.length };
}

/**
 * 选取封面素材并校验前置条件。
 * @param {object|null} picks 用户指定 { characterIds, sceneIds, propIds, description }（null 走默认：每类出镜最多一个）
 * @returns {{characters: Asset[], scenes: Asset[], props: Asset[], synopses: string[], description: string}}
 * @throws badRequest('project.cover_ai_no_*' | 'project.cover_ai_asset_invalid') 素材不齐/所选无效时
 */
export async function selectCoverMaterials(project, picks = null) {
  const { assets, refCount, synopses } = await collectCoverContext(project);
  let characters, scenes, props;
  if (picks) {
    // 用户挑选：按 id 精确取资产（保持用户给出的顺序），任一不存在/类型不符/缺图即整体报错
    const take = (kind, ids) => {
      const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite))];
      const found = wanted.map((id) => assets.find((a) => a.id === id));
      if (!found.length || found.some((a) => !a || a.kind !== kind || !a.image_url)) {
        throw badRequest('project.cover_ai_asset_invalid');
      }
      return found;
    };
    characters = take('character', picks.characterIds);
    scenes = take('scene', picks.sceneIds);
    props = take('prop', picks.propIds);
  } else {
    // 默认：每类取「被引用最多且有图片」的一个
    const pick = (kind) => [assets.filter((a) => a.kind === kind && a.image_url).sort(byRefDesc(refCount))[0] || null];
    characters = pick('character');
    scenes = pick('scene');
    props = pick('prop');
    if (characters[0] === null || scenes[0] === null || props[0] === null) throw badRequest('project.cover_ai_no_assets');
  }
  const description = String(picks?.description || '').trim().slice(0, 200);
  return { characters, scenes, props, synopses, description };
}

/** 素材行文案：名称 + 描述摘要（限 120 字） */
function assetLine(a) {
  const desc = String(a.description || '').trim().slice(0, 120);
  return desc ? `${a.name}——${desc}` : a.name;
}

/** 同类多素材合并为一行（分号分隔，保持用户给出的主次顺序） */
const assetList = (arr) => arr.map(assetLine).join('；');

/** 组装封面生成提示词（竖版 2:3 人物海报式构图，剧名作标题文字入画、排版由模型设计） */
export function buildCoverPrompt(project, { characters, scenes, props, synopses, description }) {
  const styleName = getStyleName(resolveStyleKey(project.style));
  // narrative_type 兼容旧值（中文名）：先归一到合法 key 再取名
  const narrativeName = project.narrative_type ? getNarrativeName(resolveNarrativeKey(project.narrative_type)) : '';
  const multi = characters.length > 1;
  const lines = [
    `为短剧《${project.name}》生成一张竖版封面海报（2:3 画幅）。`,
    styleName ? `视觉风格：${styleName}。` : '',
    narrativeName ? `题材类型：${narrativeName}。` : '',
    `主角角色${multi ? '（按主次排序）' : ''}：${assetList(characters)}`,
    `主场景：${assetList(scenes)}`,
    `关键道具：${assetList(props)}`,
    '前三集剧情概要：',
    ...synopses,
    description ? `用户补充要求：${description}。` : '',
    [
      multi
        ? '要求：以首位角色为视觉核心、其余角色按主次合理安排位置的人物海报式构图（半身），'
        : '要求：以主角为核心的人物海报式构图（半身、置于画面视觉中心），',
      '背景为主场景并自然融入关键道具，画面氛围与剧情概要的基调一致，并尽量满足用户补充要求，',
      '光影质感与视觉风格统一，具备短剧封面的吸引力。',
      `封面必须将剧名「${project.name}」作为标题文字醒目呈现，字体样式（如美术字、书法体、衬线体等）、颜色、大小、位置与整体排版由你根据画面自行设计，须清晰可读、与视觉风格和氛围协调、不遮挡主体人物；`,
      '除剧名外，画面中不要出现任何其他文字、字幕、水印、logo、边框。',
    ].join(''),
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 起 project_cover Job：估算扣费 → 生成 → sharp 归一为 720×1080（2:3）PNG → 写回 project.cover。
 * @param {object} user req.user 实例（assertBalance 需 .reload()）
 * @param {object|null} picks 用户指定素材 { characterIds, sceneIds, propIds, description }（null 走默认）
 */
export async function startCoverJob(user, project, modelConfigId, picks = null) {
  const userId = user.id;
  const cfg = modelConfigId ? await getConfig(userId, modelConfigId) : await resolveConfig(userId, 'image');
  const { credits: nominal } = await estimateImageCost(cfg);
  const est = applyModelPromo(cfg, nominal); // 限时折扣：活动期内按折后价预估与实扣
  await assertBalance(user, est);

  const job = await createJob(userId, {
    type: 'project_cover',
    projectId: project.id,
    meta: {
      feature: 'project_cover', label: 'AI 生成封面', projectName: project.name, estimate: est,
      picks: picks && { character_ids: picks.characterIds, scene_ids: picks.sceneIds, prop_ids: picks.propIds, description: picks.description },
    },
  });
  submit(job.id, async (ctx) => {
    let coverUrl = null;
    const { spent, balance } = await withCredits(
      userId,
      est,
      { feature: 'project_cover', jobId: job.id, remark: `AI封面:${project.name}` },
      async () => {
        // 任务真正执行时重新选取素材（提交后资产/分镜可能变化；不齐/所选失效则任务失败并退款）
        const materials = await selectCoverMaterials(project, picks);
        const prompt = buildCoverPrompt(project, materials);
        await ctx.reportProgress(30, '调用图像模型生成封面…');
        // 2:3 竖版画幅 + max_size 档位字符串提交（勿向 provider 传小尺寸），
        // 最终 720×1080 由下方 sharp 统一降采样归一（超采样画质更好）
        // 参考图按「角色→场景→道具」顺序传入（OpenAI 线只取首张=主角；Seedream 线内部截前 9 张）
        const rawUrl = await generateImage(userId, prompt, {
          modelConfigId,
          ratio: '2:3',
          referenceImages: [...materials.characters, ...materials.scenes, ...materials.props].map((a) => a.image_url),
          logCtx: { jobId: job.id, projectId: project.id, feature: 'project_cover', target: project.name },
        });

        // 归一为 720×1080（2:3）PNG（provider 输出尺寸/格式不可控，统一本地转码落盘）
        await ctx.reportProgress(80, '封面转码保存…');
        const srcAbs = urlToPath(rawUrl);
        if (!srcAbs || !fs.existsSync(srcAbs)) throw new Error('封面生成结果落盘缺失');
        const { absPath: destAbs } = genFilePath(config.uploadDir, 'png', 'cover');
        // 封面不打「AI生成」角标（2026-09-23 用户指定不加水印；厂商侧水印已在 generateImage 入口强制关闭）
        await sharp(srcAbs).resize(720, 1080, { fit: 'cover', position: 'attention' }).png().toFile(destAbs);
        coverUrl = toUrl(destAbs);

        // 重新取一次项目（任务期间可能被删）：被删则只清理产物不写库
        const fresh = await db.Project.findByPk(project.id);
        const oldCover = fresh?.cover;
        const oldCoverThumb = fresh?.cover_thumb;
        if (fresh) {
          // 换图写点须同步重算缩略图：列表卡片用 cover_thumb，漏算则永久 stale 显示旧封面
          const coverThumb = await makeThumbUrl(coverUrl);
          await fresh.update({ cover: coverUrl, ...(coverThumb && { cover_thumb: coverThumb }) });
        }
        deleteUrlFiles([rawUrl, oldCover, oldCoverThumb], [coverUrl]);
        return { _actualCredits: est };
      }
    );
    return { cover_url: coverUrl, credits_used: spent, balance };
  });
  return job;
}
