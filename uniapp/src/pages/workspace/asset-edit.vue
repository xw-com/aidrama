<script setup>
/**
 * 资产编辑独立页（原 assets 页「资产编辑」AdSheet 迁出，参照 pages/workspace/char-create 页面模式）：
 * ?pid=<projectId>&aid=<assetId>&kind=<kind>；带 aid = 编辑（完整资产对象由列表页经
 * EventChannel 推送，收不到再兜底从列表接口捞取），不带 aid = 新建（kind 决定类型）。
 * 表单：名称 / 角色标签 / 豆包资产 ID / 音色（音色选择弹层 + 试听 + 收藏）/ 别名 / 描述 / 提示词，
 * 角色另含服饰管理（上传图 / 按要求生图 / 设默认 / 删除，生图走 useCostAction 统一确认页）。
 */
import { ref, reactive, computed, watch, nextTick, getCurrentInstance } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import { useI18n } from 'vue-i18n';
import { assetApi, projectApi, voiceApi } from '../../api';
import { useCostAction } from '../../composables/useCostAction';
import { useThemeStore } from '../../stores/theme';
import { can } from '../../utils/perms';
import { toAbsolute } from '../../utils/media';
import { getItem, setItem } from '../../utils/storage';
import { toast, confirm, selectSheet } from '../../utils/ui';
import { backToParent } from '../../utils/back';
import AdNavbar from '../../components/ad-navbar/ad-navbar.vue';
import AdSheet from '../../components/ad-sheet/ad-sheet.vue';
import MIcon from '../../components/m-icon/m-icon.vue';
import GenConfirmSheet from '../../components/gen-confirm-sheet/gen-confirm-sheet.vue';
import AdDialog from '../../components/ad-dialog/ad-dialog.vue';
import { useBackGuard } from '../../composables/useBackGuard';

// 系统返回键：只回父级一层，不越级回祖父（规则见 utils/back.js）
useBackGuard();

const { t } = useI18n();
const { runJob } = useCostAction();
const theme = useThemeStore();

let pid = null; // 项目 id（/pages/workspace/asset-edit?pid=xxx）
let aid = null; // 资产 id：有 = 编辑；无 = 新建（kind 决定类型）
const asset = ref(null); // 编辑模式：列表页经 EventChannel 推来的完整资产对象（音色入口行头像/名称用）
const kind = ref('character');
const project = ref(null);
const isEdit = computed(() => aid != null);
const isChar = computed(() => kind.value === 'character');
// 豆包资产 ID：character/scene/prop 三类可填（视频生成按 asset:// 引用数字资产）
const showDoubao = computed(() => ['character', 'scene', 'prop'].includes(kind.value));
const canGen = computed(() => can(project.value, 'ai.generate'));

const imgSrc = (a) => toAbsolute(a.thumb_url || a.image_url || '');
const cosSrc = (c) => toAbsolute(c.thumb_url || c.image_url || '');

// ============ 表单 ============
const editForm = ref({ name: '', aliases: [], description: '', prompt: '', role_tag: '', doubao_asset_id: '', voice_id: '', voice_settings: null });
// 别名（client 的多选可建下拉 → 移动端改为 chips + 输入添加）
const aliasInput = ref('');
function addAlias() {
  const v = aliasInput.value.trim();
  if (!v) return;
  if (!editForm.value.aliases.some((x) => x === v)) editForm.value.aliases.push(v);
  aliasInput.value = '';
}
function removeAlias(i) { editForm.value.aliases.splice(i, 1); }

// 回填表单。关键平台坑：App/小程序端 uni-input 吃不到「挂载帧上的初始值」——
// 页面先以空表单挂载，数据到达后的 nextTick 再赋值（与用户输入同路径），不能在 setup 同步填充
function populate(a) {
  editForm.value = {
    name: a.name, aliases: Array.isArray(a.aliases) ? [...a.aliases] : [],
    description: a.description || '', prompt: a.prompt || '',
    role_tag: a.role_tag || '', doubao_asset_id: a.doubao_asset_id || '',
    voice_id: a.meta?.voiceId || '',
    voice_settings: a.kind === 'character' ? { ...DEFAULT_VOICE_SETTINGS, ...(a.meta?.voiceSettings || {}) } : null,
  };
  aliasInput.value = '';
}

onLoad((q) => {
  pid = (q && (q.pid || q.id)) || null;
  aid = q && q.aid ? Number(q.aid) : null;
  kind.value = (q && q.kind) || 'character';
  voiceApi.list().then((v) => { voices.value = v; }).catch(() => { /* 声音库加载失败不阻塞 */ });
  // 项目详情只为权限（服饰生图按钮的 canGen）；加载失败仅影响按钮可用态，不阻塞表单
  if (pid) projectApi.get(pid).then((p) => { project.value = p; }).catch(() => { /* ignore */ });
  if (aid) receiveAsset();
});

// 编辑模式：优先收列表页经 EventChannel 推来的完整资产对象；拿不到通道再兜底从列表接口捞
function receiveAsset() {
  const ec = getCurrentInstance()?.proxy?.getOpenerEventChannel?.();
  if (ec && typeof ec.on === 'function') {
    let got = false;
    ec.on('asset', (a) => {
      if (!a) return;
      got = true;
      asset.value = a;
      kind.value = a.kind || kind.value;
      loadCostumes(aid);
      nextTick(() => { if (asset.value) populate(asset.value); });
    });
    // 深链打开（任务中心「查看结果」）时 uni-app 也会惰性建空通道，但永远无人 emit：
    // 推送未在超时内到达则从列表接口兜底捞（列表页正常打开时推送先行，此处不触发）
    setTimeout(() => { if (!got && !asset.value) loadAssetFromList(); }, 300);
  } else {
    loadAssetFromList();
  }
}
async function loadAssetFromList() {
  try {
    const rows = await assetApi.list(pid);
    const hit = rows.find((x) => x.id === aid);
    if (hit) {
      asset.value = hit;
      kind.value = hit.kind || kind.value;
      loadCostumes(aid);
      nextTick(() => { if (asset.value) populate(asset.value); });
    }
  } catch { /* http 层已提示 */ }
}

// ============ 保存：编辑走 update；新建先 create（服务端只收 kind/name/desc/prompt）再补一次 update 带上其余字段 ============
const saving = ref(false);
async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    if (aid) {
      await assetApi.update(aid, editForm.value);
    } else {
      const a = await assetApi.create(pid, {
        kind: kind.value,
        name: editForm.value.name,
        description: editForm.value.description,
        prompt: editForm.value.prompt,
      });
      await assetApi.update(a.id, {
        aliases: editForm.value.aliases,
        role_tag: editForm.value.role_tag,
        doubao_asset_id: editForm.value.doubao_asset_id,
        voice_id: editForm.value.voice_id,
        voice_settings: editForm.value.voice_settings,
      });
    }
    uni.$emit('assets:reload'); // 回资产库触发列表重拉
    toast(t('asset.saved'), 'success');
    uni.navigateBack();
  } catch { /* http 层已提示 */ } finally { saving.value = false; }
}
function cancel() { backToParent(); }

// ============ 服饰（仅角色，编辑模式）：一套服饰 = 一张图，可设默认 ============
const costumes = ref([]);
const costumeLoading = ref(false);
const costumeBusy = reactive({}); // costumeId -> true：该服饰有操作进行中
const isCostumeBusy = (c) => !!costumeBusy[c.id];
async function withCostumeBusy(costume, fn) {
  costumeBusy[costume.id] = true;
  try { return await fn(); } finally { delete costumeBusy[costume.id]; }
}
async function loadCostumes(a) {
  costumeLoading.value = true;
  try { costumes.value = await assetApi.costumes(a); } finally { costumeLoading.value = false; }
}
function patchCostume(updated) {
  const i = costumes.value.findIndex((c) => c.id === updated.id);
  if (i > -1) costumes.value[i] = updated;
}
async function addCostume() {
  if (!aid) return;
  try {
    const c = await assetApi.createCostume(aid, { name: t('asset.costume.defaultName') });
    costumes.value.push(c);
  } catch { /* http 层已提示 */ }
}
function pickCostumeImage(costume) {
  if (!aid || !costume) return;
  uni.chooseImage({
    count: 1,
    success: (res) => {
      const f = (res.tempFiles && res.tempFiles[0]) || {};
      if (f.size && f.size / 1024 / 1024 >= 10) { toast(t('asset.upload.tooLarge'), 'error'); return; }
      withCostumeBusy(costume, async () => {
        const updated = await assetApi.uploadCostumeImage(aid, costume.id, res.tempFilePaths[0]);
        patchCostume(updated);
        if (updated.is_default) patchAssetAfterCostume();
        toast(t('asset.costume.imageUploaded'), 'success');
      });
    },
  });
}
// 「换装」生图：以「本次要求」作为唯一提示词，仅以角色原图为参考生成该套服饰
async function genCostumeImageByRequirement(costume) {
  if (!aid || !costume) return;
  costumeBusy[costume.id] = true; // 先置 busy（任务建立→轮询至终态期间，服饰卡不可再操作）
  const job = await runJob({
    modelType: 'image',
    hideResolution: true, // 同 genImage：生图接口不消费分辨率档位
    allowRequirement: true,
    requirementPresets: [], // 此处「本次要求」即生图唯一提示词（描述服饰）
    estimateFor: (sel) => assetApi.genCostumeImageEstimate(aid, costume.id, sel),
    createFor: (sel) => assetApi.genCostumeImageByRequirement(aid, costume.id, sel),
    title: t('asset.costume.genByReqTitle'),
    desc: t('asset.costume.genByReqDesc', { name: `${asset.value?.name || t('asset.costume.defaultName')}·${costume.name || t('asset.costume.defaultName')}` }),
    confirmText: t('asset.gen.confirm'),
    onDone: (j) => {
      delete costumeBusy[costume.id];
      if (j.status === 'succeeded' && j.result?.costume) {
        patchCostume(j.result.costume);
        if (j.result.costume.is_default) patchAssetAfterCostume();
      }
    },
  });
  if (!job) delete costumeBusy[costume.id]; // 用户在确认页取消：释放该服饰
}
async function setCostumeDefault(costume) {
  if (!aid || !costume) return;
  await withCostumeBusy(costume, async () => {
    try {
      const updated = await assetApi.setDefaultCostume(aid, costume.id);
      patchCostume(updated); // 后端已把默认服饰镜像回 Asset.image_url
      await loadCostumes(aid);
      patchAssetAfterCostume();
    } catch { /* http 层已提示 */ }
  });
}
async function saveCostumeField(costume) {
  if (!aid || !costume) return;
  try {
    const updated = await assetApi.updateCostume(aid, costume.id, { name: costume.name, prompt: costume.prompt, doubao_asset_id: costume.doubao_asset_id });
    patchCostume(updated);
    toast(t('asset.saved'), 'success');
  } catch { /* http 层已提示 */ }
}
async function removeCostume(costume) {
  const ok = await confirm({ title: t('common.tip'), content: t('asset.costume.deleteConfirm', { name: costume.name || t('asset.costume.defaultName') }), confirmText: t('common.delete') });
  if (!ok) return;
  await withCostumeBusy(costume, async () => {
    try {
      await assetApi.removeCostume(aid, costume.id);
      costumes.value = costumes.value.filter((c) => c.id !== costume.id);
      patchAssetAfterCostume();
    } catch { /* http 层已提示 */ }
  });
}
// 服饰变动后刷新本地资产（默认服饰图可能已镜像到 Asset.image_url，音色入口行头像保持同步）
async function patchAssetAfterCostume() {
  if (!aid || !pid) return;
  try {
    const rows = await assetApi.list(pid);
    const hit = rows.find((x) => x.id === aid);
    if (hit) asset.value = hit;
  } catch { /* ignore */ }
}
// 预览用原图非缩略图（同 assets.vue 约定）；cosSrc 仅作列表小图
const cosFullSrc = (c) => toAbsolute(c.image_url || '');
function previewCostume(c) {
  if (!c.image_url) return;
  const urls = costumes.value.filter((x) => x.image_url).map((x) => cosFullSrc(x));
  const i = urls.indexOf(cosFullSrc(c));
  uni.previewImage({ urls, current: i > -1 ? i : 0 });
}

// ============ 音色选择（仅角色）：系统/收藏 + 场景/年龄/性别筛选 + 试听 ============
const DEFAULT_VOICE_SETTINGS = { speed: 1, volume: 5, pitch: 1, emotion: '' };
const voices = ref([]);
const voiceShow = ref(false);
const voiceTab = ref('system'); // system 系统音色 / favorites 收藏音色（收藏存本地）
const voiceSceneFilter = ref('');
const voiceAgeFilter = ref('');
const voiceGenderFilter = ref('');
const pickerVoiceId = ref(null); // 弹窗内当前选中（仅高亮，确定才带回）
const pickerEntryVoiceId = ref(null); // 打开时的选中快照，取消时回滚

// 收藏音色（本地持久化，voices 表无收藏字段）
const VOICE_FAV_KEY = 'aidrama_voice_favorites';
const voiceFavorites = ref(new Set(JSON.parse(getItem(VOICE_FAV_KEY) || '[]')));
function toggleFav(v) {
  const s = new Set(voiceFavorites.value);
  if (s.has(v.id)) s.delete(v.id); else s.add(v.id);
  voiceFavorites.value = s;
  setItem(VOICE_FAV_KEY, JSON.stringify([...s]));
}
const isFav = (v) => voiceFavorites.value.has(v.id);

const boundVoiceName = computed(() => {
  if (!editForm.value.voice_id) return '';
  const v = voices.value.find((x) => x.id === Number(editForm.value.voice_id));
  return v?.name || '';
});
// 筛选项从数据派生（voices 的 scene / age_range_text 去重）
const sceneOptions = computed(() => [...new Set(voices.value.map((v) => v.scene).filter(Boolean))]);
const ageOptions = computed(() => [...new Set(voices.value.map((v) => v.age_range_text).filter(Boolean))]);
const genderVoiceOptions = computed(() => [
  { value: '男', label: t('voice.maleVoice') },
  { value: '女', label: t('voice.femaleVoice') },
  { value: '中性', label: t('voice.genderNeutral') },
]);
const sceneNames = computed(() => [t('voice.sceneAll'), ...sceneOptions.value]);
const ageNames = computed(() => [t('voice.ageAll'), ...ageOptions.value]);
const genderNames = computed(() => [t('voice.genderAll'), ...genderVoiceOptions.value.map((g) => g.label)]);
const sceneIdx = computed(() => Math.max(0, sceneOptions.value.indexOf(voiceSceneFilter.value)));
const ageIdx = computed(() => Math.max(0, ageOptions.value.indexOf(voiceAgeFilter.value)));
const genderIdx = computed(() => Math.max(0, genderVoiceOptions.value.findIndex((g) => g.value === voiceGenderFilter.value)) + 1);
// 筛选下拉（selectSheet 底部选择面板，弃用原生 picker）：0 号位 = 全部
// vfOpen 记录当前打开的筛选下拉（'scene'|'age'|'gender'），驱动对应行箭头朝向（关=向下，开=向上）
const vfOpen = ref('');
async function pickVoiceFilter(which) {
  const conf = {
    scene: { items: sceneOptions.value, labels: sceneNames.value, cur: voiceSceneFilter.value, set: (v) => (voiceSceneFilter.value = v) },
    age: { items: ageOptions.value, labels: ageNames.value, cur: voiceAgeFilter.value, set: (v) => (voiceAgeFilter.value = v) },
    gender: { items: genderVoiceOptions.value.map((g) => g.value), labels: genderNames.value, cur: voiceGenderFilter.value, set: (v) => (voiceGenderFilter.value = v) },
  }[which];
  vfOpen.value = which;
  try {
    const k = await selectSheet({
      title: { scene: t('voice.sceneAll'), age: t('voice.ageAll'), gender: t('voice.genderAll') }[which],
      items: conf.items.map((v, i) => ({ key: String(i + 1), label: conf.labels[i + 1] })),
      current: conf.cur ? String(conf.items.indexOf(conf.cur) + 1) : '0',
    });
    if (k === null) return;
    const i = Number(k);
    if (which === 'gender') conf.set(i > 0 ? conf.items[i - 1].value ?? conf.items[i - 1] : '');
    else conf.set(i > 0 ? conf.items[i - 1] : '');
  } finally {
    vfOpen.value = '';
  }
}

const filteredVoices = computed(() => voices.value
  .filter((v) => (voiceTab.value === 'favorites' ? isFav(v) : true))
  .filter((v) => !voiceSceneFilter.value || v.scene === voiceSceneFilter.value)
  .filter((v) => !voiceAgeFilter.value || v.age_range_text === voiceAgeFilter.value)
  .filter((v) => !voiceGenderFilter.value || v.gender === voiceGenderFilter.value));
function resetVoiceFilters() {
  voiceSceneFilter.value = '';
  voiceAgeFilter.value = '';
  voiceGenderFilter.value = '';
}

function openVoicePicker() {
  pickerEntryVoiceId.value = editForm.value.voice_id ? Number(editForm.value.voice_id) : null;
  pickerVoiceId.value = pickerEntryVoiceId.value;
  voiceTab.value = 'system';
  resetVoiceFilters();
  voiceShow.value = true;
}
// 选中音色仅高亮，不关窗；再点已选卡片可取消选中
function selectVoice(v) { pickerVoiceId.value = pickerVoiceId.value === v.id ? null : v.id; }
// 弹窗内「清除音色」：仅取消选中，点「确定」后写回空 = 解绑
function clearVoicePicker() { pickerVoiceId.value = null; }
function confirmVoicePicker() {
  editForm.value.voice_id = pickerVoiceId.value || '';
  // 已有自定义设置（语速/音量/语调/情感）沿用，否则默认值
  editForm.value.voice_settings = pickerVoiceId.value
    ? { ...DEFAULT_VOICE_SETTINGS, ...(editForm.value.voice_settings || {}) }
    : null;
  voiceShow.value = false;
  stopPreview();
}
function cancelVoicePicker() {
  pickerVoiceId.value = pickerEntryVoiceId.value;
  voiceShow.value = false;
  stopPreview();
}
// 入口行 × 直接解绑当前音色，无需进弹窗
function clearEditVoice() {
  editForm.value.voice_id = '';
  editForm.value.voice_settings = null;
}
watch(voiceShow, (v) => { if (!v) stopPreview(); });

// 试听：uni 内部音频上下文播放 voices.audio_url（状态由点击处理器直接同步）
const previewVoiceId = ref(null);
let audioCtx = null;
function stopPreview() {
  if (audioCtx) { try { audioCtx.stop(); } catch (e) { /* ignore */ } }
  previewVoiceId.value = null;
}
function togglePreview(v) {
  if (previewVoiceId.value === v.id) { stopPreview(); return; }
  if (!v.audio_url) { toast(t('voice.noPreviewSample'), 'error'); return; }
  if (!audioCtx) {
    audioCtx = uni.createInnerAudioContext();
    audioCtx.onEnded(() => { previewVoiceId.value = null; });
    audioCtx.onError(() => { previewVoiceId.value = null; toast(t('voice.noPreviewSample'), 'error'); });
  }
  stopPreview();
  audioCtx.src = toAbsolute(v.audio_url);
  audioCtx.play();
  previewVoiceId.value = v.id;
}
onUnload(() => { stopPreview(); });
</script>

<template>
  <view class="ad-page" :class="theme.rootCls">
    <AdNavbar :title="t('asset.edit.title')" />

    <view class="ae-body">
      <view class="ad-field">
        <view class="ae-fl">{{ t('common.name') }}</view>
        <input v-model="editForm.name" class="ad-input" :maxlength="60" placeholder-class="ad-ph" />
      </view>
      <view v-if="isChar" class="ad-field">
        <view class="ae-fl">{{ t('asset.roleTag.label') }}</view>
        <input v-model="editForm.role_tag" class="ad-input" :maxlength="30" :placeholder="t('asset.roleTag.placeholder')" placeholder-class="ad-ph" />
      </view>
      <!-- 豆包资产 ID：填写后视频生成按 asset:// 引用数字资产 -->
      <view v-if="showDoubao" class="ad-field">
        <view class="ae-fl">{{ t('asset.doubaoAssetId.label') }}</view>
        <input v-model="editForm.doubao_asset_id" class="ad-input" :maxlength="80" :placeholder="t('asset.doubaoAssetId.placeholder')" placeholder-class="ad-ph" />
      </view>
      <!-- 音色（仅角色）：入口行，点击进「音色选择」弹层 -->
      <view v-if="isChar" class="ad-field">
        <view class="ae-fl">{{ t('asset.voice.label') }}</view>
        <view class="ae-ventry">
          <image v-if="asset && asset.image_url" :src="imgSrc(asset)" mode="aspectFill" class="ae-vava" />
          <view v-else class="ae-vava ae-vava-ph"><m-icon name="user" :size="18" /></view>
          <text class="ae-vname">{{ asset ? asset.name : '' }}</text>
          <view class="ae-vcur" @tap="openVoicePicker">
            <text class="ae-vcur-t">{{ boundVoiceName || t('asset.voice.placeholder') }}</text>
            <m-icon :name="voiceShow ? 'up' : 'down'" :size="14" />
          </view>
          <view v-if="editForm.voice_id" class="ae-vclear" @tap="clearEditVoice"><text>×</text></view>
          <view class="mbtn soft sm" @tap="openVoicePicker">
            <text>{{ t('voice.pickerTitle') }}</text>
            <m-icon name="right" :size="12" />
          </view>
        </view>
        <view class="ad-hint">{{ t('asset.voice.tip') }}</view>
      </view>
      <!-- 别名 -->
      <view class="ad-field">
        <view class="ae-fl">{{ t('asset.aliases.label') }}</view>
        <view v-if="editForm.aliases.length" class="ae-alias-wrap">
          <view v-for="(al, i) in editForm.aliases" :key="al + i" class="pchip on ae-alias">
            <text>{{ al }}</text>
            <text class="ae-alias-x" @tap="removeAlias(i)">×</text>
          </view>
        </view>
        <view class="ae-inline">
          <input v-model="aliasInput" class="ad-input ae-inline-in" :maxlength="40" :placeholder="t('asset.aliases.placeholder')" placeholder-class="ad-ph" confirm-type="done" @confirm="addAlias" />
          <view class="mbtn soft sm ae-inline-btn" @tap="addAlias"><m-icon name="plus" :size="13" :sw="2" /></view>
        </view>
        <view class="ad-hint">{{ t('asset.aliases.tip') }}</view>
      </view>
      <view class="ad-field">
        <view class="ae-fl">{{ t('common.desc') }}</view>
        <textarea v-model="editForm.description" class="ad-textarea" :maxlength="4000" auto-height :placeholder="t('common.pleaseInput')" placeholder-class="ad-ph" />
      </view>
      <view class="ad-field">
        <view class="ae-fl">{{ t('asset.imagePrompt') }}</view>
        <textarea v-model="editForm.prompt" class="ad-textarea" :maxlength="4000" auto-height :placeholder="t('common.pleaseInput')" placeholder-class="ad-ph" />
      </view>
      <!-- 服饰（仅角色，编辑模式：服饰须挂在已有资产上，新建保存后才能管理） -->
      <view v-if="isChar && isEdit" class="ad-field">
        <view class="ae-fl">{{ t('asset.costume.title') }}</view>
        <view v-if="costumeLoading" class="ae-loading"><text>{{ t('common.loading') }}</text></view>
        <view v-else class="ae-cos-wrap">
          <view v-for="c in costumes" :key="c.id" class="ae-cos-card" :class="{ def: c.is_default }">
            <view class="ae-cos-thumb" @tap="c.image_url && previewCostume(c)">
              <image v-if="c.image_url" :src="cosSrc(c)" mode="aspectFill" class="ae-cos-img" />
              <view v-else class="ae-cos-ph"><m-icon name="remake" :size="18" /></view>
              <view v-if="isCostumeBusy(c)" class="ae-cos-busy"><view class="pulse" /><text>{{ t('asset.costume.processing') }}</text></view>
              <text v-if="c.is_default" class="ae-cos-deftag">{{ t('asset.costume.default') }}</text>
            </view>
            <input v-model="c.name" class="ae-cos-in" :maxlength="40" :placeholder="t('asset.costume.namePlaceholder')" placeholder-class="ad-ph" @blur="saveCostumeField(c)" />
            <input v-model="c.doubao_asset_id" class="ae-cos-in" :maxlength="80" :placeholder="t('asset.doubaoAssetId.placeholder')" placeholder-class="ad-ph" @blur="saveCostumeField(c)" />
            <view class="ae-cos-ops">
              <view class="pchip ae-cos-op" :class="{ dim: isCostumeBusy(c) }" @tap="!isCostumeBusy(c) && pickCostumeImage(c)">
                <text>{{ t('asset.uploadImage') }}</text>
              </view>
              <view class="pchip ae-cos-op" :class="{ dim: isCostumeBusy(c) || !canGen }" @tap="!isCostumeBusy(c) && canGen && genCostumeImageByRequirement(c)">
                <text>{{ t('asset.costume.generateByRequirement') }}</text>
              </view>
              <view class="pchip ae-cos-op" :class="{ on: c.is_default, dim: isCostumeBusy(c) }" @tap="!isCostumeBusy(c) && setCostumeDefault(c)">
                <text>{{ t('asset.costume.setDefault') }}</text>
              </view>
              <view class="pchip ae-cos-op bad" :class="{ dim: isCostumeBusy(c) }" @tap="!isCostumeBusy(c) && removeCostume(c)">
                <text>{{ t('common.delete') }}</text>
              </view>
            </view>
          </view>
          <view class="ae-cos-add" @tap="addCostume">
            <m-icon name="plus" :size="16" :sw="2" />
            <text>{{ t('asset.costume.add') }}</text>
          </view>
          <view class="ad-hint ae-cos-tip">{{ t('asset.costume.tip') }}</view>
        </view>
      </view>

      <view style="height: 24px" />
    </view>

    <!-- 底部操作条 -->
    <view class="ae-foot">
      <view class="mbtn ghost" @tap="cancel">{{ t('common.cancel') }}</view>
      <view class="mbtn" :class="{ dis: saving }" @tap="save">{{ t('common.save') }}</view>
    </view>

    <!-- 音色选择弹层（仅角色） -->
    <AdSheet v-model:show="voiceShow" :title="t('voice.pickerTitle')">
      <view class="ae-vp">
        <view class="ae-vp-tabs">
          <text class="ae-vp-tab" :class="{ on: voiceTab === 'system' }" @tap="voiceTab = 'system'">{{ t('voice.tabSystem') }}</text>
          <text class="ae-vp-tab" :class="{ on: voiceTab === 'favorites' }" @tap="voiceTab = 'favorites'">{{ t('voice.tabFavorites') }}</text>
        </view>
        <view class="ae-vp-filters">
          <view class="ae-vp-filter" @tap="pickVoiceFilter('scene')"><text class="ae-vp-filter-val">{{ sceneNames[sceneIdx] }}</text><m-icon :name="vfOpen === 'scene' ? 'up' : 'down'" :size="13" /></view>
          <view class="ae-vp-filter" @tap="pickVoiceFilter('age')"><text class="ae-vp-filter-val">{{ ageNames[ageIdx] }}</text><m-icon :name="vfOpen === 'age' ? 'up' : 'down'" :size="13" /></view>
          <view class="ae-vp-filter" @tap="pickVoiceFilter('gender')"><text class="ae-vp-filter-val">{{ genderNames[genderIdx] }}</text><m-icon :name="vfOpen === 'gender' ? 'up' : 'down'" :size="13" /></view>
          <view class="ae-vp-reset" @tap="resetVoiceFilters"><text>{{ t('voice.resetFilter') }}</text></view>
        </view>
        <scroll-view scroll-y class="ae-vp-body">
          <view class="ae-vp-grid">
            <view v-for="v in filteredVoices" :key="v.id" class="ae-vp-card" :class="{ on: pickerVoiceId === v.id }" @tap="selectVoice(v)">
              <view class="ae-vp-play" :class="{ on: previewVoiceId === v.id }" @tap.stop="togglePreview(v)">
                <text v-if="previewVoiceId === v.id" class="ae-vp-stop">■</text>
                <m-icon v-else name="play" :size="11" />
              </view>
              <view class="ae-vp-main">
                <text class="ae-vp-name">{{ v.name }}</text>
                <text v-if="v.emotion_type === 1" class="ae-vp-hot">{{ t('voice.multiEmotion') }}</text>
              </view>
              <view class="ae-vp-fav" :class="{ on: isFav(v) }" @tap.stop="toggleFav(v)"><text>{{ isFav(v) ? '★' : '☆' }}</text></view>
            </view>
            <view v-if="!filteredVoices.length" class="ae-vp-empty">
              <text>{{ voiceTab === 'favorites' ? t('voice.noFavorites') : t('voice.noMatch') }}</text>
            </view>
          </view>
          <view v-if="filteredVoices.length" class="pfootnote">{{ t('voice.noMore') }}</view>
        </scroll-view>
        <view class="ae-vp-foot">
          <view class="mbtn ghost sm" :class="{ dis: !pickerVoiceId }" @tap="clearVoicePicker">{{ t('voice.clear') }}</view>
          <view class="mbtn ghost sm" @tap="cancelVoicePicker">{{ t('common.cancel') }}</view>
          <view class="mbtn sm" @tap="confirmVoicePicker">{{ t('common.confirm') }}</view>
        </view>
      </view>
    </AdSheet>

    <!-- 统一「模型+价格」确认页（服饰生图走本页一份） -->
    <GenConfirmSheet />
    <AdDialog />
  </view>
</template>

<style scoped>
.ae-body { padding: 12px 18px 110px; }
.ae-loading { padding: 40px 0; text-align: center; font-size: 13px; color: var(--ad-text-mut); }
.ae-fl { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 700; color: var(--ad-text); margin-bottom: 8px; }

/* 底部操作条 */
.ae-foot { position: fixed; left: 0; right: 0; bottom: 0; z-index: 80; display: flex; gap: 10px; padding: 12px 18px calc(12px + env(safe-area-inset-bottom)); background: var(--ad-ink); }
.ae-foot .mbtn { flex: 1; height: 44px; border-radius: 13px; display: flex; align-items: center; justify-content: center; }

/* 音色入口行 */
.ae-ventry { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.ae-vava { width: 42px; height: 42px; border-radius: 50%; flex: none; border: 1.5px solid rgba(224, 182, 78, 0.4); }
.ae-vava-ph { background: var(--ad-inset); display: flex; align-items: center; justify-content: center; color: var(--ad-text-mut); }
.ae-vname { flex: 1; min-width: 70px; font-size: 13px; font-weight: 700; color: var(--ad-brand); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ae-vcur {
  flex: 1.2; min-width: 110px; height: 40px; padding: 0 12px; border-radius: 11px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  color: var(--ad-text-mut);
}
.ae-vcur-t { font-size: 12.5px; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ae-vclear {
  width: 34px; height: 40px; border-radius: 11px; flex: none;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  display: flex; align-items: center; justify-content: center;
  font-size: 17px; color: var(--ad-danger);
}

/* 别名 */
.ae-alias-wrap { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.ae-alias { display: inline-flex; align-items: center; gap: 5px; }
.ae-alias-x { font-size: 14px; line-height: 1; opacity: 0.75; padding: 0 2px; }
.ae-inline { display: flex; align-items: center; gap: 8px; }
.ae-inline-in { flex: 1; }
.ae-inline-btn { flex: none; min-width: 76px; height: 44px; }

/* 服饰 */
.ae-cos-wrap { display: flex; flex-wrap: wrap; gap: 10px; }
.ae-cos-card {
  width: calc(50% - 5px); padding: 8px; border-radius: 14px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
}
.ae-cos-card.def { border-color: rgba(224, 182, 78, 0.6); }
.ae-cos-thumb { position: relative; width: 100%; height: 92px; border-radius: 10px; overflow: hidden; background: var(--ad-panel); }
.ae-cos-img { width: 100%; height: 100%; }
.ae-cos-ph { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--ad-text-mut); }
.ae-cos-busy {
  position: absolute; top: 0; right: 0; bottom: 0; left: 0; z-index: 2;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  background: rgba(5, 5, 9, 0.6); font-size: 10.5px; color: #fff;
}
.ae-cos-deftag {
  position: absolute; top: 4px; left: 4px; z-index: 3;
  padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 700;
  background: var(--ad-brand); color: var(--ad-brand-contrast);
}
.ae-cos-in {
  height: 34px; margin-top: 7px; padding: 0 9px; border-radius: 9px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  font-size: 12px; color: var(--ad-text);
}
.ae-cos-ops { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.ae-cos-op { flex: 1 1 calc(50% - 3px); min-height: 30px; display: inline-flex; align-items: center; justify-content: center; font-size: 10.5px; padding: 4px 6px; }
.ae-cos-op.dim { opacity: 0.45; }
.ae-cos-op.bad { background: rgba(248, 113, 113, 0.12); color: var(--ad-danger); border-color: transparent; }
.ae-cos-add {
  width: calc(50% - 5px); min-height: 150px; border-radius: 14px;
  border: 1.5px dashed var(--ad-line-strong); background: transparent;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  font-size: 12px; color: var(--ad-text-soft);
}
.ae-cos-tip { flex-basis: 100%; }

/* 音色选择弹层 */
.ae-vp { display: flex; flex-direction: column; }
.ae-vp-tabs { display: flex; gap: 22px; border-bottom: 1px solid var(--ad-line); margin-bottom: 12px; }
.ae-vp-tab { padding: 4px 2px 9px; font-size: 13.5px; font-weight: 600; color: var(--ad-text-mut); border-bottom: 2px solid transparent; }
.ae-vp-tab.on { color: var(--ad-brand); border-bottom-color: var(--ad-brand); }
.ae-vp-filters { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 12px; }
.ae-vp-filter {
  height: 34px; padding: 0 10px; border-radius: 10px;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  display: flex; align-items: center; justify-content: space-between; gap: 5px;
  color: var(--ad-text-mut);
}
.ae-vp-filter-val { font-size: 11.5px; color: var(--ad-text-soft); white-space: nowrap; }
.ae-vp-reset {
  height: 34px; padding: 0 12px; border-radius: 10px; margin-left: auto;
  background: var(--ad-inset); border: 1px solid var(--ad-line);
  display: flex; align-items: center; font-size: 11.5px; color: var(--ad-text-soft);
}
.ae-vp-body { max-height: 46vh; min-height: 0; }
.ae-vp-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.ae-vp-card {
  width: calc(50% - 4px); padding: 8px 9px; border-radius: 12px;
  background: var(--ad-panel); border: 1px solid var(--ad-line);
  display: flex; align-items: center; gap: 7px;
}
.ae-vp-card.on { border-color: var(--ad-brand); background: rgba(224, 182, 78, 0.1); }
.ae-vp-play {
  width: 30px; height: 30px; border-radius: 50%; flex: none;
  background: rgba(224, 182, 78, 0.12); border: 1px solid rgba(224, 182, 78, 0.3);
  display: flex; align-items: center; justify-content: center;
  color: var(--ad-brand);
}
.ae-vp-play.on { background: var(--ad-brand); border-color: var(--ad-brand); }
.ae-vp-stop { font-size: 9px; color: var(--ad-brand-contrast); line-height: 1; }
.ae-vp-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ae-vp-name { font-size: 12.5px; font-weight: 700; color: var(--ad-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ae-vp-hot {
  align-self: flex-start; font-size: 9.5px; padding: 0 6px; border-radius: 999px;
  background: rgba(251, 191, 36, 0.15); color: var(--ad-warning);
}
.ae-vp-fav { flex: none; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; font-size: 15px; color: var(--ad-text-mut); }
.ae-vp-fav.on { color: var(--ad-warning); }
.ae-vp-empty { width: 100%; padding: 30px 0; text-align: center; font-size: 12.5px; color: var(--ad-text-mut); }
.ae-vp-foot { display: flex; gap: 8px; padding-top: 12px; }
.ae-vp-foot .mbtn { flex: 1; }
</style>
