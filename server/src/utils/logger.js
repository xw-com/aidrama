// 极简日志器
const fmt = () => new Date().toISOString();

// API Key 脱敏：仅保留首 4 / 末 4，便于辨认配置是否生效而不泄露密钥
export const maskKey = (k) => {
  const s = String(k || '');
  if (!s) return '-';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
};

export const logger = {
  info: (...args) => console.log(`[${fmt()}] [INFO]`, ...args),
  warn: (...args) => console.warn(`[${fmt()}] [WARN]`, ...args),
  error: (...args) => console.error(`[${fmt()}] [ERROR]`, ...args),
  debug: (...args) => {
    if (process.env.NODE_ENV !== 'production') console.log(`[${fmt()}] [DEBUG]`, ...args);
  },
};

export default logger;
