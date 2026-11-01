// 浏览器前缀补齐：读取 package.json 的 browserslist。
// 关键产出是 -webkit-backdrop-filter（毛玻璃在 Safari/iOS 18 之前只认带前缀写法），
// 源码里 10 处 backdrop-filter 均未手写前缀，靠这里统一补。
export default {
  plugins: {
    autoprefixer: {},
  },
};
