# 视频提示词 · 视觉风格约束

生成视频提示词时，必须注入以下视觉风格标签：

| 模式 | 风格标签 |
|------|----------|
| **通用多参模式（英文）** | `Chinese ink-wash animation, hand-drawn ink brush, ink wash gradient (scorched/concentrated/heavy/light/clear), xuan paper texture, negative space, spirit resonance, monochrome ink with restrained cinnabar accent, cinematic, poetic` |
| **通用首尾帧模式（英文）** | `Chinese ink-wash animation, hand-drawn ink brush, ink wash gradient, xuan paper texture, negative space, monochrome ink with restrained cinnabar accent, cinematic, poetic, shallow depth of field through ink wash blur` |
| **Seedance 2.0（中文）** | `水墨动画风格，二维手绘水墨动画，焦浓重淡清五色晕染，宣纸纤维质感，留白意境，气韵生动，黑白灰墨色主体配克制朱砂点缀，漫射天光6000K无直射硬光，墨色浓淡即光影，电影诗意质感` |

### Seedance 2.0 物理执行锚点（视频生成必含）

| 参数项 | 取值约束 |
|---|---|
| 色温 | 漫射天光 5800-6200K，无强直射，无CG式硬光 |
| 光比 | 墨色浓淡即光比，对比度中低 35-55%，忌黑白硬对比 |
| 明暗逻辑 | 近景焦墨 #2A2A2A、中景浓墨 #4A4A4A、远景淡墨 #8A8A8A、高光为宣纸白 #F2EDE0 |
| 点缀色 | 朱砂印 #A83232 与青绿 #6E8A6A 全画面占比 ≤ 3%，仅落款/点睛/封印 |
| 运动逻辑 | 衣袂/云雾/水纹/墨晕的扩散须"水墨晕化"式渐进，忌机械直线运动 |
| 呼吸感 | 笔意呼吸，留白随运镜微微"流动"，气韵生动贯穿全程 |
