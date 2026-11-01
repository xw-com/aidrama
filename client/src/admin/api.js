import http from '../api/http';

// 管理台专属接口（登录在持令牌之前发出：_silent 不弹全局错误、_noBail 不触发会话兜底，
// 失败由登录页自行渲染错误文案）
export const adminAuthApi = {
  login: (data) => http.post('/admin/auth/login', data, { _silent: true, _noBail: true }),
};
