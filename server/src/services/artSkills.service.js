import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import db from '../db/index.js';

/**
 * 美术风格注册表（同步自 server/skills/art_skills/）
 * 每套风格目录结构一致：README.md(风格名) / prefix.md(全局锚定) /
 * images/(缩略图) / art_prompt/*.md / driector_skills/*.md
 *
 * 说明：ART_STYLES 常量现作「种子源 + 空库兜底」，运行时风格注册表由 ArtStyle 表驱动，
 * 启动时 reloadArtStyles() 载入内存缓存，admin 写操作后刷新。listArtStyles/resolveStyleKey/
 * getStyleName 保持同步（被多个 AI 服务同步调用），读缓存即可。
 */
export const DEFAULT_STYLE_KEY = '2D_chinese_guofeng';

// 内存缓存：ArtStyle 表的同步快照（数组，已按 sort_order 排序）
// 每项 { key, name, category, thumbnail, sort_order, enabled, image_version }
let styleCache = [];
let styleCacheLoaded = false;

/**
 * 风格大类（用于选择器分组）：写实 = realpeople_*；动漫 = 2D_* / 3D_*
 * 顺序即页签顺序。
 */
export const STYLE_CATEGORIES = [
  { value: 'realistic', label: '写实' },
  { value: 'anime', label: '动漫' },
];

/** 由风格 key 推断大类：realpeople_* → realistic，其余（2D/3D）→ anime。
 *  缓存中若有显式 category 则优先用之（admin 可改大类）；否则按 key 前缀推断。 */
export function getStyleCategory(key) {
  const cached = styleCache.find((s) => s.key === key);
  if (cached?.category) return cached.category;
  return String(key || '').startsWith('realpeople_') ? 'realistic' : 'anime';
}

/** 把 ART_STYLES 常量映射为缓存条目形态（空库/表未建时兜底） */
function fallbackCache() {
  return ART_STYLES.map((s, i) => ({
    key: s.key,
    name: s.name,
    category: String(s.key || '').startsWith('realpeople_') ? 'realistic' : 'anime',
    thumbnail: s.thumbnail,
    sort_order: i,
    enabled: true,
    image_version: 1,
  }));
}

/**
 * 从 ArtStyle 表重载内存缓存。启动时（runSeed 后）与每次 admin 写操作后调用。
 * 表未建 / 为空时回退到 ART_STYLES 常量，保证服务可用。
 */
export async function reloadArtStyles() {
  try {
    const { ArtStyle } = db;
    if (!ArtStyle) { styleCache = fallbackCache(); styleCacheLoaded = true; return; }
    const rows = await ArtStyle.findAll({ order: [['sort_order', 'ASC'], ['id', 'ASC']] });
    styleCache = rows.length
      ? rows.map((r) => ({
          key: r.key, name: r.name, category: r.category, thumbnail: r.thumbnail,
          sort_order: r.sort_order, enabled: r.enabled, image_version: r.image_version,
        }))
      : fallbackCache();
    styleCacheLoaded = true;
  } catch (e) {
    // 启动早期表可能未就绪：回退常量，不阻断启动
    styleCache = fallbackCache();
    styleCacheLoaded = true;
    logger.warn(`[artSkills] reloadArtStyles 回退到常量：${e.message}`);
  }
}

/** 仅供测试/兜底：缓存是否已加载 */
export function isStyleCacheLoaded() { return styleCacheLoaded; }

export const ART_STYLES = [
  // —— 写实风格（realpeople_*）——
  { key: 'realpeople_xianxia_martial', name: '仙侠武侠写实', thumbnail: 'art_skills/realpeople_xianxia_martial/images/preview.webp' },
  { key: 'realpeople_modern_city', name: '都市影像', thumbnail: 'art_skills/realpeople_modern_city/images/preview.webp' },
  { key: 'realpeople_business_elite', name: '商战豪门写实', thumbnail: 'art_skills/realpeople_business_elite/images/preview.webp' },
  { key: 'realpeople_urban_modern', name: '都市写实', thumbnail: 'art_skills/realpeople_urban_modern/images/preview.webp' },
  { key: 'realpeople_ancient_chinese', name: '古风写实', thumbnail: 'art_skills/realpeople_ancient_chinese/images/preview.webp' },
  { key: 'realpeople_countryside_pastoral', name: '乡村田园写实', thumbnail: 'art_skills/realpeople_countryside_pastoral/images/preview.webp' },
  { key: 'realpeople_palace_harem', name: '古装宫廷写实', thumbnail: 'art_skills/realpeople_palace_harem/images/preview.webp' },
  { key: 'realpeople_campus_youth', name: '校园青春写实', thumbnail: 'art_skills/realpeople_campus_youth/images/preview.webp' },
  { key: 'realpeople_suspense_crime', name: '悬疑刑侦写实', thumbnail: 'art_skills/realpeople_suspense_crime/images/preview.webp' },
  { key: 'realpeople_retro_era', name: '年代怀旧写实', thumbnail: 'art_skills/realpeople_retro_era/images/preview.webp' },
  { key: 'realpeople_medical_workplace', name: '医疗职场影像', thumbnail: 'art_skills/realpeople_medical_workplace/images/preview.webp' },
  { key: 'realpeople_family_life', name: '家庭生活写实', thumbnail: 'art_skills/realpeople_family_life/images/preview.webp' },
  { key: 'realpeople_ancient_bright', name: '古风明艳写实', thumbnail: 'art_skills/realpeople_ancient_bright/images/preview.webp' },
  { key: 'realpeople_documentary', name: '纪实摄影', thumbnail: 'art_skills/realpeople_documentary/images/preview.webp' },
  { key: 'realpeople_nordic_minimal', name: '北欧极简写实', thumbnail: 'art_skills/realpeople_nordic_minimal/images/preview.webp' },
  { key: 'realpeople_ancient_tang', name: '唐朝写实', thumbnail: 'art_skills/realpeople_ancient_tang/images/preview.webp' },
  { key: 'realpeople_ancient_song', name: '宋朝写实', thumbnail: 'art_skills/realpeople_ancient_song/images/preview.webp' },
  { key: 'realpeople_ancient_ming', name: '明朝写实', thumbnail: 'art_skills/realpeople_ancient_ming/images/preview.webp' },
  { key: 'realpeople_ancient_qing', name: '清朝写实', thumbnail: 'art_skills/realpeople_ancient_qing/images/preview.webp' },
  { key: 'realpeople_republic_era', name: '民国年代写实', thumbnail: 'art_skills/realpeople_republic_era/images/preview.webp' },
  { key: 'realpeople_fashion_editorial', name: '时尚大片', thumbnail: 'art_skills/realpeople_fashion_editorial/images/preview.webp' },
  { key: 'realpeople_cyberpunk', name: '赛博朋克写实', thumbnail: 'art_skills/realpeople_cyberpunk/images/preview.webp' },
  { key: 'realpeople_city_modern', name: '都市现代写实', thumbnail: 'art_skills/realpeople_city_modern/images/preview.webp' },
  { key: 'realpeople_oil_painting', name: '油画质感写实', thumbnail: 'art_skills/realpeople_oil_painting/images/preview.webp' },
  { key: 'realpeople_ink_wash', name: '水墨写实', thumbnail: 'art_skills/realpeople_ink_wash/images/preview.webp' },
  { key: 'realpeople_dark_gothic', name: '暗黑哥特写实', thumbnail: 'art_skills/realpeople_dark_gothic/images/preview.webp' },
  { key: 'realpeople_jp_fresh', name: '日系清新写实', thumbnail: 'art_skills/realpeople_jp_fresh/images/preview.webp' },
  { key: 'realpeople_retro_film', name: '复古胶片', thumbnail: 'art_skills/realpeople_retro_film/images/preview.webp' },
  { key: 'realpeople_bw_cinema', name: '黑白电影', thumbnail: 'art_skills/realpeople_bw_cinema/images/preview.webp' },
  { key: 'realpeople_commercial_ad', name: '商业广告', thumbnail: 'art_skills/realpeople_commercial_ad/images/preview.webp' },
  { key: 'realpeople_fashion_magazine', name: '时尚杂志', thumbnail: 'art_skills/realpeople_fashion_magazine/images/preview.webp' },
  { key: 'realpeople_war_documentary', name: '战争纪实', thumbnail: 'art_skills/realpeople_war_documentary/images/preview.webp' },
  { key: 'realpeople_police_action', name: '警匪动作写实', thumbnail: 'art_skills/realpeople_police_action/images/preview.webp' },
  { key: 'realpeople_bridal_photo', name: '婚纱摄影', thumbnail: 'art_skills/realpeople_bridal_photo/images/preview.webp' },
  { key: 'realpeople_travel_landscape', name: '旅游风光', thumbnail: 'art_skills/realpeople_travel_landscape/images/preview.webp' },
  { key: 'realpeople_food_photo', name: '美食摄影', thumbnail: 'art_skills/realpeople_food_photo/images/preview.webp' },
  { key: 'realpeople_interior_design', name: '室内设计', thumbnail: 'art_skills/realpeople_interior_design/images/preview.webp' },
  { key: 'realpeople_runway_fashion', name: '时装秀', thumbnail: 'art_skills/realpeople_runway_fashion/images/preview.webp' },
  { key: 'realpeople_street_snap', name: '时尚街拍', thumbnail: 'art_skills/realpeople_street_snap/images/preview.webp' },
  { key: 'realpeople_sports_action', name: '体育运动写实', thumbnail: 'art_skills/realpeople_sports_action/images/preview.webp' },
  { key: 'realpeople_product_ad', name: '产品广告', thumbnail: 'art_skills/realpeople_product_ad/images/preview.webp' },
  { key: 'realpeople_fullbody_fashion', name: '全身时尚', thumbnail: 'art_skills/realpeople_fullbody_fashion/images/preview.webp' },

  // —— 动漫风格（2D_* / 3D_*）——
  { key: '2D_chinese_guofeng', name: '国风二次元新国潮', thumbnail: 'art_skills/2D_chinese_guofeng/images/preview.webp' },
  { key: '2D_90s_japanese_anime', name: '90年代日式动画', thumbnail: 'art_skills/2D_90s_japanese_anime/images/preview.webp' },
  { key: '2D_shonen_battle', name: '少年热血漫画', thumbnail: 'art_skills/2D_shonen_battle/images/preview.webp' },
  { key: '2D_mature_urban_romance', name: '言情二次元动画', thumbnail: 'art_skills/2D_mature_urban_romance/images/preview.webp' },
  { key: '3D_chinese_traditional', name: '国风3D', thumbnail: 'art_skills/3D_chinese_traditional/images/preview.webp' },
  { key: '3D_guofeng_cyber', name: '国风赛博3D', thumbnail: 'art_skills/3D_guofeng_cyber/images/preview.webp' },
  { key: '2D_watercolor_storybook', name: '二维水彩绘本动画', thumbnail: 'art_skills/2D_watercolor_storybook/images/preview.webp' },
  { key: '2D_mecha_scifi', name: '机甲科幻风格', thumbnail: 'art_skills/2D_mecha_scifi/images/preview.webp' },
  { key: '2D_shoujo_sparkle', name: '少女漫画言情', thumbnail: 'art_skills/2D_shoujo_sparkle/images/preview.webp' },
  { key: '2D_dark_fantasy', name: '二维暗黑奇幻', thumbnail: 'art_skills/2D_dark_fantasy/images/preview.webp' },
  { key: '2D_chibi_sd', name: 'Q版SD萌系', thumbnail: 'art_skills/2D_chibi_sd/images/preview.webp' },
  { key: '2D_ink_wash_donghua', name: '水墨动画风格', thumbnail: 'art_skills/2D_ink_wash_donghua/images/preview.webp' },
  { key: '3D_anime_render', name: '3D动画渲染', thumbnail: 'art_skills/3D_anime_render/images/preview.webp' },
  { key: '2D_retro_hkcomic', name: '复古港漫风格', thumbnail: 'art_skills/2D_retro_hkcomic/images/preview.webp' },
  { key: '3D_western_cartoon', name: '3D欧美卡通', thumbnail: 'art_skills/3D_western_cartoon/images/preview.webp' },
  { key: '3D_designer_toy', name: '3D潮玩手办盲盒风格', thumbnail: 'art_skills/3D_designer_toy/images/preview.webp' },
  { key: '3D_clay_stopmotion', name: '定格动画黏土', thumbnail: 'art_skills/3D_clay_stopmotion/images/preview.webp' },
  { key: '2D_flat_design', name: '2D扁平风', thumbnail: 'art_skills/2D_flat_design/images/preview.webp' },
  { key: '2D_cel_anime', name: '赛璐璐日漫风', thumbnail: 'art_skills/2D_cel_anime/images/preview.webp' },
  { key: '2D_american_thick_paint', name: '美漫厚涂风', thumbnail: 'art_skills/2D_american_thick_paint/images/preview.webp' },
  { key: '2D_pop_comic', name: '波普美漫风', thumbnail: 'art_skills/2D_pop_comic/images/preview.webp' },
  { key: '2D_magical_girl', name: '魔法少女风', thumbnail: 'art_skills/2D_magical_girl/images/preview.webp' },
  { key: '2D_meme_sticker', name: '沙雕表情包风', thumbnail: 'art_skills/2D_meme_sticker/images/preview.webp' },
  { key: '2D_fantasy_adventure', name: '奇幻冒险', thumbnail: 'art_skills/2D_fantasy_adventure/images/preview.webp' },
  { key: '2D_campus_anime', name: '校园动漫', thumbnail: 'art_skills/2D_campus_anime/images/preview.webp' },
  { key: '2D_healing_anime', name: '治愈系动漫', thumbnail: 'art_skills/2D_healing_anime/images/preview.webp' },
  { key: '2D_horror_anime', name: '恐怖动漫', thumbnail: 'art_skills/2D_horror_anime/images/preview.webp' },
  { key: '2D_romance_anime', name: '恋爱动漫', thumbnail: 'art_skills/2D_romance_anime/images/preview.webp' },
  { key: '2D_hotblood_battle', name: '热血战斗', thumbnail: 'art_skills/2D_hotblood_battle/images/preview.webp' },
  { key: '2D_ukiyo_e', name: '和风浮世绘', thumbnail: 'art_skills/2D_ukiyo_e/images/preview.webp' },
  { key: '2D_western_fantasy', name: '欧美奇幻', thumbnail: 'art_skills/2D_western_fantasy/images/preview.webp' },
  { key: '2D_korean_webtoon', name: '韩漫风格', thumbnail: 'art_skills/2D_korean_webtoon/images/preview.webp' },
];

/**
 * 逻辑提示词名 → 风格目录内相对路径（31 套通用，结构一致）
 * 注意：原目录拼写为 driector_skills（保持与磁盘一致）
 */
export const PROMPT_FILES = {
  prefix: 'prefix.md',
  art_character: 'art_prompt/art_character.md',
  art_scene: 'art_prompt/art_scene.md',
  art_prop: 'art_prompt/art_prop.md',
  art_storyboard_video: 'art_prompt/art_storyboard_video.md',
  director_storyboard: 'driector_skills/director_storyboard.md',
  director_planning_style: 'driector_skills/director_planning_style.md',
  director_storyboard_table_style: 'driector_skills/director_storyboard_table_style.md',
};

/**
 * 叙事类型注册表（同步自 server/skills/story_skills/）
 * 每套类型目录结构一致：README.md(类型名) / images/ / driector_skills/*.md
 * 叙事技法与视觉画风正交——任何画风都可叠加任意叙事类型。
 */
export const DEFAULT_NARRATIVE_KEY = 'Sweet_romance_novel';

export const NARRATIVE_TYPES = [
  { key: 'Comedy_humor', name: '喜剧搞笑' },
  { key: 'Coming_of_age', name: '青春成长' },
  { key: 'Family_warmth', name: '家庭温情' },
  { key: 'Historical_epic', name: '历史史诗' },
  { key: 'Horror_supernatural', name: '恐怖灵异' },
  { key: 'Hot_blooded_action', name: '热血少年' },
  { key: 'Mystery_thriller', name: '悬疑推理' },
  { key: 'Psychological_drama', name: '心理博弈' },
  { key: 'Scifi_post_apocalypse', name: '科幻末世' },
  { key: 'Sweet_romance_novel', name: '甜宠言情' },
  { key: 'Urban_workplace_drama', name: '都市职场' },
  { key: 'Xianxia_fantasy', name: '古风仙侠' },
];

/**
 * 叙事技法逻辑名 → 类型目录内相对路径（与画风技法同名但位于 story_skills/<类型>/ 下）
 * 注意：原目录拼写为 driector_skills（保持与磁盘一致）
 */
export const NARRATIVE_PROMPT_FILES = {
  director_planning_narrative: 'driector_skills/director_planning_narrative.md',
  director_storyboard_table_narrative: 'driector_skills/director_storyboard_table_narrative.md',
};

const SKILLS_ROOT = () => path.resolve(process.cwd(), 'skills');

/** 缩略图可访问 URL（需在 app.js 挂载 /skills 静态目录）；返回相对路径，前端同源/代理访问。
 *  尾部追加版本号破浏览器缓存：优先用每行 image_version（生成/替换图后 +1），
 *  回退到全局 STATIC_IMAGE_VERSION（.env）。 */
function thumbnailUrl(thumbnail, version) {
  const v = version ?? config.staticImageVersion;
  return `/skills/${thumbnail}${v ? `?${v}` : ''}`;
}

/** 大图预览可访问 URL（images/1.webp 为风格示例大图，与缩略图同规则追加版本号） */
function previewUrl(styleKey, version) {
  return thumbnailUrl(`art_skills/${styleKey}/images/1.webp`, version);
}

/** 取缓存中某风格的 image_version（未命中回退 1） */
function imageVersionOf(styleKey) {
  const s = styleCache.find((x) => x.key === styleKey);
  return s?.image_version ?? 1;
}

/** 列出全部风格（含名称 / 缩略图 / 预览大图 / 关联提示词文件名 / 大类），供前端风格选择器使用。
 *  读内存缓存（DB 驱动）；表未建/为空时回退 ART_STYLES 常量。仅返回 enabled 的风格。 */
export function listArtStyles() {
  const src = styleCache.length ? styleCache : fallbackCache();
  return src
    .filter((s) => s.enabled !== false)
    .map((s) => {
      const category = getStyleCategory(s.key);
      const thumb = s.thumbnail || `art_skills/${s.key}/images/preview.webp`;
      return {
        key: s.key,
        name: s.name,
        thumbnailUrl: thumbnailUrl(thumb, s.image_version),
        previewUrl: previewUrl(s.key, s.image_version),
        prompts: Object.keys(PROMPT_FILES),
        category,
        categoryLabel: (STYLE_CATEGORIES.find((c) => c.value === category) || {}).label || category,
      };
    });
}

/** 把 project.style（key 或中文名 / 旧值）解析为合法风格 key，未命中回退默认。
 *  查内存缓存；未命中回退 DEFAULT_STYLE_KEY。 */
export function resolveStyleKey(styleValue) {
  if (!styleValue) return DEFAULT_STYLE_KEY;
  const v = String(styleValue).trim();
  const src = styleCache.length ? styleCache : fallbackCache();
  const hit = src.find((s) => s.key === v || s.name === v);
  return hit ? hit.key : DEFAULT_STYLE_KEY;
}

/** 取风格中文名 */
export function getStyleName(styleKey) {
  const src = styleCache.length ? styleCache : fallbackCache();
  const s = src.find((x) => x.key === styleKey) || src.find((x) => x.key === DEFAULT_STYLE_KEY);
  return s?.name || '';
}

/** 取风格的 image_version（供外部拼接缓存破坏 URL） */
export function getStyleImageVersion(styleKey) {
  return imageVersionOf(styleKey);
}

/** 列出全部叙事类型（含 key / 名称），供前端叙事类型选择器使用 */
export function listNarrativeTypes() {
  return NARRATIVE_TYPES.map((t) => ({ key: t.key, name: t.name }));
}

/** 把 project.narrative_type（key 或中文名 / 旧值）解析为合法叙事类型 key，未命中回退默认 */
export function resolveNarrativeKey(value) {
  if (!value) return DEFAULT_NARRATIVE_KEY;
  const v = String(value).trim();
  const hit = NARRATIVE_TYPES.find((t) => t.key === v || t.name === v);
  return hit ? hit.key : DEFAULT_NARRATIVE_KEY;
}

/** 取叙事类型中文名 */
export function getNarrativeName(narrativeKey) {
  const t = NARRATIVE_TYPES.find((x) => x.key === narrativeKey) || NARRATIVE_TYPES.find((x) => x.key === DEFAULT_NARRATIVE_KEY);
  return t.name;
}

// 提示词文件内容缓存：(styleKey, logicalName) -> 正文
const promptCache = new Map();

/** 清某风格所有提示词缓存（admin 在线编辑 .md 落盘后调用，使下次读取重读磁盘） */
export function invalidatePromptCache(styleKey) {
  if (!styleKey) return;
  for (const k of promptCache.keys()) {
    if (k.startsWith(`${styleKey}:`)) promptCache.delete(k);
  }
}

/** 剥离 YAML frontmatter（--- ... ---），prefix.md 无 frontmatter 时原样返回 */
function stripFrontmatter(text) {
  return text.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

/** 读取单份提示词正文（带缓存，文件缺失返回 null） */
export function loadRawPrompt(styleKey, logicalName) {
  const rel = PROMPT_FILES[logicalName];
  if (!rel) return null;
  const cacheKey = `${styleKey}:${logicalName}`;
  if (promptCache.has(cacheKey)) return promptCache.get(cacheKey);

  const abs = path.join(SKILLS_ROOT(), 'art_skills', styleKey, rel);
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    const body = stripFrontmatter(raw);
    promptCache.set(cacheKey, body);
    return body;
  } catch (e) {
    logger.warn(`[artSkills] 提示词文件缺失，已跳过：${styleKey}/${rel}`);
    promptCache.set(cacheKey, null);
    return null;
  }
}

/** 读取通用 production_skills 提示词正文（带缓存，文件缺失返回 null） */
export function loadAdditionSkill(name) {
  const cacheKey = `addication:${name}`;
  if (promptCache.has(cacheKey)) return promptCache.get(cacheKey);
  const abs = path.join(SKILLS_ROOT(), 'addition_skills', `${name}.md`);
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    const body = stripFrontmatter(raw);
    promptCache.set(cacheKey, body);
    return body;
  } catch (e) {
    logger.warn(`[artSkills] addition_skill 缺失，已跳过：${name}.md`);
    promptCache.set(cacheKey, null);
    return null;
  }
}

/** 读取通用 production_skills 提示词正文（带缓存，文件缺失返回 null） */
export function loadProductionSkill(name) {
  const cacheKey = `production:${name}`;
  if (promptCache.has(cacheKey)) return promptCache.get(cacheKey);
  const abs = path.join(SKILLS_ROOT(), 'production_skills', `${name}.md`);
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    const body = stripFrontmatter(raw);
    promptCache.set(cacheKey, body);
    return body;
  } catch (e) {
    logger.warn(`[artSkills] production_skill 缺失，已跳过：${name}.md`);
    promptCache.set(cacheKey, null);
    return null;
  }
}

/** 读取叙事技法提示词正文（带缓存，文件缺失返回 null） */
export function loadNarrativeSkill(narrativeKey, logicalName) {
  const rel = NARRATIVE_PROMPT_FILES[logicalName];
  if (!rel) return null;
  const cacheKey = `narrative:${narrativeKey}:${logicalName}`;
  if (promptCache.has(cacheKey)) return promptCache.get(cacheKey);
  const abs = path.join(SKILLS_ROOT(), 'story_skills', narrativeKey, rel);
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    const body = stripFrontmatter(raw);
    promptCache.set(cacheKey, body);
    return body;
  } catch (e) {
    logger.warn(`[artSkills] 叙事技法缺失，已跳过：${narrativeKey}/${rel}`);
    promptCache.set(cacheKey, null);
    return null;
  }
}

/**
 * 按逻辑名顺序拼接多份提示词，组成 system 字符串（段间空行分隔）。
 * 任一文件缺失则跳过，不抛错。
 */
export function buildSystem(styleKey, logicalNames) {
  const parts = [];
  for (const name of logicalNames || []) {
    const body = loadRawPrompt(styleKey, name);
    if (body) parts.push(body);
  }
  return parts.join('\n\n');
}

/**
 * 按逻辑名顺序拼接多份「叙事技法」提示词，组成 system 片段（段间空行分隔）。
 * 与 buildSystem 同语义，但读取自 story_skills/<narrativeKey>/。任一文件缺失则跳过。
 */
export function buildNarrativeSystem(narrativeKey, logicalNames) {
  const parts = [];
  for (const name of logicalNames || []) {
    const body = loadNarrativeSkill(narrativeKey, name);
    if (body) parts.push(body);
  }
  return parts.join('\n\n');
}

export default {
  DEFAULT_STYLE_KEY, ART_STYLES, PROMPT_FILES, listArtStyles, resolveStyleKey, getStyleName,
  STYLE_CATEGORIES, getStyleCategory,
  DEFAULT_NARRATIVE_KEY, NARRATIVE_TYPES, NARRATIVE_PROMPT_FILES, listNarrativeTypes, resolveNarrativeKey, getNarrativeName,
  loadRawPrompt, loadAdditionSkill, loadProductionSkill, loadNarrativeSkill, buildSystem, buildNarrativeSystem,
  reloadArtStyles, invalidatePromptCache, getStyleImageVersion,
};
