// 包装异步控制器，自动把异常交给错误处理中间件
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
