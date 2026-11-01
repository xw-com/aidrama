<script setup>
/**
 * 新手教程（入口：「我的」页，游客可看）：内容取自 docs/用户手册.md，改写为引导式结构——
 * 顶部一句话定位 + 「三步出片」主流程 + 功能模块手风琴速览 + 「开始创作」行动引导。
 * 无 API 依赖，纯静态展示页。
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useThemeStore } from '../../stores/theme';
import { useAuthStore } from '../../stores/auth';
import { requireLogin } from '../../api';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import AdToast from '../../components/ad-toast/ad-toast.vue';
import { useBackGuard } from '../../composables/useBackGuard';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

// 系统返回键：只回父级一层（utils/back.js PARENT_ROUTES → 我的页）
useBackGuard();

const { t } = useI18n();
const theme = useThemeStore();
const auth = useAuthStore();

// 三步出片主流程（key 对应 tutorial.s{?}t / s{?}d 文案键）
const steps = [1, 2, 3];

// 功能模块速览：icon 为 m-icon 图标名，n 为要点条数（键 tutorial.m.{key}.1..n）
const modules = [
  { key: 'showcase', icon: 'play', n: 3 },
  { key: 'writer', icon: 'clap', n: 3 },
  { key: 'workspace', icon: 'film', n: 3 },
  { key: 'assets', icon: 'spark', n: 4 },
  { key: 'episodes', icon: 'video', n: 4 },
  { key: 'edit', icon: 'cut', n: 3 },
  { key: 'tasks', icon: 'tasks', n: 3 },
  { key: 'credits', icon: 'coin', n: 3 },
  { key: 'more', icon: 'case', n: 3 },
];

const expanded = ref('');
function toggle(key) {
  expanded.value = expanded.value === key ? '' : key;
}

/** 行动引导：未登录先引导登录（登录后回跳本动作目标），已登录直达 AI 编剧 */
function goCreate() {
  const url = '/pages/create/writer';
  if (!auth.isLoggedIn) { requireLogin(url); return; }
  uni.navigateTo({ url });
}
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="t('tutorial.title')" />

    <!-- 一句话定位 -->
    <view class="hero">
      <view class="hero-glow" />
      <text class="hero-t">{{ t('tutorial.heroT') }}</text>
      <text class="hero-d">{{ t('tutorial.heroD') }}</text>
    </view>

    <!-- 三步出片 -->
    <view class="card sec">
      <view class="sec-h">
        <text class="sec-t">{{ t('tutorial.quickT') }}</text>
        <text class="sec-s">{{ t('tutorial.quickS') }}</text>
      </view>
      <view v-for="s in steps" :key="s" class="step" :class="{ last: s === steps.length }">
        <view class="scol">
          <view class="snum"><text class="snum-t">{{ s }}</text></view>
          <view v-if="s !== steps.length" class="sline" />
        </view>
        <view class="sbody">
          <text class="st">{{ t(`tutorial.s${s}t`) }}</text>
          <text class="sd">{{ t(`tutorial.s${s}d`) }}</text>
        </view>
      </view>
    </view>

    <!-- 功能模块速览（手风琴） -->
    <view class="tt-label">{{ t('tutorial.modulesT') }}</view>
    <view class="mods">
      <view v-for="m in modules" :key="m.key" class="card mod" :class="{ open: expanded === m.key }">
        <view class="mod-h" @tap="toggle(m.key)">
          <view class="mi"><m-icon :name="m.icon" :size="18" /></view>
          <text class="mod-t">{{ t(`tutorial.m.${m.key}.t`) }}</text>
          <view class="mod-arr" :class="{ open: expanded === m.key }"><m-icon name="down" :size="14" /></view>
        </view>
        <view v-if="expanded === m.key" class="mod-b">
          <view v-for="n in m.n" :key="n" class="mitem">
            <view class="mdot" />
            <text class="mtxt">{{ t(`tutorial.m.${m.key}.${n}`) }}</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 小贴士 -->
    <view class="card tip">
      <view class="tip-ico"><m-icon name="spark" :size="16" /></view>
      <text class="tip-txt">{{ t('tutorial.tip') }}</text>
    </view>

    <!-- 行动引导 -->
    <view class="cta">
      <view class="mbtn" @tap="goCreate"><m-icon name="clap" :size="17" /><text>{{ t('tutorial.cta') }}</text></view>
      <text class="cta-sub">{{ t('tutorial.ctaSub') }}</text>
    </view>

    <view class="pfoot" />
    <AdToast />
    <AdDialog />
  </view>
</template>

<style scoped>
.hero {
  position: relative;
  margin: 12px 12px 14px;
  padding: 22px 18px 20px;
  border-radius: 18px;
  background: var(--ad-brand-gradient);
  color: var(--ad-brand-contrast);
  overflow: hidden;
}
.hero-glow {
  position: absolute;
  right: -40px;
  top: -50px;
  width: 160px;
  height: 160px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.14);
}
.hero-t {
  display: block;
  font-family: var(--ad-font-serif);
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.06em;
}
.hero-d {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.85;
  max-width: 88%;
}

.sec { padding: 15px 15px 4px; }
.sec-h { display: flex; align-items: baseline; gap: 8px; margin-bottom: 14px; }
.sec-t { font-size: 15px; font-weight: 800; color: var(--ad-text); }
.sec-s { flex: 1; font-size: 10.5px; color: var(--ad-text-mut); text-align: right; }

.step { display: flex; gap: 12px; padding-bottom: 16px; }
.step.last { padding-bottom: 12px; }
.scol { display: flex; flex-direction: column; align-items: center; flex: none; }
.snum {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--ad-brand-soft);
  border: 1px solid var(--ad-brand);
  color: var(--ad-brand);
  display: flex;
  align-items: center;
  justify-content: center;
}
.snum-t { font-size: 13px; font-weight: 800; }
.sline { flex: 1; width: 1px; margin-top: 4px; background: var(--ad-line-strong); }
.sbody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding-top: 3px; }
.st { font-size: 14px; font-weight: 700; color: var(--ad-text); }
.sd { font-size: 12px; line-height: 1.65; color: var(--ad-text-mut); }

.tt-label {
  margin: 4px 24px 10px;
  font-size: 10.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ad-text-mut);
}
.mods { margin: 0 12px; display: flex; flex-direction: column; gap: 10px; }
.mod { margin: 0; }
.mod.open { border-color: var(--ad-brand); }
.mod-h { display: flex; align-items: center; gap: 12px; padding: 12px 14px; }
.mod-h:active { background: var(--ad-inset); }
.mod-t { flex: 1; font-size: 14px; font-weight: 700; color: var(--ad-text); }
.mod-arr { color: var(--ad-text-mut); transition: transform 0.2s ease; }
.mod-arr.open { transform: rotate(180deg); color: var(--ad-brand); }
.mod-b { padding: 2px 14px 12px 60px; display: flex; flex-direction: column; gap: 8px; }
.mitem { display: flex; gap: 9px; align-items: flex-start; }
.mdot { flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--ad-brand); margin-top: 7px; opacity: 0.75; }
.mtxt { font-size: 12.5px; line-height: 1.65; color: var(--ad-text-soft); }

.tip { margin-top: 4px; padding: 12px 14px; display: flex; gap: 10px; align-items: flex-start; }
.tip-ico {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: var(--ad-brand-soft);
  color: var(--ad-brand);
  display: flex;
  align-items: center;
  justify-content: center;
}
.tip-txt { flex: 1; font-size: 12px; line-height: 1.65; color: var(--ad-text-soft); }

.cta { margin: 16px 18px 0; display: flex; flex-direction: column; align-items: center; gap: 9px; }
.cta .mbtn { width: 100%; height: 46px; }
.cta-sub { font-size: 11px; color: var(--ad-text-mut); }
.pfoot { padding-bottom: 20px; }
</style>
