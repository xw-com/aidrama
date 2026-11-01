<script setup>
/**
 * 法务文档通用渲染（用户协议 / 隐私政策共用）：
 * 文案按 legal.<doc>.sN.title / legal.<doc>.sN.itemM 结构化存放（全部叶子键），
 * 这里按序号扫描渲染——增删条款只改 locales，组件零改动。
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  // 'terms' | 'privacy'
  doc: { type: String, required: true },
});

const { t, te } = useI18n();

const MAX_SECTIONS = 40;
const MAX_ITEMS = 20;

const sections = computed(() => {
  const out = [];
  for (let i = 1; i <= MAX_SECTIONS; i++) {
    const base = `legal.${props.doc}.s${i}`;
    if (!te(`${base}.title`)) break;
    const items = [];
    for (let j = 1; j <= MAX_ITEMS; j++) {
      if (!te(`${base}.item${j}`)) break;
      items.push(t(`${base}.item${j}`));
    }
    out.push({ title: t(`${base}.title`), items });
  }
  return out;
});

const otherDoc = computed(() => (props.doc === 'terms' ? 'privacy' : 'terms'));
const otherLabel = computed(() => t(otherDoc.value === 'terms' ? 'legal.docTerms' : 'legal.docPrivacy'));
</script>

<template>
  <div class="ad-page legal-page">
    <div class="legal-container">
      <header class="legal-head">
        <div class="legal-brand">XW.COM · AI DRAMA</div>
        <h1 class="legal-title">{{ t(`legal.${doc}.title`) }}</h1>
        <div class="legal-updated">{{ t('legal.updatedAt') }}</div>
      </header>

      <section v-for="(s, i) in sections" :key="i" class="legal-section">
        <h2 class="legal-section-title">{{ i + 1 }}. {{ s.title }}</h2>
        <ol class="legal-items">
          <li v-for="(item, j) in s.items" :key="j">{{ item }}</li>
        </ol>
      </section>

      <footer class="legal-foot">
        <router-link :to="`/${otherDoc}`" class="legal-link">{{ otherLabel }}</router-link>
        <span class="legal-dot">·</span>
        <router-link to="/showcase" class="legal-link">{{ t('legal.back') }}</router-link>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 电影工作室风：影棚黑 + 衬线标题 + 描金细节（全部走 --ad-* 令牌，深浅主题自适应） */
.legal-page { min-height: 100vh; }
.legal-container {
  max-width: 860px;
  margin: 0 auto;
  padding: 48px 24px 40px;
}
.legal-head { text-align: center; margin-bottom: 24px; }
.legal-brand {
  font-size: 12px;
  letter-spacing: 2.5px;
  color: var(--ad-text-muted);
  margin-bottom: 14px;
}
.legal-title {
  font-family: var(--ad-font-display);
  font-size: 30px;
  font-weight: 800;
  color: var(--ad-text-strong);
  margin: 0 0 10px;
  letter-spacing: 0.02em;
}
.legal-updated { font-size: 12px; color: var(--ad-text-muted); }
.legal-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--ad-radius-sm);
  background: var(--ad-brand-soft);
  border: 1px solid var(--ad-border);
  color: var(--ad-brand);
  font-size: var(--ad-fz-sm);
  line-height: 1.6;
  margin-bottom: 32px;
}
.legal-notice-icon { flex: none; margin-top: 2px; }
.legal-section { margin-bottom: 26px; }
.legal-section-title {
  font-family: var(--ad-font-display);
  font-size: 17px;
  font-weight: 700;
  color: var(--ad-text-strong);
  margin: 0 0 10px;
  padding-left: 10px;
  border-left: 3px solid var(--ad-brand);
  line-height: 1.4;
}
.legal-items {
  margin: 0;
  padding-left: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.legal-items li {
  font-size: var(--ad-fz-md);
  color: var(--ad-text-soft);
  line-height: 1.75;
}
.legal-foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 40px;
  padding-top: 20px;
  border-top: 1px solid var(--ad-border);
}
.legal-link {
  color: var(--ad-brand);
  font-weight: 600;
  font-size: var(--ad-fz-sm);
  text-decoration: none;
}
.legal-link:hover { text-decoration: underline; }
.legal-dot { color: var(--ad-text-muted); }

@media (max-width: 768px) {
  .legal-container { padding: 32px 16px 32px; }
  .legal-title { font-size: 24px; }
}
</style>
