---
name: director_storyboard
description: 导演分镜提示词技法 · 3D潮玩手办盲盒
metaData: director_skills
---

# 分镜提示词 · 3D潮玩手办盲盒 · 风格专属技法

---

## 适用范围

本 Skill 专用于**3D潮玩手办盲盒**风格的分镜提示词生成。

---

## 情绪 → 面容/眼神词映射

| 情绪输入 | 面容词 | 眼神词 | 微表情补充 |
|----------|--------|--------|-----------|
| 惊喜 / 开箱 | 眼睛圆睁，表情生动 | 眼神发亮，目光聚焦 | 嘴巴微张成 O 型，表情惊喜 |
| 治愈 / 萌系 | 神情柔软，眉眼弯弯 | 眼神温柔，目光柔和 | 嘴角上扬成弧形，腮红圆润 |
| 潮酷 / 玩味 | 神情酷感，嘴角微扬 | 眼神俏皮，单眼眨眼 | 眨眼俏皮，表情自信 |
| 期待 / 盼望 | 眼睛发亮，表情鲜活 | 眼神期待，目光闪烁 | 嘴角上扬，表情跃跃欲试 |
| 傲娇 / 得意 | 神情得意，下巴微抬 | 眼神斜瞥，目光骄傲 | 嘴角上翘，表情小骄傲 |
| 呆萌 / 困惑 | 眼睛圆睁，表情空白 | 眼神直视，目光呆萌 | 头微歪，表情发呆 |
| 陶醉 / 满足 | 眼睛眯起，表情沉醉 | 眼神闭弧，目光满足 | 嘴角上扬，腮红更深 |
| 忐忑 / 紧张 | 眼神游移，表情拘谨 | 目光躲闪，眼神不安 | 嘴抿起，双手捏紧 |
| 失落 / 委屈 | 眼神下垂，表情委屈 | 目光黯淡，眼神含泪 | 嘴角下沉，表情委屈 |
| 坚定 / 决心 | 神情认真，目光清亮 | 眼神坚定，目光向前 | 下巴微抬，表情果敢 |

---

## 光影氛围词库（3D潮玩）

### 时间段光线

| 时间段 | 主光词 | 色调词 | 气氛词 |
|--------|--------|--------|--------|
| 清晨影棚 | 柔光箱暖白侧射，干净漫射 | 奶白 + 潮玩粉 | 清新通透，干净期待 |
| 正午柔光 | 明亮均匀柔光，阴影极淡 | 潮玩粉 + 电光蓝 | 糖果色鲜明，明亮活泼 |
| 黄昏舞台暖光 | 暖橙逆光，舞台金光 | 芥末黄 + 潮玩粉渐变 | 暖光余晖，轮廓光闪耀 |
| 夜间 LED 柜光 | 冷调 LED 背光，展示柜亮起 | 电光蓝 + 镭射白 | 冷调静谧，限定陈列 |
| 派对夜光 | 霓虹彩光，亮片闪烁 | 糖果色霓虹 + 高饱和 | 热闹狂欢，发售庆典 |

### 情绪光影

| 情绪基调 | 光线类型 | 补充约束 |
|----------|----------|----------|
| 开箱惊喜 | 柔光开箱（A），干净漫射 + 糖果高光 | 影棚柔光箱，避免硬影 |
| 限定奢华 | 镭射反光（B），全息色散 + 冷调反射 | 展示柜 LED 背光，低阴影 |
| 萌系治愈 | 柔光开箱（A）减弱，均匀柔光 | 潮玩粉 + 奶白，无硬影 |
| 街头酷玩 | 侧光硬朗，涂鸦反光 | 哑光黑 + 电光蓝，中对比 |
| 派对狂欢 | 派对霓虹（D），彩光 + 亮片 | 高饱和霓虹，闪烁高光 |
| 收藏静谧 | 展柜 LED（C），冷调静谧 | 电光蓝 + 镭射白，景深远 |

---

## 场景质感约束词（按场景类型）

| 场景类型 | 必加约束词 |
|----------|-----------|
| 潮玩展示柜 | 透明亚克力柜、LED 灯带、分层隔板、镭射贴纸、通透明亮 |
| 盲盒开箱桌面 | 干净桌面、撕膜盲盒、亮片、编号卡、开箱工具、惊喜氛围 |
| 潮玩店货架 | 金属货架、整墙盲盒、价签、IP 海报、整齐丰盛 |
| 拍摄小影棚 | 柔光箱、纯色背景纸、反光板、迷你底座、产品主图 |
| 收藏展示墙 | 整面亚克力格、编号陈列、收藏证书、安静专注 |
| 派对发布会 | 气球墙、缎带、霓虹灯牌、彩光、亮片桶、热闹盛大 |

---

## @ImageX 锚点规范（本风格专属）

> 潮玩分镜强调"角色手办/场景/核心道具"的可识别性与跨镜头一致性。所有镜头必须对关键资产使用 `@ImageX_{名称}` 锚点，确保后续生成时锚定到对应参考资产。

| 资产类型 | 锚点写法 | 示例 |
|---|---|---|
| 手办角色 | `@ImageX_{IP角色名} 潮玩手办Q版造型` | `@ImageX_盲盒小精灵 潮玩手办Q版造型` |
| 场景 | `@ImageX_{场景名} 潮玩展示场景` | `@ImageX_展示柜 潮玩展示场景` |
| 核心道具 | `@ImageX_{道具名} 潮玩道具` | `@ImageX_编号卡 潮玩道具` |

- 每个镜头提示词中，出镜的手办/场景/核心道具必须带对应 `@ImageX_` 锚点
- 锚点名称需与角色/场景/道具资产命名严格一致，保证跨镜头连续性
- 仅背景中无关紧要的元素可不锚定

---

## 固定风格锚定词（所有输出必须包含）

**3D渲染锚定（必选）：**

3D潮玩手办渲染，高精度建模，光泽乙烯塑料质感，圆润倒角，影棚级光影

**人物质感（含手办镜头时必选）：**

3D潮玩建模，光泽乙烯涂装，Q版大头小身比例，印花表情清晰，糖果色高光，光影层次丰富

**场景质感（含场景镜头时必选）：**

3D场景渲染，亚克力折射，LED 背光，景深虚化，体积光

**一致性锚定（参考图模式必选）：**

保持手办造型与参考图一致，保持场景风格与参考图一致，保持光影色彩基调统一

**风格收尾（固定）：**

3D潮玩手办渲染，光泽乙烯质感，糖果色彩盘，影棚级渲染

**画质锁定词（所有输出必须包含，置于风格收尾之后）：**

模式A（中文）——默认（画面无画内文字需求时）：
3D高清渲染，高细节，高精度建模，光泽乙烯质感，画面无字幕、无水印、无标题叠字

模式A（中文）——画内文字场景（画面描述中含编号卡/镭射贴纸/IP logo 等道具文字时）：
3D高清渲染，高细节，高精度建模，光泽乙烯质感，画面无字幕、无水印、无标题叠字，编号卡/镭射贴纸/IP logo 等道具上的文字清晰可辨

模式B（英文）——默认：
3D designer toy render, high-poly modeling, glossy vinyl, chibi proportion, candy pastel palette, cinematic lighting, high detail, no subtitles, no captions, no watermark, no title overlay

模式B（英文）——画内文字场景：
3D designer toy render, high-poly modeling, glossy vinyl, chibi proportion, candy pastel palette, cinematic lighting, high detail, no subtitles, no captions, no watermark, no title overlay, legible text on in-scene props such as number cards and holographic stickers

**负向词模板（模式B 必须包含，置于提示词末尾）：**

> ⚠️ Seedream（模式A）**不支持负向提示词**，负向词仅适用于模式B。模式A 通过正向词中的质感锚定和画质锁定来保证画面质量。

模式B（英文）：
no photorealistic, no realistic photography, no real human skin, no low-poly, no rough modeling, no cheap plastic, no 2D cartoon, no anime, no flat illustration, no Chinese traditional, no ink wash, no ancient style, no dark horror, no blood, no subtitles, no captions, no watermark, no title overlay, no UI text

---

## 美学禁止项（生成时严格规避）

以下词汇/风格不得出现于输出提示词中：

- ❌ 写实摄影/照片级真实感/真人肌肤质感词（如：photorealistic, realistic photography, real human skin）
- ❌ 2D 卡通/二次元/扁平插画/无 3D 体积感
- ❌ 传统东方古典风格（东方古韵 / 写意古典 / 传统东方绘画等）
- ❌ 低精度建模/粗糙贴图/廉价塑料感/low-poly
- ❌ 写实人体比例/真人五官
- ❌ 色彩混乱/硬阴影浓重/透视错误
- ❌ 阴暗恐怖/血腥/战争题材
- ❌ 写实生活化脏乱场景（必须为潮玩展示/开箱/收藏场景）

> 💡 **例外**：某些现代 3D 渲染技术（如光线追踪、体积光、镭射全息反光）可以合理使用，但应保持潮玩美学基调。

---

## 分镜卡片模板

每个分镜输出须符合以下卡片字段（由分镜表行数据驱动）：

| 字段 | 说明 |
|---|---|
| 序号 | 镜头编号 |
| 画面描述 | 镜头内容一句话描述（含 @ImageX 锚点） |
| 场景 | 关联场景资产名 |
| 关联资产 | 出镜手办/道具资产名（@ImageX 锚定） |
| 时长 | 镜头秒数（潮玩镜头多为 3-6s） |
| 景别 | 大全景/全景/中景/近景/特写 |
| 运镜 | 缓推/环绕转台/平移/升降（详见运镜规范） |
| 角色动作 | 手办动作（转台旋转/配件替换/轻微摇摆） |
| 情绪 | 惊喜/治愈/潮酷/期待/傲娇 等 |
| 光影氛围 | 映射光影矩阵 A-G |

---

## 完整生成示例

> 以下为同一输入分别使用模式A和模式B的对照展示，实际使用时**仅输出其中一种**。

### 输入（分镜表行数据）

| 序号 | 画面描述 | 场景 | 关联资产名称 | 时长 | 景别 | 运镜 | 角色动作 | 情绪 | 光影氛围 |
|------|---------|------|-------------|------|------|------|---------|------|----------|
| 1 | 盲盒小精灵立于展示柜中，转台缓慢旋转 | 展示柜 | 盲盒小精灵 | 5s | 中景 | 环绕转台 | 转台旋转，呆萌直视 | 治愈 / 萌系 | 柔光开箱 |

### 示例输出A（模式A · Seedream）

[Prompt]
@ImageX_盲盒小精灵 潮玩手办Q版造型，@ImageX_展示柜 潮玩展示场景，3D潮玩手办渲染，高精度建模，光泽乙烯塑料质感，圆润倒角，影棚级光影，3D潮玩建模，光泽乙烯涂装，Q版大头小身比例，印花表情清晰，糖果色高光，光影层次丰富，中景构图，盲盒小精灵立于展示柜透明亚克力底座上，转台缓慢旋转，神情呆萌直视，眼神温柔，奶白素体配潮玩粉涂装，LED 背光勾勒轮廓，糖果色高光，镭射贴纸点缀，体积光氛围，景深虚化，3D潮玩手办渲染，光泽乙烯质感，糖果色彩盘，影棚级渲染，3D高清渲染，高细节，高精度建模，光泽乙烯质感，画面无字幕、无水印、无标题叠字。
Based on the reference image of 盲盒小精灵，maintain consistent: face print, chibi proportion, costume paint. Generate a new scene: figure on rotating turntable inside illuminated display cabinet. Keep visual style identical to reference.

### 示例输出B（模式B · Nanobanana）

```xml
<role>
You are a 3D designer-toy storyboard artist.
Maintain strict visual continuity across all shots.
</role>
<character_reference>
Image [1]: 盲盒小精灵 — 3D潮玩手办造型，Q版大头小身，奶白素体配潮玩粉涂装，光泽乙烯质感
</character_reference>
<continuity_rules>
- Same face print, chibi proportion, paint job across ALL shots
- Same 3D rendered style, glossy vinyl, candy palette
- Same scene lighting, display cabinet aesthetic
- Do NOT introduce photorealistic, 2D cartoon, or Chinese traditional elements
</continuity_rules>
<shot>
Medium shot, @ImageX_盲盒小精灵 chibi collectible figure standing on clear acrylic turntable inside illuminated display cabinet, gentle rotation, adorable straight gaze, soft expression, candy pink print on milk white body, LED backlight rim light, candy color highlights, holographic sticker accents, volumetric lighting, depth of field blur, PBR material rendering, high-poly modeling, glossy vinyl, chibi proportion, candy pastel palette, studio softbox, cinematic, high detail, no subtitles, no captions, no watermark, no title overlay.
</shot>
<negative>
no photorealistic, no realistic photography, no real human skin, no low-poly, no rough modeling, no cheap plastic, no 2D cartoon, no anime, no flat illustration, no Chinese traditional, no ink wash, no ancient style, no dark horror, no blood, no subtitles, no captions, no watermark, no title overlay, no UI text
</negative>
```

---

## 快速参考卡

### 情绪 → 画面词速查

| 情绪 | 面容关键词 | 光线匹配 |
|------|-----------|---------|
| 惊喜 | 眼睛圆睁，表情生动 | 柔光开箱（A）+ 糖果高光 |
| 治愈 | 神情柔软，眉眼弯弯 | 柔光开箱（A）+ 均匀柔光 |
| 潮酷 | 神情酷感，单眼眨眼 | 侧光硬朗 + 涂鸦反光 |
| 期待 | 眼睛发亮，表情鲜活 | 柔光开箱（A）+ 高调亮光 |
| 陶醉 | 眼睛眯起，表情沉醉 | 柔光开箱（A）+ 暖光点缀 |
| 坚定 | 神情认真，目光清亮 | 签名高定（F）+ 清晰轮廓 |
