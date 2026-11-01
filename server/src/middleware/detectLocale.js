import { resolveLocale } from '../i18n/index.js';

// 解析 Accept-Language，挂到 req.locale 与 res.locals.locale，供响应/错误翻译使用
export const detectLocale = (req, res, next) => {
  const locale = resolveLocale(req.headers['accept-language']);
  req.locale = locale;
  res.locals = res.locals || {};
  res.locals.locale = locale;
  next();
};

export default detectLocale;
