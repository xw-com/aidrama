# 技能 / 提示词库注入说明

本文件描述 `server/skills/` 目录下各 `.md` 提示词**被读取并注入到大模型调用的真实机制**。
实现全部在 JavaScript 服务层，核心入口为 `src/services/artSkills.service.js`。

> 说明：磁盘上目录名拼写为 `driector_skills`（历史遗留），代码与本文保持与磁盘一致，不做改名。

---

## 一、总体机制

`server/skills/` 是本项目的技能 / 提示词库，分三大块：

| 目录 | 作用 |
|---|---|
| `art_skills/<画风>/` | 视觉画风级提示词（11 套，结构一致） |
| `story_skills/<叙事类型>/` | 叙事类型级技法（12 套，与画风正交） |
| `production_skills/` | 通用分镜技法（不随画风 / 类型变化） |

所有 `.md` 均可带 YAML frontmatter（`name` / `description` / `metaData`），但**注入时只取正文**：
`artSkills.service.js` 的 `stripFrontmatter()` 用正则剥离 `--- ... ---`，再做 `Map` 缓存的 `fs.readFileSync`。

注入是**同步、按需、由调用方拼接**的——不存在 `activate_skill` 工具、不存在决策 / 执行 / 监督子 Agent 层。
每个 AI 服务函数自行用 `buildSystem(...)` / `loadProductionSkill(...)` / `loadNarrativeSystem(...)` 组装 `system` 字符串，传给 `llm.service.js` 的 `chatJSON` / `complete`。

静态资源：`src/app.js` 把 `server/skills/` 挂载为 `/skills` 静态目录（仅供缩略图等图片访问，不涉及提示词注入）。

---

## 二、核心读取 API（`src/services/artSkills.service.js`）

| 函数 | 读取位置 | 说明 |
|---|---|---|
| `loadRawPrompt(styleKey, logicalName)` | `art_skills/<styleKey>/<rel>` | 单份画风提示词正文（带缓存，缺失返回 `null`） |
| `loadProductionSkill(name)` | `production_skills/<name>.md` | 通用分镜技法正文（带缓存） |
| `loadNarrativeSkill(narrativeKey, logicalName)` | `story_skills/<narrativeKey>/<rel>` | 叙事技法正文（带缓存） |
| `buildSystem(styleKey, logicalNames[])` | 同上 | 按序拼接多份画风提示词，段间空行分隔，缺失跳过 |
| `buildNarrativeSystem(narrativeKey, logicalNames[])` | 同上 | 按序拼接多份叙事技法，语义同 `buildSystem` |
| `resolveStyleKey(value)` / `resolveNarrativeKey(value)` | — | 把项目字段（key 或中文名 / 旧值）归一为合法 key，未命中回退默认 |

注册表：`ART_STYLES`（11 画风）、`NARRATIVE_TYPES`（12 叙事类型）、`PROMPT_FILES`、`NARRATIVE_PROMPT_FILES`。
默认值：`DEFAULT_STYLE_KEY = '2D_chinese_guofeng'`、`DEFAULT_NARRATIVE_KEY = 'Sweet_romance_novel'`。

### 逻辑名 → 文件路径映射

**`PROMPT_FILES`（art_skills，相对画风目录）**

| 逻辑名 | 相对路径 |
|---|---|
| `prefix` | `prefix.md` |
| `art_character` / `art_character_derivative` | `art_prompt/art_character.md` / `art_prompt/art_character_derivative.md` |
| `art_scene` / `art_scene_derivative` | `art_prompt/art_scene.md` / `art_prompt/art_scene_derivative.md` |
| `art_prop` / `art_prop_derivative` | `art_prompt/art_prop.md` / `art_prompt/art_prop_derivative.md` |
| `art_storyboard_video` | `art_prompt/art_storyboard_video.md` |
| `director_storyboard` | `driector_skills/director_storyboard.md` |
| `director_planning_style` | `driector_skills/director_planning_style.md` |
| `director_storyboard_table_style` | `driector_skills/director_storyboard_table_style.md` |

**`NARRATIVE_PROMPT_FILES`（story_skills，相对叙事类型目录）**

| 逻辑名 | 相对路径 |
|---|---|
| `director_planning_narrative` | `driector_skills/director_planning_narrative.md` |
| `director_storyboard_table_narrative` | `driector_skills/director_storyboard_table_narrative.md` |

**production_skills（按文件名直接读）**

| 文件 | 逻辑名（调用方传参） |
|---|---|
| `storyboard_prompt_techniques.md` | `'storyboard_prompt_techniques'` |
| `storyboard_table_techniques.md` | `'storyboard_table_techniques'` |

---

## 三、各 AI 调用点的注入清单

下表列出每个 AI 服务函数当前注入的全部技能。`prefix` 始终前置；画风技法、叙事技法、通用技法按需叠加。

### 1. 剧本拆分 `parseScript` — `src/services/ai/script.service.js:11`
- 注入：`prefix`
- 说明：仅锚定画风，不引入分镜 / 叙事技法。

### 2. 资产提取 `extractAssets` — `src/services/ai/extract.service.js:14`
- 注入：`prefix` + `art_character` + `art_scene` + `art_prop`
- 说明：一次性提取角色 / 场景 / 道具，注入三类基础提示词约束。

### 3. 单资产提示词生成 `generateAssetPrompt` — `src/services/ai/assetPrompt.service.js:32`
- 注入：`prefix` + `art_character` + `art_scene` + `art_prop`
- 说明：注入三类基础提示词约束（不区分 kind，统一注入）。

### 4. 分镜表生成 `generateStoryboard` — `src/services/ai/storyboard.service.js:13`
- 注入：
  - 画风：`prefix` + `director_storyboard` + `director_storyboard_table_style`
  - 通用：`storyboard_table_techniques`
  - 叙事：`director_planning_narrative` + `director_storyboard_table_narrative`（按 `project.narrative_type`）
- 说明：分镜表是叙事规划落地的主战场，三类技法全量注入。

### 5. 视频提示词生成 `generateSegmentPrompt` — `src/services/ai/storyboard.service.js:107`
- 注入：
  - 画风：`prefix` + `director_storyboard` + `art_storyboard_video`
  - 通用：`storyboard_prompt_techniques`
  - 叙事：`director_planning_narrative`
- 说明：`art_storyboard_video` 提供该画风的视频风格标签约束。

---

## 四、叙事类型的来源

`Project` 模型有 `narrative_type` 字段（`src/db/models/Project.js`，STRING(64)，可空）。
旧库通过 `src/db/ensureColumns.js` 的 `PROJECT_NEW_COLUMNS` 在启动时幂等补列。

- 写入：`src/routes/project.routes.js` 创建 / 更新接口接收 `narrative_type`。
- 读取：`src/routes/storyboard.routes.js` 在调用 `generateStoryboard` / `generateSegmentPrompt` 时传入 `narrativeType: project.narrative_type`。
- 归一：服务层用 `resolveNarrativeKey()` 兜底，空值或非法值回退 `Sweet_romance_novel`。
- 列表 / 校验接口：`GET /narrative-types`、`GET /narrative-types/resolve`（`src/routes/artstyle.routes.js`），与 `/art-styles` 对称。

> 注：`parseScript` 与 `extractAssets` 当前不注入叙事技法（剧本拆分 / 资产提取与叙事节奏无关）。

---

## 五、目录结构（单套画风 / 叙事类型）

```
art_skills/<画风>/
├── README.md                              ← 风格说明（手册展示用，不注入）
├── prefix.md                              ← 全局锚定前缀（注入）
├── images/                                ← 缩略图（静态资源）
├── art_prompt/
│   ├── art_character.md / art_character_derivative.md
│   ├── art_scene.md     / art_scene_derivative.md
│   ├── art_prop.md      / art_prop_derivative.md
│   └── art_storyboard_video.md
└── driector_skills/
    ├── director_storyboard.md
    ├── director_planning_style.md         ← 当前未注入（预留：导演规划流程）
    └── director_storyboard_table_style.md

story_skills/<叙事类型>/
├── README.md                              ← 类型说明（不注入）
├── images/
└── driector_skills/
    ├── director_planning_narrative.md
    └── director_storyboard_table_narrative.md

production_skills/
├── storyboard_prompt_techniques.md        ← 注入给分镜提示词
└── storyboard_table_techniques.md         ← 注入给分镜表
```

---

## 六、当前未注入的技能文件（预留）

| 文件 | 原因 |
|---|---|
| `art_skills/<画风>/README.md` | 仅风格说明，非提示词 |
| `story_skills/<类型>/README.md` | 仅类型说明，非提示词 |
| `driector_skills/director_planning_style.md` | 预留给"导演规划"子流程；当前代码无该流程，暂不注入 |
| `art_prompt/art_character_derivative.md` / `art_scene_derivative.md` / `art_prop_derivative.md` | 衍生资产约束手册；当前无独立"衍生资产生图"流程，暂不注入（`PROMPT_FILES` 中已声明，待该流程启用时接入） |
| `art_skills_副本/` | 历史副本目录，加载器只读 `art_skills/`，不会被读取 |

---

## 七、管理后台 / CRUD

当前 `skills/` 下的提示词文件**无后台 CRUD 路由**——`src/routes/index.js` 未注册任何技能读写接口。
画风与叙事类型仅通过 `/art-styles`、`/narrative-types` 两个只读列表接口暴露给前端选择器。
如需在线编辑技能文件，需另行新增 `getSkillList` / `getSkillContent` / `saveSkillContent` 等路由（含路径穿越校验）。

---

## 一句话总结

`server/skills/` 下的 `.md` 由 `artSkills.service.js` 同步读取（剥离 frontmatter + 缓存），由 4 个 AI 服务函数
（`parseScript` / `extractAssets` / `generateAssetPrompt` / `generateStoryboard`+`generateSegmentPrompt`）
按画风 + 叙事类型 + 通用技法自行拼接成 `system` 字符串注入大模型；`prefix` 始终前置，其余按调用点职责按需叠加。
