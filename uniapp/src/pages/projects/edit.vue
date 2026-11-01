<script setup>
/**
 * 新建 / 编辑项目（含封面与 AI 封面）。
 * 与 client ProjectsView 弹窗同口径：create/update + uploadCover + AI 封面两步确认
 * （素材选择抽屉 → 统一「模型+价格」确认页）。
 */
import { ref, reactive, computed, onMounted } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { projectApi } from '../../api';
import { useCostAction } from '../../composables/useCostAction';
import { useThemeStore } from '../../stores/theme';
import { toAbsolute } from '../../utils/media';
import { toast, toastError, selectSheet } from '../../utils/ui';
import AdToast from '../../components/ad-toast/ad-toast.vue';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import ArtStylePicker from '../../components/art-style-picker/art-style-picker.vue';
import AdSheet from '../../components/ad-sheet/ad-sheet.vue';
import GenConfirmSheet from '../../components/gen-confirm-sheet/gen-confirm-sheet.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import { useBackGuard } from '../../composables/useBackGuard';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const { runJob } = useCostAction();
const theme = useThemeStore();

const editingId = ref(null);
const submitting = ref(false);
const form = reactive({ name: '', style: '', aspect_ratio: '9:16', cover: '', producer: '', copyright: '', narrative_type: '' });
// 封面：coverFile 为本次新选的本地临时路径（提交时上传），coverPreviewUrl 为本地预览
const coverFile = ref('');
const coverPreviewUrl = ref('');
const coverImg = computed(() => coverPreviewUrl.value || (form.cover ? toAbsolute(form.cover) : ''));

const isNew = computed(() => !editingId.value);
const title = computed(() => (isNew.value ? t('project.newProject') : t('project.editProject')));

// 叙事类型（与后端 NARRATIVE_TYPES 一致；复用 script.genre.* 译文）
const NARRATIVE_TYPES = [
  'Sweet_romance_novel', 'Urban_workplace_drama', 'Xianxia_fantasy', 'Comedy_humor',
  'Mystery_thriller', 'Hot_blooded_action', 'Coming_of_age', 'Family_warmth',
  'Historical_epic', 'Psychological_drama', 'Horror_supernatural', 'Scifi_post_apocalypse',
];
const narrativeNames = computed(() => NARRATIVE_TYPES.map((k) => t(`script.genre.${k}`)));
// 叙事类型下拉（selectSheet 底部选择面板，弃用原生 picker）；narrativeOpen 驱动箭头朝向（关=向下，开=向上）
const narrativeOpen = ref(false);
async function pickNarrative() {
  narrativeOpen.value = true;
  try {
    const k = await selectSheet({
      title: t('project.narrativeType'),
      items: NARRATIVE_TYPES.map((v, i) => ({ key: v, label: narrativeNames.value[i] })),
      current: form.narrative_type || '',
    });
    if (k !== null) form.narrative_type = k;
  } finally {
    narrativeOpen.value = false;
  }
}

// 新建项目默认风格：都市影像（选择器加载后未指定时回退第一项）
const DEFAULT_STYLE_KEY = 'realpeople_modern_city';

async function loadProject(id) {
  try {
    const p = await projectApi.get(id);
    editingId.value = p.id;
    form.name = p.name;
    form.style = p.style;
    form.aspect_ratio = p.aspect_ratio;
    form.cover = p.cover || '';
    form.producer = p.producer || '';
    form.copyright = p.copyright || '';
    form.narrative_type = p.narrative_type || '';
  } catch (e) {
    toastError(e);
  }
}

function chooseCover() {
  uni.chooseImage({
    count: 1,
    success: (res) => {
      coverFile.value = res.tempFilePaths[0];
      coverPreviewUrl.value = res.tempFilePaths[0];
    },
  });
}
function clearCover() {
  coverFile.value = '';
  coverPreviewUrl.value = '';
  form.cover = '';
}
// 点击封面大图预览（coverImg 已是绝对路径/本地临时路径；× 角标 .stop 不触发预览）
function previewCover() {
  if (coverImg.value) uni.previewImage({ urls: [coverImg.value] });
}

// —— AI 生成封面（仅编辑态）——
const coverAiChecking = ref(false);
const coverMaterials = ref(null); // 候选 { characters, scenes, props, synopsis_count }
const coverPickShow = ref(false);
const coverSelected = reactive({ character: [], scene: [], prop: [] });
const coverDesc = ref('');

async function aiCover() {
  if (!editingId.value || coverAiChecking.value) return;
  coverAiChecking.value = true;
  try {
    coverMaterials.value = await projectApi.coverAiMaterials(editingId.value);
    // 默认勾选各组出镜最多的一个（接口按出镜次数降序，首项即默认）
    coverSelected.character = coverMaterials.value?.characters?.[0]?.id ? [coverMaterials.value.characters[0].id] : [];
    coverSelected.scene = coverMaterials.value?.scenes?.[0]?.id ? [coverMaterials.value.scenes[0].id] : [];
    coverSelected.prop = coverMaterials.value?.props?.[0]?.id ? [coverMaterials.value.props[0].id] : [];
    coverDesc.value = '';
    coverPickShow.value = true;
  } catch {
    return; // 缺分镜/资产图片/剧本概要：http 层已提示
  } finally {
    coverAiChecking.value = false;
  }
}

const COVER_KINDS = [
  { key: 'character', label: () => t('project.coverPickCharacters'), items: () => coverMaterials.value?.characters || [] },
  { key: 'scene', label: () => t('project.coverPickScenes'), items: () => coverMaterials.value?.scenes || [] },
  { key: 'prop', label: () => t('project.coverPickProps'), items: () => coverMaterials.value?.props || [] },
];
function togglePick(kind, id) {
  const arr = coverSelected[kind];
  const i = arr.indexOf(id);
  if (i > -1) arr.splice(i, 1);
  else arr.push(id);
}

async function onCoverPicks() {
  coverPickShow.value = false;
  const picks = { characterIds: [...coverSelected.character], sceneIds: [...coverSelected.scene], propIds: [...coverSelected.prop], description: coverDesc.value };
  const job = await runJob({
    modelType: 'image',
    hideResolution: true, // 封面固定输出 480p，模型档位的分辨率选项不参与估价/生成，不展示
    selection: {},
    estimateFor: (sel) => projectApi.coverAiEstimate(editingId.value, sel.modelConfigId),
    createFor: (sel) => projectApi.coverAi(editingId.value, sel.modelConfigId, picks).then((data) => ({ job: data.job })),
    title: t('project.aiCoverButton'),
    desc: form.name,
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.cover_url) {
        form.cover = j.result.cover_url;
        coverFile.value = '';
        coverPreviewUrl.value = '';
      }
    },
  });
  if (job) toast(t('project.aiCoverQueued'), 'success');
}

async function submit() {
  if (!form.name.trim()) { toast(t('project.nameRequired')); return; }
  if (!form.style) { toast(t('project.styleRequired')); return; }
  submitting.value = true;
  try {
    if (isNew.value) {
      const p = await projectApi.create({
        name: form.name, style: form.style, aspect_ratio: form.aspect_ratio,
        producer: form.producer, copyright: form.copyright, narrative_type: form.narrative_type || null,
      });
      if (coverFile.value) await projectApi.uploadCover(p.id, coverFile.value);
      toast(t('project.created'), 'success');
      uni.redirectTo({ url: `/pages/workspace/index?id=${p.id}` });
    } else {
      // 始终回传封面：clearCover 置空串才能真删（服务端白名单按 !== undefined 收 cover）
      await projectApi.update(editingId.value, {
        name: form.name, style: form.style, aspect_ratio: form.aspect_ratio,
        producer: form.producer, copyright: form.copyright, narrative_type: form.narrative_type || null,
        cover: form.cover || '',
      });
      if (coverFile.value) await projectApi.uploadCover(editingId.value, coverFile.value);
      toast(t('project.updated'), 'success');
      uni.navigateBack();
    }
  } catch (e) {
    toastError(e);
  } finally {
    submitting.value = false;
  }
}

onLoad((q) => {
  if (q?.id) loadProject(q.id);
});
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="title" />

    <view class="pe-body">
      <!-- 封面（仅编辑态展示；新建时隐藏） -->
      <view v-if="!isNew" class="ad-field-label">{{ t('project.coverLabel') }}</view>
      <view v-if="!isNew" class="pe-cover-row">
        <view v-if="coverImg" class="pe-cover" @tap="previewCover">
          <image :src="coverImg" mode="aspectFill" class="pe-cover-img" />
          <view class="pe-cover-x" @tap.stop="clearCover"><text>×</text></view>
        </view>
        <view v-else class="pe-cover pe-cover-empty" @tap="chooseCover">
          <m-icon name="plus" :size="22" />
        </view>
        <view class="pe-cover-acts">
          <view class="mbtn soft sm" @tap="chooseCover">{{ t('project.changeCover') }}</view>
          <view v-if="!isNew" class="mbtn ghost sm" :class="{ dis: coverAiChecking }" @tap="!coverAiChecking && aiCover()">
            <m-icon name="spark" :size="14" /> {{ t('project.aiCoverButton') }}
          </view>
        </view>
      </view>

      <!-- 名称；制作人 / 版权仅编辑态展示（新建时隐藏） -->
      <view class="ad-field">
        <view class="ad-field-label">{{ t('project.nameLabel') }}</view>
        <input v-model="form.name" class="ad-input" :placeholder="t('project.namePlaceholder')" placeholder-class="ad-ph" :maxlength="40">
      </view>
      <view v-if="!isNew" class="ad-field">
        <view class="ad-field-label">{{ t('project.producerLabel') }}</view>
        <input v-model="form.producer" class="ad-input" :placeholder="t('common.pleaseInput')" placeholder-class="ad-ph" :maxlength="40">
      </view>
      <view v-if="!isNew" class="ad-field">
        <view class="ad-field-label">{{ t('project.copyrightLabel') }}</view>
        <input v-model="form.copyright" class="ad-input" :placeholder="t('common.pleaseInput')" placeholder-class="ad-ph" :maxlength="40">
      </view>

      <!-- 叙事类型 -->
      <view class="ad-field">
        <view class="ad-field-label">{{ t('project.narrativeType') }}</view>
        <view class="ad-input ad-picker" @tap="pickNarrative">
          <text :class="{ ph: !form.narrative_type }">
            {{ form.narrative_type ? t(`script.genre.${form.narrative_type}`) : t('common.pleaseSelect') }}
          </text>
          <m-icon :name="narrativeOpen ? 'up' : 'down'" :size="16" />
        </view>
      </view>

      <!-- 视觉风格 + 画面比例 -->
      <view class="ad-field">
        <view class="ad-field-label">{{ t('project.visualStyle') }}</view>
        <ArtStylePicker
          v-model="form.style"
          v-model:aspect="form.aspect_ratio"
          :default-style="DEFAULT_STYLE_KEY"
        />
      </view>

      <view class="mbtn pe-submit" :class="{ dis: submitting }" @tap="!submitting && submit()">
        {{ isNew ? t('project.submitCreate') : t('project.submitSave') }}
      </view>
    </view>

    <!-- AI 封面素材选择 -->
    <AdSheet :show="coverPickShow" :title="t('project.aiCoverPickTitle')" @update:show="coverPickShow = $event">
      <view class="cpm">
        <view v-for="k in COVER_KINDS" :key="k.key" class="cpm-group">
          <view class="cpm-label">{{ k.label() }}</view>
          <view v-if="!k.items().length" class="cpm-none">{{ t('common.noData') }}</view>
          <view class="cpm-chips">
            <text
              v-for="it in k.items()"
              :key="it.id"
              class="pchip"
              :class="{ on: coverSelected[k.key].includes(it.id) }"
              @tap="togglePick(k.key, it.id)"
            >{{ it.name }}</text>
          </view>
        </view>
        <view class="ad-field">
          <view class="ad-field-label">{{ t('project.coverPickDescLabel') }}</view>
          <input v-model="coverDesc" class="ad-input" :placeholder="t('project.coverPickDescPlaceholder')" placeholder-class="ad-ph" :maxlength="100">
        </view>
        <view class="mbtn" @tap="onCoverPicks">{{ t('common.confirm') }}</view>
      </view>
    </AdSheet>
    <GenConfirmSheet />
    <AdToast />
    <AdDialog />
  </view>
</template>

<style scoped>
.pe-body { padding: 16px 18px 40px; }
.ad-field-label { font-size: 13px; font-weight: 600; color: var(--ad-text); margin-bottom: 8px; display: block; }
.pe-cover-row { display: flex; gap: 14px; align-items: center; margin-bottom: 18px; }
.pe-cover {
  width: 96px; height: 144px; border-radius: 12px; overflow: hidden; /* 2:3 竖版，与 AI 封面出图比例一致 */
  border: 1px solid var(--ad-line); background: var(--ad-inset); position: relative; flex: none;
}
.pe-cover-empty { display: flex; align-items: center; justify-content: center; color: var(--ad-text-mut); }
.pe-cover-img { width: 100%; height: 100%; }
.pe-cover-x {
  position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; border-radius: 50%;
  background: rgba(0, 0, 0, 0.55); color: #fff; text-align: center; line-height: 18px; font-size: 14px;
}
.pe-cover-acts { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
.ad-picker { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ad-picker .ph { color: var(--ad-text-mut); }
.pe-submit { margin-top: 24px; }
.cpm { padding-bottom: 8px; }
.cpm-group { margin-bottom: 14px; }
.cpm-label { font-size: 13px; font-weight: 600; color: var(--ad-text); margin-bottom: 8px; }
.cpm-none { font-size: 12px; color: var(--ad-text-mut); }
.cpm-chips { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
