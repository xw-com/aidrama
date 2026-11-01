// 点选文字验证码：出题 / 校验 / 一次性消费
// 内存态存储（同 maintenance.service 范式，重启即清，无需建表）；
// 图片由后端拼 SVG（dataURL）下发、浏览器端字体渲染——不依赖服务器 CJK 字体。
// 通过后签发短期 JWT ticket，前端随登录/注册请求体透传给服务端（captcha_ticket），
// 默认复用 JWT_SECRET 签发，服务端 verifyTicket 验签消费。
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { badRequest } from '../utils/index.js';

// 画布（viewBox 坐标系，点击坐标与之比对）
const WIDTH = 320;
const HEIGHT = 180;
const TARGET_COUNT = 3;  // 需按顺序点击的字数
const GLYPH_COUNT = 8;   // 图内总字数（其余为干扰字）
const MIN_GAP = 52;      // 字与字最小间距，避免重叠误点
// 浏览器端渲染字体栈：覆盖 macOS / Windows / Linux 常见 CJK 字体
const FONT_FAMILY = `"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif`;

// 汉字池：高频常用字、笔画结构差异明显；Set 去重
const CJK_POOL = [...new Set('天空云电山水火田石日月星辰风雨雪霜露冰江河湖海洋波浪涛泉溪岸岛屿道路桥梁车舟帆马鞍牛羊鸟鱼虫猫狗龙凤虎鹿兔蛇猴鸡鸭鹅春夏秋冬东南西北中前后左右上下内外黑白红黄蓝绿紫金银铜铁沙尘烟雾门窗屋顶楼台亭阁塔城墙街巷宫殿堂园灯烛琴棋书画诗酒茶饭米面果蔬花草树木森林竹叶枝根芽伞扇镜床桌椅箱柜衣裳鞋帽布线绳网袋瓶碗锅壶杯盘筷勺叉'.split(''))];
// 字母数字池：去掉易混淆的 I / O / 0 / 1
const LATIN_POOL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.split('');

// locale → 字符池：CJK 语境用汉字，其余用字母数字（点选本质是图形匹配，不依赖识读能力）
function poolForLocale(locale) {
  return locale === 'zh-CN' || locale === 'zh-TW' || locale === 'ja' ? CJK_POOL : LATIN_POOL;
}

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));

// 从池中不重复抽取 n 个字符
function sampleChars(pool, n) {
  const arr = [...pool];
  const out = [];
  for (let i = 0; i < n && arr.length; i++) {
    out.push(arr.splice(Math.floor(Math.random() * arr.length), 1)[0]);
  }
  return out;
}

// 摆放 n 个字：随机位置/字号/旋转/颜色，保证彼此间距与出界边距
function placeGlyphs(n) {
  const placed = [];
  for (let i = 0; i < n; i++) {
    let cand = null;
    for (let tries = 0; tries < 60; tries++) {
      const size = randInt(26, 34);
      cand = {
        x: rand(size, WIDTH - size),
        y: rand(size * 0.7 + 6, HEIGHT - size * 0.7 - 6),
        size,
        rotate: rand(-35, 35),
        color: `hsl(${randInt(0, 360)}, ${randInt(42, 72)}%, ${randInt(28, 44)}%)`,
      };
      if (placed.every((q) => Math.hypot(q.x - cand.x, q.y - cand.y) > MIN_GAP)) break;
    }
    placed.push(cand); // 60 次仍未满足间距时兜底接受（该密度下概率极低）
  }
  return placed;
}

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// 拼验证码 SVG：浅色渐变底 + 噪点/噪线 + 旋转彩字
function buildSvg(glyphs) {
  const dots = Array.from({ length: 46 }, () =>
    `<circle cx="${rand(0, WIDTH).toFixed(1)}" cy="${rand(0, HEIGHT).toFixed(1)}" r="${rand(0.8, 2).toFixed(1)}" fill="#64748b" opacity="${rand(0.15, 0.35).toFixed(2)}"/>`).join('');
  const lines = Array.from({ length: 4 }, () => {
    const pts = Array.from({ length: 3 }, () => `${rand(0, WIDTH).toFixed(1)},${rand(0, HEIGHT).toFixed(1)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="#64748b" stroke-width="${rand(0.8, 1.6).toFixed(1)}" opacity="${rand(0.12, 0.25).toFixed(2)}"/>`;
  }).join('');
  const texts = glyphs.map((g) =>
    `<text x="${g.x.toFixed(1)}" y="${g.y.toFixed(1)}" font-size="${g.size}" font-family='${FONT_FAMILY}' font-weight="600" fill="${g.color}" text-anchor="middle" dominant-baseline="central" transform="rotate(${g.rotate.toFixed(1)} ${g.x.toFixed(1)} ${g.y.toFixed(1)})">${escapeXml(g.ch)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`
    + '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f8fafc"/><stop offset="1" stop-color="#e2e8f0"/></linearGradient></defs>'
    + `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>${dots}${lines}${texts}</svg>`;
}

// 内存题库：id → { answer(按点击顺序的中心点), expiresAt, attempts }
const store = new Map();

// 清扫过期题（惰性触发，无定时器）
function sweep(now = Date.now()) {
  for (const [id, e] of store) {
    if (e.expiresAt <= now) store.delete(id);
  }
}

// 出题：返回给前端的题目（含 SVG dataURL 与提示字）
export function createChallenge(locale) {
  const chars = sampleChars(poolForLocale(locale), GLYPH_COUNT);
  const metas = placeGlyphs(GLYPH_COUNT);
  const glyphs = chars.map((ch, i) => ({ ...metas[i], ch }));
  // 前 N 个字为答案（提示栏按此顺序展示），其余为干扰字；绘制顺序打乱，
  // 避免「SVG 里前几个 text 元素即答案」这类可编程捷径
  const answer = glyphs.slice(0, TARGET_COUNT).map((g) => ({ x: g.x, y: g.y }));
  const tipChars = glyphs.slice(0, TARGET_COUNT).map((g) => g.ch);
  const drawOrder = [...glyphs].sort(() => Math.random() - 0.5);
  const svg = buildSvg(drawOrder);

  sweep();
  const id = crypto.randomUUID();
  store.set(id, { answer, expiresAt: Date.now() + config.captcha.ttlMs, attempts: 0 });
  // 上限保护：超限删最旧（Map 按插入序），防无脑刷题撑爆内存
  if (store.size > config.captcha.maxStore) {
    for (const k of store.keys()) {
      store.delete(k);
      if (store.size <= config.captcha.maxStore) break;
    }
  }
  return {
    id,
    image: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    tipChars,
    width: WIDTH,
    height: HEIGHT,
    expiresIn: Math.round(config.captcha.ttlMs / 1000),
  };
}

// 校验：逐点按顺序比对点击点与答案中心的欧氏距离；通过即作废该题（一次性消费）并签发 ticket
export function verifyChallenge(id, points) {
  const now = Date.now();
  const entry = store.get(id);
  if (!entry || entry.expiresAt <= now) {
    if (entry) store.delete(id);
    throw badRequest('captcha.expired');
  }
  const validPoints = Array.isArray(points) && points.length === entry.answer.length
    && points.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)
      && p.x >= -40 && p.x <= WIDTH + 40 && p.y >= -40 && p.y <= HEIGHT + 40);
  if (!validPoints) throw badRequest('captcha.points_invalid');

  entry.attempts += 1;
  const passed = entry.answer.every((a, i) => Math.hypot(a.x - points[i].x, a.y - points[i].y) <= config.captcha.tolerance);
  if (!passed) {
    if (entry.attempts >= config.captcha.maxAttempts) store.delete(id);
    throw badRequest('captcha.failed');
  }

  store.delete(id);
  const ticket = jwt.sign(
    { typ: 'captcha', jti: id },
    config.captcha.ticketSecret,
    { expiresIn: config.captcha.ticketExpiresIn },
  );
  return { ticket };
}

// 服务端消费 verifyChallenge 签发的 ticket（短期 JWT，到期即失效；题目本身已一次性消费）。
// 供本服务端敏感接口使用（如管理台登录）：签名/类型/有效期任一不过即 400
export function verifyTicket(ticket) {
  try {
    const payload = jwt.verify(String(ticket || ''), config.captcha.ticketSecret);
    if (payload?.typ !== 'captcha') throw new Error('bad typ');
    return payload;
  } catch (e) {
    throw badRequest(e?.name === 'TokenExpiredError' ? 'captcha.expired' : 'captcha.invalid_ticket');
  }
}
