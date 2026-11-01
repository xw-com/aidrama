<script setup>
/**
 * 主题化弹层宿主：utils/ui.js 的 confirm / promptInput / actionSheet 优先路由到这里，
 * 用 AdSheet（--ad-* 令牌）渲染，替代不适配主题的 uni 原生弹窗。
 * 需在页面根 view（theme.rootCls 所在）内挂一次 <AdDialog />；未挂载时 utils 回退原生。
 */
import { computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import AdSheet from '../ad-sheet/ad-sheet.vue';
import AdToast from '../ad-toast/ad-toast.vue';
import { useDialogStore } from '../../stores/dialog';
import { toast } from '../../utils/ui';

const { t } = useI18n();
const dlg = useDialogStore();
const show = computed({
  get: () => dlg.show,
  set: (v) => { if (!v) dlg.cancel(); },
});
// hostCount 是全局计数：mount/unmount 严格配对增减。不能用布尔——从本页返回下层
// 宿主页（keep-alive 不重走 onMounted）时，本页卸载若把布尔复位，幸存页就会误回退
// uni 原生弹窗；计数下卸载只减 1，幸存页仍 >0 继续走主题化弹层
onMounted(() => { dlg.hostCount++; });
onUnmounted(() => { dlg.hostCount--; });

function pick(it) {
  dlg.settle(it.key);
}
function onOk() {
  if (dlg.mode === 'prompt' && dlg.required && !dlg.input.trim()) {
    toast(t('common.required'), { icon: 'none' });
    return; // 必填为空不开走，停留在弹层
  }
  dlg.settle(dlg.mode === 'prompt' ? dlg.input.trim() : true);
}
</script>

<template>
  <AdSheet v-model:show="show" :title="dlg.title" :top="dlg.top">
    <view class="adlg">
      <text v-if="dlg.content" class="adlg-content">{{ dlg.content }}</text>
      <input
        v-if="dlg.mode === 'prompt'"
        v-model="dlg.input"
        class="adlg-input"
        :placeholder="dlg.placeholder"
        :focus="dlg.show"
      />
      <!-- 动作菜单：整行按钮 + 底部取消（on 为当前项，selectSheet 单选高亮；icon 为行首图标；
           private 为私有模型项，青色与公用行的金色选中区分） -->
      <template v-if="dlg.mode === 'sheet'">
        <view
          v-for="it in dlg.items"
          :key="it.key"
          class="adlg-item"
          :class="{ danger: it.danger, on: it.on, 'has-icon': !!it.icon, private: it.private }"
          @tap="pick(it)"
        >
          <view v-if="it.icon" class="adlg-item-i">
            <m-icon :name="it.icon" :size="16" />
          </view>
          <text class="adlg-item-t">{{ it.label }}</text>
          <!-- 私有行不传 color：对勾走 currentColor 继承行色，随主题令牌走 -->
          <m-icon v-if="it.on" name="check" :size="13" :color="it.private ? '' : '#e0b64e'" :sw="3" />
        </view>
        <view class="mbtn ghost adlg-cancel" @tap="dlg.cancel()">
          <text>{{ dlg.cancelText || t('common.cancel') }}</text>
        </view>
      </template>
      <!-- 确认 / 输入：双按钮行 -->
      <view v-else class="adlg-btns">
        <view class="mbtn ghost adlg-btn" @tap="dlg.cancel()">
          <text>{{ dlg.cancelText || t('common.cancel') }}</text>
        </view>
        <view class="mbtn adlg-btn" :class="{ danger: dlg.danger }" @tap="onOk">
          <text>{{ dlg.confirmText || t('common.ok') }}</text>
        </view>
      </view>
    </view>
  </AdSheet>
  <AdToast />
</template>

<style scoped>
.adlg { display: flex; flex-direction: column; gap: 10px; padding-bottom: 10px; }
.adlg-content { font-size: 13px; line-height: 1.7; color: var(--ad-text-soft); }
.adlg-input {
  height: 44px;
  border-radius: 12px;
  background: var(--ad-inset);
  border: 1px solid var(--ad-line);
  padding: 0 14px;
  font-size: 14px;
  color: var(--ad-text);
}
.adlg-item {
  position: relative;
  height: 48px;
  border-radius: 13px;
  background: var(--ad-inset);
  border: 1px solid var(--ad-line);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 600;
  color: var(--ad-text);
  transition: transform 0.16s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.adlg-item:active { transform: scale(0.97); }
/* 带图标的行改左对齐（图标 currentColor 继承行色，danger 行图标随之变红） */
.adlg-item.has-icon { justify-content: flex-start; gap: 10px; padding: 0 15px; }
.adlg-item-i { display: flex; flex: none; width: 18px; align-items: center; justify-content: center; }
.adlg-item.danger { color: var(--ad-danger); }
.adlg-item.on { border-color: rgba(224, 182, 78, 0.45); color: var(--ad-brand); }
/* 私有模型行：青色系（同 gen-confirm-sheet 的「免费」徽标），选中态仍保持青色；
   置于 .on 之后，同特异性下后声明胜出 */
.adlg-item.private { color: var(--ad-accent); border-color: rgba(45, 212, 191, 0.35); }
.adlg-item.private.on { background: var(--ad-accent-soft-strong); border-color: rgba(224, 182, 78, 0.45); }
.adlg-item.on .m-icon, .adlg-item > .m-icon { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); }
.adlg-btns { display: flex; gap: 10px; padding-top: 2px; }
.adlg-btn {
  flex: 1;
  height: 46px;
  border-radius: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.adlg-cancel {
  height: 46px;
  border-radius: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
