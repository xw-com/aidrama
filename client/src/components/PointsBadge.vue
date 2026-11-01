<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import { useRouter } from 'vue-router';

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();
const credits = computed(() => (auth.credits ?? 0));
const tip = computed(() => t('points.balanceTip'));
</script>

<template>
  <div class="points-badge" @click="router.push('/credits')" :title="tip">
    <el-icon><GoldMedal /></el-icon>
    <span class="num tnum">{{ credits.toLocaleString() }}</span>
    <span class="unit">{{ t('common.credits') }}</span>
    <!-- 纯视觉充值角标（无独立点击语义）：跳转统一走外层徽章点击 -->
    <span class="recharge-btn" aria-hidden="true">
      <el-icon><Plus /></el-icon>
    </span>
  </div>
</template>

<style scoped>
.points-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 12px;
  border-radius: 999px;
  background: var(--ad-bg-soft);
  border: 1px solid var(--ad-border);
  cursor: pointer;
  color: var(--ad-text);
  font-weight: 600;
}
.points-badge .el-icon { color: var(--ad-brand); }
.points-badge .num { color: var(--ad-brand); font-size: 15px; }
.points-badge .unit { color: var(--ad-text-soft); font-size: 12px; font-weight: 500; margin-right: 4px; }
.recharge-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--ad-brand-soft);
  color: var(--ad-brand);
  font-size: 12px;
}

/* 窄屏顶栏压缩：只留图标 + 数字（充值入口走点击积分徽章本身） */
@media (max-width: 640px) {
  .points-badge { padding: 4px 10px; gap: 4px; }
  .points-badge .unit,
  .recharge-btn { display: none; }
}
</style>
