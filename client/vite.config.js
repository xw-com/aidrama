import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import legacy from '@vitejs/plugin-legacy';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';

// 管理后台深链回退中间件：/admin 与 /admin/*（无扩展名的路径）统一回 admin.html，
// 由 admin router（base /admin/）接管；dev 与 vite preview 共用。
// 生产环境由 nginx 的 location /admin 块承担同一行为（deploy/nginx.conf）。
// 管理后台深链回退中间件：/admin 与 /admin/*（无扩展名的路径）统一回 admin.html，
// 由 admin router（base /admin/）接管；dev 与 vite preview 共用。
// 生产环境由 nginx 的 location /admin 块承担同一行为（deploy/nginx.conf）。
function adminSpaFallback() {
  return (req, res, next) => {
    const p = (req.url || '').split('?')[0];
    if (p === '/admin') {
      res.statusCode = 302;
      res.setHeader('Location', '/admin/');
      return res.end();
    }
    if (p.startsWith('/admin/') && !/\.[\w]+$/.test(p)) req.url = '/admin.html';
    next();
  };
}

// configureServer/configurePreviewServer 是插件钩子而非 server 配置项，
// 直接写在 server:{} 里会被静默忽略——必须包成插件挂进 plugins
function adminSpaFallbackPlugin() {
  return {
    name: 'admin-spa-fallback',
    configureServer(s) {
      s.middlewares.use(adminSpaFallback());
    },
    configurePreviewServer(s) {
      s.middlewares.use(adminSpaFallback());
    },
  };
}

export default defineConfig({
  plugins: [
    vue(),
    // 双构建：现代浏览器吃 es2020 主包（与不开 legacy 时完全一致），老浏览器经
    // <script nomodule> 走 SystemJS + core-js 的 ES5 legacy 包。legacy 目标来自
    // package.json 的 browserslist（底线=Vue3 的 Proxy 与 ResizeObserver 都原生
    // 可用的最老一代），对现代用户零额外下载（nomodule 会被直接忽略）。
    legacy(),
    adminSpaFallbackPlugin(),
    AutoImport({ resolvers: [ElementPlusResolver()] }),
    Components({ resolvers: [ElementPlusResolver()] }),
  ],
  build: {
    rollupOptions: {
      // 双入口 MPA：前台 index.html + 管理后台 admin.html（独立 router/布局/会话），
      // 共享业务组件与 vendor chunk（rollup 跨入口自动去重）
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
      output: {
        // 用函数形式而非对象形式：对象形式会把 element-plus 桶模块整体强制拉进依赖图。
        // element-plus 也不做任何分组——实测哪怕函数形式分组都会保留未用组件（多 ~284KB 死码），
        // 让它随用到的页面自然分片；vue 全家桶全量使用、无 shaking 损失，单独成 vendor 包
        // 可在业务迭代时长期命中浏览器缓存。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('element-plus') || id.includes('@element-plus')) return undefined;
          return 'vendor';
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/files': { target: 'http://localhost:3000', changeOrigin: true },
      '/skills': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
