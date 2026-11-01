<script setup>
/**
 * 协议页：《用户协议》/《隐私政策》正文（结构化段落渲染，影棚黑 + 描金风格）。
 * - ?type=privacy|terms 选初始页签（缺省 terms），页内可互切；
 * - ?gate=1 门禁模式（仅 App 首启弹窗经 redirectTo 进入）：无返回键、不渲染返回箭头，
 *   底部固定操作条只给「同意并继续」（写隐私同意态 → agreePrivacy 放行挂起请求 →
 *   reLaunch 首页续起初始化）与「不同意并退出」（plus.runtime.quit）两条出路；
 * - 文案键族 agreement.*；正文为通用合法模板，正式上线前以法务定稿为准（placeholderNote）。
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { onLoad } from '@dcloudio/uni-app';
import { useThemeStore } from '../../stores/theme';
import { agreePrivacy } from '../../utils/privacy';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';

const { t } = useI18n();
const theme = useThemeStore();

// 段落顺序（键：agreement.terms.<k>Title/<k>Body）
const TERMS_SECTIONS = ['service', 'account', 'credits', 'content', 'conduct', 'liability', 'changes'];
// 段落顺序（键：agreement.privacy.<k>Title/<k>Body）
const PRIVACY_SECTIONS = ['collect', 'use', 'storage', 'thirdParty', 'rights', 'minors', 'changes'];

const tab = ref('terms');
const gate = ref(false);

onLoad((q) => {
  if (q && q.type === 'privacy') tab.value = 'privacy';
  gate.value = !!(q && q.gate);
});

function pickTab(key) {
  tab.value = key;
}

/** 门禁模式「同意并继续」：落盘同意态（同时放行 http 层挂起的全部请求）→ 重开首页 */
function onAgree() {
  agreePrivacy();
  /* #ifdef APP-PLUS */
  // 门禁模式经 redirectTo 进入（启动页已被换掉），reLaunch 首页续起启动初始化
  uni.reLaunch({ url: '/pages/showcase/index' });
  /* #endif */
}

/** 门禁模式「不同意并退出」 */
function onRefuse() {
  /* #ifdef APP-PLUS */
  plus.runtime.quit();
  /* #endif */
}
</script>

<template>
  <view class="agr-page" :class="theme.rootCls">
    <AdNavbar :title="tab === 'terms' ? t('agreement.termsTitle') : t('agreement.privacyTitle')" :back="!gate" />

    <scroll-view class="agr-scroll" scroll-y :class="{ gate }">
      <view class="agr-tabs">
        <view class="agr-tab" :class="{ on: tab === 'terms' }" @tap="pickTab('terms')">
          <text>{{ t('agreement.termsTitle') }}</text>
        </view>
        <view class="agr-tab" :class="{ on: tab === 'privacy' }" @tap="pickTab('privacy')">
          <text>{{ t('agreement.privacyTitle') }}</text>
        </view>
      </view>
      <text class="agr-date">{{ t('agreement.effectiveDate') }}</text>

      <template v-if="tab === 'terms'">
        <text class="agr-p">{{ t('agreement.terms.intro') }}</text>
        <view v-for="s in TERMS_SECTIONS" :key="s" class="agr-sec">
          <text class="agr-h">{{ t('agreement.terms.' + s + 'Title') }}</text>
          <text class="agr-p">{{ t('agreement.terms.' + s + 'Body') }}</text>
        </view>
      </template>
      <template v-else>
        <text class="agr-p">{{ t('agreement.privacy.intro') }}</text>
        <view v-for="s in PRIVACY_SECTIONS" :key="s" class="agr-sec">
          <text class="agr-h">{{ t('agreement.privacy.' + s + 'Title') }}</text>
          <text class="agr-p">{{ t('agreement.privacy.' + s + 'Body') }}</text>
        </view>
      </template>

      <view class="agr-note">
        <text>{{ t('agreement.placeholderNote') }}</text>
      </view>
      <view class="agr-footpad" :class="{ gate }" />
    </scroll-view>

    <!-- 门禁模式底部操作条：同意 / 退出，无第三条路（仅 App 端可达门禁模式） -->
    <!-- #ifdef APP-PLUS -->
    <view v-if="gate" class="agr-gatebar">
      <view class="mbtn agr-agree" @tap="onAgree">
        <text>{{ t('agreement.agreeBtn') }}</text>
      </view>
      <text class="agr-refuse" @tap="onRefuse">{{ t('agreement.disagreeQuit') }}</text>
    </view>
    <!-- #endif -->
  </view>
</template>

<style scoped>
.agr-page {
  height: 100vh; display: flex; flex-direction: column;
  background: var(--ad-ink);
}
.agr-scroll { flex: 1; min-height: 0; padding: 16px 22px 0; box-sizing: border-box; }

/* 页签：terms / privacy 互切 */
.agr-tabs {
  display: flex; gap: 8px; margin-bottom: 10px;
}
.agr-tab {
  flex: 1; height: 40px; display: flex; align-items: center; justify-content: center;
  border-radius: 11px; font-size: 14px; font-weight: 600;
  background: var(--ad-inset, #0d0d14); border: 1px solid var(--ad-line);
  color: var(--ad-text-soft);
}
.agr-tab.on {
  background: var(--ad-brand-soft, rgba(224, 182, 78, 0.13));
  border-color: rgba(224, 182, 78, 0.35);
  color: var(--ad-brand, #e0b64e);
}

.agr-date { display: block; font-size: 11px; color: var(--ad-text-mut); margin-bottom: 14px; }
.agr-sec { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; }
.agr-h {
  font-family: var(--ad-serif); font-size: 15px; font-weight: 700;
  color: var(--ad-brand, #e0b64e);
}
.agr-p { display: block; font-size: 13px; line-height: 1.8; color: var(--ad-text-soft); }

/* 「以法务定稿为准」占位提示框 */
.agr-note {
  margin-top: 20px; padding: 12px 14px; border-radius: 12px;
  border: 1px dashed rgba(224, 182, 78, 0.4); background: var(--ad-inset, #0d0d14);
  font-size: 12px; line-height: 1.7; color: var(--ad-text-mut);
}
.agr-footpad { height: 30px; }
.agr-footpad.gate { height: 120px; } /* 给底部操作条让位 */

/* 门禁操作条：固定底部 + 安全区 */
.agr-gatebar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 95;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 14px 26px calc(14px + env(safe-area-inset-bottom));
  background: var(--ad-nav-bg); border-top: 1px solid var(--ad-line);
}
.agr-agree { width: 100%; height: 48px; border-radius: 13px; font-size: 15px; font-weight: 700; }
.agr-refuse { font-size: 13px; color: var(--ad-text-mut); }
</style>
