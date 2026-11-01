<script setup>
/**
 * 站点页脚条：版权 + 《用户协议》《隐私政策》链接 + ICP 备案号。
 * 备案号从 VITE_ICP_NO 读取（构建期注入），留空/未配置则整段不显示。
 * 展示中心底部与登录页底部共用。
 */
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const icp = String(import.meta.env.VITE_ICP_NO || '').trim();
</script>

<template>
  <footer class="sf-bar">
    <span class="sf-copy">{{ t('footer.copyright') }}</span>
    <nav class="sf-links">
      <router-link to="/terms">{{ t('legal.docTerms') }}</router-link>
      <span class="sf-dot">·</span>
      <router-link to="/privacy">{{ t('legal.docPrivacy') }}</router-link>
    </nav>
    <span v-if="icp" class="sf-icp">{{ icp }}</span>
  </footer>
</template>

<style scoped>
.sf-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 18px;
  padding: 16px 0 4px;
  margin-top: 28px;
  border-top: 1px solid var(--ad-border);
  font-size: 12px;
  color: var(--ad-text-muted);
}
.sf-links { display: inline-flex; align-items: center; gap: 10px; }
.sf-links a {
  color: var(--ad-text-soft);
  text-decoration: none;
  font-weight: 600;
  transition: color 0.15s;
}
.sf-links a:hover { color: var(--ad-brand); }
.sf-dot { color: var(--ad-text-muted); }
.sf-icp { font-variant-numeric: tabular-nums; }

@media (max-width: 768px) {
  .sf-bar { flex-direction: column; justify-content: center; text-align: center; }
}
</style>
