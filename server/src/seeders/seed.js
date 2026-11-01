import db from '../db/index.js';
import { clearPricingCache } from '../services/pricing.service.js';
import { ART_STYLES, getStyleCategory } from '../services/artSkills.service.js';

const { Pricing, ModelVendor, ArtStyle } = db;

// 默认定价（与产品文案一致：分镜脚本100字=2积分，分镜视频每秒=11积分）
const DEFAULT_PRICING = [
  { feature: 'script_parse', name: '剧本拆分', unit_desc: '每千字符', credits_per_unit: 10, unit: 1000, model_type: 'text', sort: 1 },
  { feature: 'asset_extract', name: '资产提取(角色/场景/道具)', unit_desc: '每集', credits_per_unit: 20, unit: 1, model_type: 'text', sort: 2 },
  { feature: 'asset_image', name: '资产图生成', unit_desc: '每张', credits_per_unit: 5, unit: 1, model_type: 'image', sort: 3 },
  { feature: 'storyboard_script', name: '分镜脚本生成', unit_desc: '每100字符', credits_per_unit: 2, unit: 100, model_type: 'text', sort: 4 },
  { feature: 'segment_video', name: '分镜视频生成', unit_desc: '每秒', credits_per_unit: 11, unit: 1, model_type: 'video', sort: 6 },
  { feature: 'video_synthesis', name: '视频合成', unit_desc: '每集', credits_per_unit: 30, unit: 1, model_type: null, sort: 8 },
  { feature: 'video_subtitle', name: '成片加字幕', unit_desc: '每分钟', credits_per_unit: 2, unit: 60, model_type: 'asr', sort: 15 },
  { feature: 'subtitle_correct', name: '字幕智能校正', unit_desc: '每次', credits_per_unit: 2, unit: 1, model_type: 'text', sort: 16 },
  { feature: 'editor_export', name: '剪辑导出', unit_desc: '每分钟', credits_per_unit: 2, unit: 60, model_type: null, sort: 17 },
  { feature: 'segment_prompt', name: '分镜提示词生成', unit_desc: '每条', credits_per_unit: 1, unit: 1, model_type: 'text', sort: 9 },
  // —— 剧本创作工作台（4 步向导）——
  { feature: 'script_outline', name: '剧本大纲生成', unit_desc: '每次', credits_per_unit: 6, unit: 1, model_type: 'text', sort: 11 },
  { feature: 'episode_split', name: '分集概要生成', unit_desc: '每次', credits_per_unit: 4, unit: 1, model_type: 'text', sort: 12 },
  { feature: 'episode_detail', name: '分集剧情细化', unit_desc: '每集', credits_per_unit: 8, unit: 1, model_type: 'text', sort: 13 },
];

export async function runSeed() {
  // 1. 定价（仅补插缺失的 feature 行；已存在的行不动——价格/启停尊重管理台「功能定价」的修改，
  // 否则每次重启 runSeed 都会把 admin 改过的定价覆盖回常量值。口径同下方 ensureArtStyles）
  for (const p of DEFAULT_PRICING) {
    const exists = await Pricing.findOne({ where: { feature: p.feature } });
    if (exists) continue;
    await Pricing.create({ ...p, enabled: true });
  }
  clearPricingCache();

  // 2. 默认模型厂商目录（全局共享，按 code 幂等）
  await ensureModelVendors();

  // 3. 美术风格注册表（从 ART_STYLES 常量幂等导入；已存在的 key 不动，尊重 admin 改名/重排）
  await ensureArtStyles();

  // 模型配置由用户在「大模型配置」界面自行添加，不再从 .env 种子写入全局默认配置
  // 预设音色不再种子导入，由「声音库」界面 admin 手工维护

  return { vendors: DEFAULT_VENDORS.length, artStyles: ART_STYLES.length };
}

// 美术风格种子：遍历 ART_STYLES 常量，按数组顺序 sort_order=index，
// 仅插入 DB 中不存在的 key（保留 admin 对已有行的改名/重排/启停）
async function ensureArtStyles() {
  if (!ArtStyle) return;
  for (let i = 0; i < ART_STYLES.length; i++) {
    const s = ART_STYLES[i];
    const exists = await ArtStyle.findOne({ where: { key: s.key } });
    if (exists) continue;
    await ArtStyle.create({
      key: s.key,
      name: s.name,
      category: getStyleCategory(s.key),
      thumbnail: s.thumbnail || `art_skills/${s.key}/images/preview.webp`,
      sort_order: i,
      enabled: true,
      image_version: 1,
    });
  }
}

// 默认厂商目录（code 作为唯一键，已存在则跳过）
const DEFAULT_VENDORS = [
  { name: 'OpenAI 兼容', code: 'openai', base_url: 'https://api.openai.com/v1', api_style: 'openai', supported_types: ['text', 'image', 'video'], website: 'https://openai.com', sort: 1 },
  { name: '自定义接口', code: 'custom', base_url: '', api_style: 'custom', supported_types: ['text', 'image', 'video'], description: '自定义请求/响应解析', sort: 90 },
  { name: '本地 ffmpeg', code: 'local-ffmpeg', base_url: '', api_style: 'custom', supported_types: ['video'], description: '本地 ffmpeg 合成，无需外部 API', sort: 99 },
  { name: '火山引擎 / Seedance', code: 'volcengine', base_url: 'https://ark.cn-beijing.volces.com/api/v3', api_style: 'openai', supported_types: ['text', 'image', 'video'], website: 'https://www.volcengine.com', sort: 10 },
  { name: '通义千问 / DashScope', code: 'dashscope', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_style: 'openai', supported_types: ['text', 'image'], website: 'https://dashscope.aliyun.com', sort: 11 },
  { name: 'MiniMax', code: 'minimax', base_url: 'https://api.minimax.io/v2', api_style: 'openai', supported_types: ['video'], website: 'https://platform.minimax.io', sort: 12 },
  // —— 国内大模型厂商（OpenAI 兼容，可直接对接）——
  { name: '智谱 GLM', code: 'zhipu', base_url: 'https://open.bigmodel.cn/api/paas/v4', api_style: 'openai', supported_types: ['text', 'image'], website: 'https://open.bigmodel.cn', description: 'GLM-4 系列 / CogView 文生图，OpenAI 兼容', sort: 13 },
  { name: '腾讯混元 Hunyuan', code: 'hunyuan', base_url: 'https://api.hunyuan.cloud.tencent.com/v1', api_style: 'openai', supported_types: ['text'], website: 'https://cloud.tencent.com/product/hunyuan', description: '腾讯混元，OpenAI 兼容 /v1/chat/completions', sort: 14 },
  { name: '月之暗面 Kimi', code: 'moonshot', base_url: 'https://api.moonshot.cn/v1', api_style: 'openai', supported_types: ['text'], website: 'https://platform.moonshot.cn', description: 'Kimi / Moonshot，长上下文，OpenAI 兼容', sort: 15 },
  { name: '阶跃星辰 Stepfun', code: 'stepfun', base_url: 'https://api.stepfun.com/v1', api_style: 'openai', supported_types: ['text', 'image', 'video'], website: 'https://platform.stepfun.com', description: 'Step 系列 / Step-Video，OpenAI 兼容', sort: 16 },
  { name: '百度文心 / 千帆', code: 'ernie', base_url: 'https://qianfan.baidubce.com/v2', api_style: 'openai', supported_types: ['text'], website: 'https://qianfan.cloud.baidu.com', description: 'ERNIE 文心一言（千帆 ModelBuilder），OpenAI 兼容', sort: 17 },
  { name: '零一万物 Yi', code: 'lingyiwanwu', base_url: 'https://api.lingyiwanwu.com/v1', api_style: 'openai', supported_types: ['text'], website: 'https://platform.lingyiwanwu.com', description: '01.AI Yi 系列，OpenAI 兼容', sort: 18 },
  // —— 国际大模型厂商 ——
  { name: 'Google Gemini', code: 'google', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', api_style: 'openai', supported_types: ['text', 'image'], website: 'https://ai.google.dev', description: 'Gemini，官方 OpenAI 兼容端点', sort: 19 },
  { name: 'Anthropic Claude', code: 'anthropic', base_url: 'https://api.anthropic.com/v1', api_style: 'custom', supported_types: ['text'], website: 'https://www.anthropic.com', description: 'Claude，原生 Messages API（/v1/messages，需 custom 适配）', sort: 20 },
  { name: 'xAI Grok', code: 'xai', base_url: 'https://api.x.ai/v1', api_style: 'openai', supported_types: ['text', 'image'], website: 'https://x.ai', description: 'Grok 系列，OpenAI 兼容', sort: 21 },
  { name: 'Mistral AI', code: 'mistral', base_url: 'https://api.mistral.ai/v1', api_style: 'openai', supported_types: ['text'], website: 'https://mistral.ai', description: 'Mistral / Pixtral，OpenAI 兼容', sort: 22 },
  { name: 'Meta Llama', code: 'meta', base_url: '', api_style: 'openai', supported_types: ['text'], website: 'https://llama.meta.com', description: 'Llama 开源权重，经 Together AI / Groq / Replicate 等托管平台（OpenAI 兼容）调用', sort: 23 },
  // —— 视频生成厂商（异步任务，custom 适配）——
  { name: '快手可灵 Kling', code: 'kling', base_url: 'https://api.klingai.com', api_style: 'custom', supported_types: ['video', 'image'], website: 'https://klingai.com', description: '可灵视频/图像生成，异步任务（JWT 鉴权，需 custom 适配）', sort: 24 },
  { name: '生数 Vidu', code: 'vidu', base_url: 'https://api.vidu.cn/ent/v2', api_style: 'custom', supported_types: ['video'], website: 'https://platform.vidu.cn', description: 'Vidu 视频生成，异步任务（Token 鉴权，需 custom 适配）', sort: 25 },
  // —— 语音识别厂商（OpenAI 兼容 /audio/transcriptions，成片加字幕用）——
  { name: '硅基流动 SiliconFlow', code: 'siliconflow', base_url: 'https://api.siliconflow.cn/v1', api_style: 'openai', supported_types: ['text', 'image', 'asr'], website: 'https://siliconflow.cn', description: 'SenseVoice/Whisper 语音识别，OpenAI 兼容 /audio/transcriptions', sort: 26 },
  { name: 'Groq', code: 'groq', base_url: 'https://api.groq.com/openai/v1', api_style: 'openai', supported_types: ['text', 'asr'], website: 'https://groq.com', description: 'Whisper 系语音识别（高速），OpenAI 兼容 /audio/transcriptions', sort: 27 },
  // —— 语音识别厂商（火山自有协议，成片加字幕用）；code 独立于 volcengine(Seedance/ark) ——
  { name: '火山引擎·豆包语音', code: 'volcengine-speech', base_url: 'https://openspeech.bytedance.com/api/v3', api_style: 'custom', supported_types: ['asr'], website: 'https://www.volcengine.com/product/doubao', description: '豆包录音文件识别；模型填 Resource ID（volc.seedasr.auc / volc.bigasr.auc / volc.bigasr.auc_turbo），key 填 X-Api-Key 或 旧版 appid:accesskey', sort: 28 },
  // —— ComfyUI 工作流（AutoDL 托管，两段式异步任务：提交返 task_id + 轮询 result）——
  { name: 'AutoDL ComfyUI', code: 'autodl-comfyui', base_url: 'https://autodl.art/api/v1', api_style: 'custom', supported_types: ['video'], website: 'https://autodl.art', description: 'ComfyUI 工作流视频生成；模型填工作流ID，Key 填「令牌管理」创建的 ComfyUI 分组令牌；工作流专属入参（时长档位/分辨率档位/图片字段等，见工作流抽屉）在 params 中填写，置 null 的键会从提交体剔除', sort: 29 },
  { name: 'Agnes AI', code: 'agnes', base_url: 'https://apihub.agnes-ai.com/v1', api_style: 'openai', supported_types: ['video'], website: 'https://www.agnes-ai.com', description: 'Agnes Video 2.5 视频生成（OpenAI Videos 兼容）；文生视频/参考图/参考视频/参考音频，模型填 agnes-video-2.5', sort: 30 },
  { name: 'Agnes AI 国内中转', code: 'agnes_cn', base_url: 'https://apihub.agnes-ai.cn/v1', api_style: 'openai', supported_types: ['video'], website: 'https://www.agnes-ai.cn', description: 'Agnes Video 2.5 国内中转端点，契约与 agnes 完全一致（共用处理逻辑）；base_url 填中转站地址（含 /v1），模型/key 按中转站为准', sort: 31 },
  // —— 万相3.0 视频生成（千问AI平台异步任务，全模态参考生视频；协议同族兼容百炼 DashScope 端点）——
  { name: '千问AI平台 / 万相', code: 'aliwan', base_url: 'https://maas.qianwenaiapi.com/api/v1', api_style: 'custom', supported_types: ['video'], website: 'https://platform.qianwenai.com', description: '万相3.0 视频生成（wan3.0-video / wan3.0-video-prime）：全模态参考生视频（≤10参考图+≤5参考视频+≤5参考音频，按 图N/视频N/音频N 引用）、文生视频与视频编辑（去除字幕）；模型填 wan3.0-video，Key 填千问AI平台 API Key（platform.qianwenai.com 获取，sk- 开头）；协议同族，base_url 也可填阿里云百炼 https://dashscope.aliyuncs.com/api/v1（Key 随端点对应）', sort: 32 },
];

async function ensureModelVendors() {
  for (const v of DEFAULT_VENDORS) {
    const exists = await ModelVendor.findOne({ where: { code: v.code } });
    if (exists) continue;
    await ModelVendor.create({ ...v, enabled: true });
  }
}

export const SAMPLE_SCRIPT = `引子 穿越的唐家三少

唐门外门弟子唐三，因偷学内门绝学为唐门所不容，跳崖明志时却发现自己没有死去，反而穿越到了另一个世界——斗罗大陆。

这里没有魔法，没有斗气，没有武术，却有神奇的武魂。这里的每个人，在自己六岁的时候，都会在武魂殿中令武魂觉醒。武魂可以辅助人们的日常生活，而其中一些特别出色的武魂却可以用来修炼并进行战斗，成为斗罗大陆上最为强大也是最重要的职业——魂师。

唐三来到了斗罗大陆，他的武魂是蓝银草，先天满魂力。在诺丁学院，他遇到了大师玉小刚，开始了魂师之路。村长老杰克带着他前往武魂殿觉醒武魂。鬼见愁顶峰上，唐昊沉默地打着铁。

唐三暗下决心，一定要在这个世界重新修炼唐门绝学，将唐门发扬光大。`;
