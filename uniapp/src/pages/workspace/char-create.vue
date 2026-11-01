<script setup>
/**
 * 自定义角色创建独立页（原 assets 页创建器 AdSheet 迁出，参照 pages/projects/edit 页面模式）：
 * 性别 + 外貌/人设选型（服务端 /character-options 注册表，按性别过滤）+ 名称 + 补充描述，
 * 确认后走 useCostAction 统一「模型+价格」确认页 → POST /projects/:pid/characters/custom
 * 建 asset_image 任务 → 回资产库（uni.$emit('assets:reload') 触发列表重拉）。
 */
import { ref, reactive, computed, watch } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { characterOptionApi } from '../../api';
import { useCostAction } from '../../composables/useCostAction';
import { useThemeStore } from '../../stores/theme';
import { toAbsolute } from '../../utils/media';
import { toast } from '../../utils/ui';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import GenConfirmSheet from '../../components/gen-confirm-sheet/gen-confirm-sheet.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t, te } = useI18n();
const { runJob } = useCostAction();
const theme = useThemeStore();

let pid = null; // 项目 id（/pages/workspace/char-create?pid=xxx）

const loading = ref(false);
const submitting = ref(false);
const name = ref('');
const freeText = ref('');
const sel = reactive({});
// 注册表用 ref（曾用普通 let + 始终挂载的弹层 slot，computed 以空数组求值被缓存，
// 导致性别与全部分组渲染不出来——App/小程序端实测症状）；会话级缓存：内容稳定，重复进入不重复拉取
const groups = ref([]);
let loaded = false;
const genderOptions = computed(() => (groups.value.find((g) => g.key === 'gender') || {}).options || []);
// 按当前性别过滤后的分组（性别组单独渲染；无匹配选项的组隐藏）
const visibleGroups = computed(() => {
  const g = sel.gender;
  return groups.value
    .filter((x) => x.key !== 'gender')
    .map((x) => ({ ...x, options: x.options.filter((o) => !g || (o.genders || []).includes(g)) }))
    .filter((x) => x.options.length > 0);
});
// i18n 缺失回退：任何语言缺 key 时显示服务端下发的中文 label
const ccGroupLabel = (key, zh) => (te(`charCreator.group.${key}`) ? t(`charCreator.group.${key}`) : (zh || key));
const ccOptionLabel = (groupKey, o) => (te(`charCreator.option.${groupKey}.${o.key}`) ? t(`charCreator.option.${groupKey}.${o.key}`) : o.zh);

async function loadOptions() {
  if (loaded) return;
  loading.value = true;
  try {
    const data = await characterOptionApi.options();
    groups.value = data.groups || [];
    loaded = true;
  } catch { /* http 层已提示 */ } finally { loading.value = false; }
}
onLoad((q) => {
  pid = q?.pid || null;
  loadOptions();
});
function selectGender(key) { sel.gender = key; } // 必选项：点换即设，不可取消
function pickOption(groupKey, option) {
  if (sel[groupKey] === option.key) delete sel[groupKey]; // 再点取消
  else sel[groupKey] = option.key;
}
// 性别切换：清掉与新性别不兼容的已选项
watch(() => sel.gender, (g) => {
  if (!g) return;
  for (const grp of groups.value) {
    if (grp.key === 'gender') continue;
    const cur = grp.options.find((o) => o.key === sel[grp.key]);
    if (cur && !(cur.genders || []).includes(g)) delete sel[grp.key];
  }
});

async function onConfirm() {
  if (!sel.gender) { toast(t('charCreator.genderRequired'), 'error'); return; }
  if (submitting.value) return;
  submitting.value = true;
  try {
    const payload = { name: name.value.trim(), selections: { ...sel }, freeText: freeText.value.trim() };
    const job = await runJob({
      modelType: 'image',
      hideResolution: true, // 同 genImage：生图接口不消费分辨率档位
      estimateFor: (s) => characterOptionApi.createEstimate(pid, s),
      createFor: (s) => characterOptionApi.create(pid, { ...payload, modelConfigId: s.modelConfigId }).then((d) => ({ job: d.job })),
      title: t('charCreator.confirm.title'), desc: t('charCreator.confirm.desc'), confirmText: t('charCreator.confirmText'),
    });
    if (job) { // 任务已建立才返回；用户取消确认页则保留选择
      uni.$emit('assets:reload');
      uni.navigateBack();
    }
  } finally { submitting.value = false; }
}
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="t('charCreator.title')" />

    <view class="cc-body">
      <view v-if="loading" class="ad-loading"><text>{{ t('common.loading') }}</text></view>
      <template v-else>
        <view class="cc-sec">
          <view class="cc-fl">{{ ccGroupLabel('gender') }}<text class="cc-req">*</text></view>
          <view class="cc-gender">
            <view v-for="o in genderOptions" :key="o.key" class="cc-card" :class="{ on: sel.gender === o.key }" @tap="selectGender(o.key)">
              <view class="cc-img">
                <image v-if="o.preview" :src="toAbsolute(o.preview)" mode="aspectFill" class="cc-imgel" />
                <text v-else class="cc-ph">{{ ccOptionLabel('gender', o) }}</text>
                <view v-if="sel.gender === o.key" class="cc-check"><m-icon name="check" :size="12" color="#1d1503" :sw="3" /></view>
              </view>
              <text class="cc-label">{{ ccOptionLabel('gender', o) }}</text>
            </view>
          </view>
        </view>
        <view v-for="g in visibleGroups" :key="g.key" class="cc-sec">
          <view class="cc-fl">
            <text>{{ ccGroupLabel(g.key, g.zh) }}</text>
            <text class="cc-optional">{{ t('charCreator.optional') }}</text>
          </view>
          <view class="cc-grid">
            <view v-for="o in g.options" :key="o.key" class="cc-card" :class="{ on: sel[g.key] === o.key }" @tap="pickOption(g.key, o)">
              <view class="cc-img">
                <image v-if="o.preview" :src="toAbsolute(o.preview)" mode="aspectFill" class="cc-imgel" />
                <text v-else class="cc-ph">{{ ccOptionLabel(g.key, o) }}</text>
                <view v-if="sel[g.key] === o.key" class="cc-check"><m-icon name="check" :size="12" color="#1d1503" :sw="3" /></view>
              </view>
              <text class="cc-label">{{ ccOptionLabel(g.key, o) }}</text>
            </view>
          </view>
        </view>
        <view class="ad-field">
          <view class="cc-fl">{{ t('charCreator.nameLabel') }}</view>
          <input v-model="name" class="ad-input" :maxlength="64" :placeholder="t('charCreator.namePlaceholder')" placeholder-class="ad-ph" />
        </view>
        <view class="ad-field">
          <view class="cc-fl">{{ t('charCreator.freeTextLabel') }}</view>
          <textarea v-model="freeText" class="ad-textarea" :maxlength="500" :placeholder="t('charCreator.freeTextPlaceholder')" placeholder-class="ad-ph" />
        </view>
        <view style="height: 24px" />
      </template>
    </view>

    <!-- 底部确认条 -->
    <view class="cc-foot">
      <view class="mbtn" :class="{ dis: !sel.gender || submitting }" @tap="onConfirm">{{ t('charCreator.confirmText') }}</view>
    </view>

    <!-- 统一「模型+价格」确认页（本页挂一份） -->
    <GenConfirmSheet />
    <AdDialog />
  </view>
</template>

<style scoped>
.cc-body { padding: 12px 18px 110px; }
.cc-foot { position: fixed; left: 0; right: 0; bottom: 0; z-index: 80; padding: 12px 18px calc(12px + env(safe-area-inset-bottom)); background: var(--ad-ink); }
.cc-foot .mbtn { height: 44px; border-radius: 13px; display: flex; align-items: center; justify-content: center; }
.cc-sec { margin-bottom: 18px; }
.cc-fl { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: var(--ad-text); margin-bottom: 9px; }
.cc-req { color: var(--ad-danger); }
.cc-optional { font-size: 10.5px; font-weight: 400; color: var(--ad-text-mut); }
/* 性别项与 .cc-grid 同款三列网格：宽度由列定，图片与其他选项卡片等大（flex 无宽度约束会塌缩） */
.cc-gender { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; }
.cc-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; }
.cc-card { position: relative; cursor: pointer; }
.cc-img { position: relative; aspect-ratio: 1 / 1; border-radius: 11px; overflow: hidden; background: var(--ad-inset); border: 1.5px solid var(--ad-line); }
.cc-card.on .cc-img { border-color: var(--ad-brand); }
.cc-imgel { width: 100%; height: 100%; }
.cc-ph { position: absolute; top: 0; right: 0; bottom: 0; left: 0; display: flex; align-items: center; justify-content: center; padding: 4px; font-size: 11px; color: var(--ad-text-soft); text-align: center; }
.cc-check {
  position: absolute; right: 4px; top: 4px; width: 17px; height: 17px; border-radius: 50%;
  background: var(--ad-brand); display: flex; align-items: center; justify-content: center;
}
.cc-label { display: block; margin-top: 4px; font-size: 10.5px; color: var(--ad-text-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
.cc-card.on .cc-label { color: var(--ad-brand); font-weight: 600; }
</style>
