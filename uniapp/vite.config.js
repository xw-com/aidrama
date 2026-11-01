import { defineConfig } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';
import legacy from '@vitejs/plugin-legacy';

// 与 client/miniclient 一致：dev 下 /api /files /skills 同源代理到本地服务，
// 业务代码一律用相对路径（见 src/utils/media.js toAbsolute）。
export default defineConfig({
  plugins: [
    uni(),
    // H5 老内核兼容（部署外网后 QQ/UC/360/X5 等双核浏览器常跑 Chromium 61-79 / 更老内核）：
    // - modernTargets：现代包语法下限 = 支持 ES module 的最老内核（Chrome61/Safari11/Firefox60/iOS11），
    //   插件会据此覆写 build.target，esbuild 把 ?./?? 等 es2020 语法转译掉，保住「有 module 但语法老」的内核；
    // - targets：legacy(nomodule) 包用 babel+core-js 转到 SystemJS，盖不支持 module 的更老内核。
    //   下限取 Proxy 普遍可用的版本（Vue3 依赖 Proxy，再往下无解），Chrome49+/Safari10+。
    // - 不开 modernPolyfills：构建产物已核查无 allSettled/randomUUID 等新 API，保持包体。
    // - 构建时必打「modernTargets overrode the builtin targets」警告：插件对显式传
    //   modernTargets 的固定提示（无关闭开关），本配置下限=module 支持首发版本、无实际
    //   覆盖缝隙，属预期内，勿当错误处理。
    // 仅 H5 启用：mp 端 uni 会设 build.lib（main.js 单文件编译），plugin-legacy 检测到直接 throw
    //「does not support library mode」，且小程序不跑浏览器内核，legacy 转译本就无意义。
    ...(process.env.UNI_PLATFORM === 'h5'
      ? [
          legacy({
            // 现代包：有 ES module 的内核就跑这份
            modernTargets: ['chrome >= 61', 'firefox >= 60', 'safari >= 11', 'ios_saf >= 11'],
            // 兼容包：无 module 的内核跑这份（babel 转译 + core-js 垫片）
            targets: ['chrome >= 49', 'firefox >= 51', 'safari >= 10', 'ios_saf >= 10'],
          }),
        ]
      : []),
  ],
  css: {
    preprocessorOptions: {
      scss: {
        // uni-app 把 uni.scss 以 additionalData 形式前置注入每个样式块，
        // 根级 @import 无法改成 @use（@use 必须是首条规则），故压制该废弃告警
        silenceDeprecations: ['import', 'legacy-js-api'],
      },
    },
  },
  server: {
    port: 5175,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/files': { target: 'http://localhost:3000', changeOrigin: true },
      '/skills': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    // target 由 legacy 插件按 modernTargets 接管，勿在此处手设（会被覆写并告警）
    rollupOptions: {
      output: {
        manualChunks(id) {
          /* 仅 H5 支持分包；app 端 IIFE 单包、mp 端按模块拆分，分 vendor 包会直接报 code-splitting 错 */
          if (process.env.UNI_PLATFORM !== 'h5') return undefined;
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('vue-i18n')) return 'i18n-vendor';
          return 'vendor';
        },
      },
    },
  },
});
