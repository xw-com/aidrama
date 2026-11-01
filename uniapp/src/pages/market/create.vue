<script setup>
/**
 * 发布任务单独立页（原接单中心「发布任务单」AdSheet 迁出，参照 pages/workspace/char-create 页面模式）：
 * 标题 + 需求 + 时长/单价 + 分辨率/画幅 chips + 总价与余额校验，
 * 提交成功后 uni.$emit('market:reload') 通知列表页重拉，再返回列表页。
 */
import { ref, computed, nextTick } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { marketApi } from '../../api';
import { useAuthStore } from '../../stores/auth';
import { useThemeStore } from '../../stores/theme';
import { formatCredits } from '../../utils/format';
import { toast, toastError } from '../../utils/ui';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const auth = useAuthStore();
const theme = useThemeStore();

const creating = ref(false);
const RESOLUTIONS = ['720p', '1080p', '4k'];
const ASPECTS = ['', '16:9', '9:16', '1:1'];
const form = ref({
  title: '', requirement: '',
  duration_seconds: '', price_per_second: '',
  resolution: '1080p', aspect_ratio: '',
});

const totalPrice = computed(() =>
  Math.max(0, (parseInt(form.value.duration_seconds, 10) || 0) * (Math.round((Number(form.value.price_per_second) || 0) * 10) / 10)));
const insufficient = computed(() => totalPrice.value > (auth.credits ?? 0));

onLoad(() => {
  // 余额异步刷新（总价/余额对比用）
  auth.refreshCredits();
  // App/小程序 input 吃不到挂载帧初始值：先空挂载一帧，nextTick 后回填默认值
  nextTick(() => {
    form.value.duration_seconds = 60;
    form.value.price_per_second = 1;
  });
});

async function submitCreate() {
  if (!form.value.title.trim() || !form.value.requirement.trim()) {
    toast(t('market.form.required'));
    return;
  }
  if (creating.value) return;
  creating.value = true;
  try {
    await marketApi.create({ ...form.value, aspect_ratio: form.value.aspect_ratio || undefined });
    auth.refreshCredits();
    toast(t('market.createdToast'), 'success');
    uni.$emit('market:reload'); // 通知列表页重拉
    uni.navigateBack();
  } catch (e) {
    toastError(e); // 402 积分不足由 http 层统一引导充值
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="t('market.newOrder')" />

    <view class="mc-body">
      <view class="ad-field">
        <view class="ad-field-label">{{ t('market.form.title') }}</view>
        <input v-model="form.title" class="ad-input" :placeholder="t('market.form.titlePlaceholder')" placeholder-class="ad-ph" :maxlength="60">
      </view>
      <view class="ad-field">
        <view class="ad-field-label">{{ t('market.form.requirement') }}</view>
        <textarea v-model="form.requirement" class="ad-textarea" :maxlength="2000" :placeholder="t('market.form.requirementPlaceholder')" placeholder-class="ad-ph" />
      </view>
      <view class="mc-row">
        <view class="ad-field mc-half">
          <view class="ad-field-label">{{ t('market.form.duration') }}</view>
          <input v-model="form.duration_seconds" type="number" class="ad-input" :placeholder="'60'" placeholder-class="ad-ph">
        </view>
        <view class="ad-field mc-half">
          <view class="ad-field-label">{{ t('market.form.pricePerSecond') }}</view>
          <input v-model="form.price_per_second" type="number" class="ad-input" :placeholder="'1'" placeholder-class="ad-ph">
        </view>
      </view>
      <view class="ad-field">
        <view class="ad-field-label">{{ t('market.form.resolution') }}</view>
        <view class="mc-chips">
          <text v-for="r in RESOLUTIONS" :key="r" class="pchip" :class="{ on: form.resolution === r }" @tap="form.resolution = r">{{ r }}</text>
        </view>
      </view>
      <view class="ad-field">
        <view class="ad-field-label">{{ t('market.form.aspect') }}</view>
        <view class="mc-chips">
          <text v-for="a in ASPECTS" :key="a || 'any'" class="pchip" :class="{ on: form.aspect_ratio === a }" @tap="form.aspect_ratio = a">
            {{ a || t('market.form.noLimit') }}
          </text>
        </view>
      </view>
      <view class="mc-total">
        <text>{{ t('market.totalPrice', { n: formatCredits(totalPrice) }) }}</text>
        <text class="mc-balance">{{ t('credits.balance') }} {{ formatCredits(auth.credits ?? 0) }}</text>
      </view>
      <view v-if="insufficient" class="mc-warn">{{ t('market.form.insufficient') }}</view>
    </view>

    <!-- 底部提交条 -->
    <view class="mc-foot">
      <view class="mbtn" :class="{ dis: creating || insufficient }" @tap="!creating && !insufficient && submitCreate()">
        {{ creating ? t('common.loading') : t('market.form.submit') }}
      </view>
    </view>

    <AdDialog />
  </view>
</template>

<style scoped>
.mc-body { padding: 12px 18px 110px; }
.mc-row { display: flex; gap: 10px; }
.mc-half { flex: 1; }
.mc-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.mc-total { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-radius: 14px; background: var(--ad-inset); border: 1px solid var(--ad-line); font-size: 13px; color: var(--ad-text); }
.mc-balance { font-size: 12px; color: var(--ad-text-mut); }
.mc-warn { margin-top: 8px; font-size: 12px; color: var(--ad-danger); }
.mc-foot { position: fixed; left: 0; right: 0; bottom: 0; z-index: 80; padding: 12px 18px calc(12px + env(safe-area-inset-bottom)); background: var(--ad-ink); }
.mc-foot .mbtn { height: 44px; border-radius: 13px; display: flex; align-items: center; justify-content: center; }
</style>
