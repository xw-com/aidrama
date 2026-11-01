<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { voiceApi } from '../api';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '../components/EmptyState.vue';

const { t } = useI18n();

const GENDERS = ['男', '女', '中性'];
// 使用场景目录（供应商音色库顺序），数据里出现的新场景会追加在后面
const SCENES = ['影视解说', '搞笑视频', '角色扮演', '多情感', '方言口音', '通用场景', '视频配音', '社交陪伴', '多语言'];
// 年龄段：text 存 voices.age_range_text，code 存 voices.age_range
const AGES = [
  { code: 1, text: '儿童' },
  { code: 2, text: '少年' },
  { code: 3, text: '青年' },
  { code: 4, text: '中年' },
  { code: 5, text: '老年' },
];

function genderLabel(g) {
  const map = { '男': t('voice.genderMale'), '女': t('voice.genderFemale'), '中性': t('voice.genderNeutral') };
  return map[g] || g || '—';
}
// 展示性别：gender 为空时回退 gender_code（1男 2女，供应商目录字段）
function displayGender(v) {
  return v.gender || (v.gender_code === 1 ? '男' : v.gender_code === 2 ? '女' : '');
}

const list = ref([]);
const loading = ref(false);
const showForm = ref(false);
const editing = ref(null);
const form = ref(emptyForm());
const uploadingId = ref(null);

// 筛选：场景 / 年龄 / 性别 / 名称关键词
const sceneFilter = ref('');
const ageFilter = ref('');
const genderFilter = ref('');
const keyword = ref('');

function emptyForm() {
  return { name: '', gender: '女', scene: '', age: '', emotion_type: '' };
}

async function load() {
  loading.value = true;
  try {
    list.value = await voiceApi.list();
  } finally {
    loading.value = false;
  }
}

// 筛选项从数据派生（与资产页音色选择器一致），场景按目录固定顺序排列
const sceneOptions = computed(() => {
  const fromData = new Set(list.value.map((v) => v.scene).filter(Boolean));
  return [...SCENES.filter((s) => fromData.has(s)), ...[...fromData].filter((s) => !SCENES.includes(s))];
});
const ageOptions = computed(() => [...new Set(list.value.map((v) => v.age_range_text).filter(Boolean))]);

const filtered = computed(() => list.value
  .filter((v) => !sceneFilter.value || v.scene === sceneFilter.value)
  .filter((v) => !ageFilter.value || v.age_range_text === ageFilter.value)
  .filter((v) => !genderFilter.value || displayGender(v) === genderFilter.value)
  .filter((v) => !keyword.value.trim() || (v.name || '').toLowerCase().includes(keyword.value.trim().toLowerCase())));

// 按使用场景分组：目录场景在前、数据新场景居中、未分类垫底
const groups = computed(() => {
  const map = new Map();
  for (const v of filtered.value) {
    const key = v.scene || '';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  }
  const extras = [...map.keys()].filter((s) => s && !SCENES.includes(s)).sort();
  const ordered = [...SCENES.filter((s) => map.has(s)), ...extras, ...(map.has('') ? [''] : [])];
  return ordered.map((scene) => ({ scene, label: scene || t('voice.uncategorized'), items: map.get(scene) }));
});

function resetFilters() {
  sceneFilter.value = '';
  ageFilter.value = '';
  genderFilter.value = '';
  keyword.value = '';
}

function openCreate() {
  editing.value = null;
  form.value = emptyForm();
  showForm.value = true;
}
function openEdit(v) {
  editing.value = v;
  form.value = {
    name: v.name,
    gender: displayGender(v) || '中性',
    scene: v.scene || '',
    age: v.age_range_text || '',
    emotion_type: v.emotion_type === 0 || v.emotion_type === 1 ? v.emotion_type : '',
  };
  showForm.value = true;
}

async function save() {
  if (!form.value.name.trim()) return ElMessage.error(t('voice.nameRequired'));
  const age = AGES.find((a) => a.text === form.value.age);
  // clearable 清空后是 ''，统一归一为 null（服务端 null = 清空分类）
  const emotion = form.value.emotion_type === 0 || form.value.emotion_type === 1 ? form.value.emotion_type : null;
  const payload = {
    name: form.value.name.trim(),
    gender: form.value.gender,
    scene: form.value.scene || null,
    age_range: age ? age.code : null,
    age_range_text: age ? age.text : null,
    emotion_type: emotion,
  };
  if (editing.value) {
    await voiceApi.update(editing.value.id, payload);
    ElMessage.success(t('voice.updated'));
  } else {
    await voiceApi.create(payload);
    ElMessage.success(t('voice.addedUploadHint'));
  }
  showForm.value = false;
  load();
}

async function remove(v) {
  await ElMessageBox.confirm(t('voice.deleteConfirm', { name: v.name }), t('common.tip'), { type: 'warning' });
  await voiceApi.remove(v.id);
  ElMessage.success(t('common.deleteSuccess'));
  load();
}

function beforeAudioUpload(file) {
  const isAudio = file.type && file.type.startsWith('audio/');
  const under25M = file.size / 1024 / 1024 < 25;
  if (!isAudio) ElMessage.error(t('voice.audioOnly'));
  else if (!under25M) ElMessage.error(t('voice.audioTooLarge'));
  return isAudio && under25M;
}
async function customAudioUpload(v, { file }) {
  uploadingId.value = v.id;
  try {
    const updated = await voiceApi.upload(v.id, file);
    const i = list.value.findIndex((x) => x.id === v.id);
    if (i > -1) list.value[i] = updated;
    ElMessage.success(t('voice.audioUploaded'));
  } catch { /* http 拦截器已报错 */ } finally {
    uploadingId.value = null;
  }
}

// 试听互斥：每个卡片是独立 <audio>，播放任意一个时掐停其余
const audioEls = new Map();
function setAudioEl(id, el) {
  if (el) audioEls.set(id, el);
  else audioEls.delete(id);
}
function stopOtherAudio(id) {
  audioEls.forEach((el, key) => { if (key !== id) el.pause(); });
}

onMounted(load);
</script>

<template>
  <div class="ad-page">
    <div class="ad-container" v-loading="loading">
      <div class="ad-flex-between ad-page-head" style="flex-wrap: wrap; gap: 12px;">
        <div>
          <div class="ad-title-lg">{{ t('voice.title') }}</div>
          <div class="ad-sub">{{ t('voice.subtitle') }}</div>
        </div>
        <div class="ad-flex-center ad-gap-sm">
          <el-button type="primary" class="btn-ink" @click="openCreate"><el-icon><Plus /></el-icon> {{ t('voice.addVoice') }}</el-button>
        </div>
      </div>
      <div class="ad-rule vl-rule" />

      <!-- 筛选：名称搜索 + 场景 / 年龄 / 性别 + 重置 -->
      <div class="vl-filters ad-card" v-if="list.length">
        <el-input v-model="keyword" size="large" clearable :prefix-icon="'Search'" :placeholder="t('voice.searchPlaceholder')" class="vl-search" />
        <el-select v-model="sceneFilter" :placeholder="t('voice.sceneAll')" clearable size="large">
          <el-option v-for="s in sceneOptions" :key="s" :label="s" :value="s" />
        </el-select>
        <el-select v-model="ageFilter" :placeholder="t('voice.ageAll')" clearable size="large">
          <el-option v-for="a in ageOptions" :key="a" :label="a" :value="a" />
        </el-select>
        <el-select v-model="genderFilter" :placeholder="t('voice.genderAll')" clearable size="large">
          <el-option v-for="g in GENDERS" :key="g" :label="genderLabel(g)" :value="g" />
        </el-select>
        <el-button size="large" @click="resetFilters">{{ t('voice.resetFilter') }}</el-button>
      </div>

      <!-- 按使用场景分组展示 -->
      <template v-if="list.length">
        <div v-for="g in groups" :key="g.scene || '_none'" class="vl-group">
          <div class="vl-group-head">
            <span class="vl-group-title">{{ g.label }}</span>
            <span class="vl-group-count">{{ g.items.length }}</span>
          </div>
          <div class="voice-grid ad-stagger">
            <div v-for="v in g.items" :key="v.id" class="voice-card ad-card">
              <div class="vc-head ad-flex-between">
                <span class="ad-flex-center ad-gap-sm">
                  <el-icon :size="20"><Microphone /></el-icon>
                  <span class="ad-title">{{ v.name }}</span>
                </span>
                <span class="ad-flex-center" style="gap:6px;">
                  <span v-if="v.age_range_text" class="chip">{{ v.age_range_text }}</span>
                  <span v-if="v.emotion_type === 1" class="chip vl-chip-hot">{{ t('voice.multiEmotion') }}</span>
                  <span class="chip">{{ genderLabel(displayGender(v)) }}</span>
                </span>
              </div>

              <div class="vc-audio">
                <audio
                  v-if="v.audio_url" :src="v.audio_url" controls preload="metadata"
                  :ref="(el) => setAudioEl(v.id, el)"
                  @play="stopOtherAudio(v.id)"
                ></audio>
                <div v-else class="vc-no-audio ad-muted">
                  <el-icon><Headset /></el-icon>
                  <span>{{ t('voice.noAudioSample') }}</span>
                </div>
              </div>

              <div class="vc-ops ad-flex-between">
                <el-upload
                  :show-file-list="false"
                  :auto-upload="true"
                  :before-upload="beforeAudioUpload"
                  :http-request="(opts) => customAudioUpload(v, opts)"
                  accept="audio/*"
                >
                  <el-button size="small" :loading="uploadingId === v.id">
                    <el-icon><Upload /></el-icon> {{ v.audio_url ? t('voice.replaceAudio') : t('voice.uploadAudio') }}
                  </el-button>
                </el-upload>
                <span class="ad-flex-center" style="gap:4px;">
                  <el-button size="small" text @click="openEdit(v)">{{ t('common.edit') }}</el-button>
                  <el-button size="small" text type="danger" @click="remove(v)">{{ t('common.delete') }}</el-button>
                </span>
              </div>
            </div>
          </div>
        </div>
        <div v-if="!filtered.length" class="ad-card vl-no-match ad-muted">{{ t('voice.noMatch') }}</div>
      </template>

      <EmptyState
        v-if="!list.length"
        class="ad-card"
        icon="🎙️"
        :title="t('voice.emptyTitle')"
        :description="t('voice.emptyDesc')"
        :action-label="t('voice.addVoice')"
        @action="openCreate"
      />

      <!-- 表单弹窗 -->
      <el-dialog v-model="showForm" :title="editing ? t('voice.editVoice') : t('voice.addVoice')" width="min(480px, 94vw)">
        <el-form label-position="top">
          <el-form-item :label="t('common.name')">
            <el-input size="large" v-model="form.name" :placeholder="t('voice.namePlaceholder')" />
          </el-form-item>
          <el-form-item :label="t('voice.genderTimbre')">
            <el-select size="large" v-model="form.gender" style="width:100%">
              <el-option v-for="g in GENDERS" :key="g" :label="genderLabel(g)" :value="g" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('voice.sceneLabel')">
            <el-select size="large" v-model="form.scene" :placeholder="t('voice.uncategorized')" clearable style="width:100%">
              <el-option v-for="s in sceneOptions" :key="s" :label="s" :value="s" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('voice.ageLabel')">
            <el-select size="large" v-model="form.age" :placeholder="t('voice.uncategorized')" clearable style="width:100%">
              <el-option v-for="a in AGES" :key="a.code" :label="a.text" :value="a.text" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('voice.emotionLabel')">
            <el-select size="large" v-model="form.emotion_type" :placeholder="t('voice.uncategorized')" clearable style="width:100%">
              <el-option :value="0" :label="t('voice.singleEmotion')" />
              <el-option :value="1" :label="t('voice.multiEmotion')" />
            </el-select>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="showForm = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" class="btn-ink" @click="save">{{ t('common.save') }}</el-button>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
.vl-rule { margin-bottom: 16px; }
.vl-filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 16px; margin-bottom: 20px; }
.vl-filters .el-select { width: 140px; }
.vl-search { flex: 1; min-width: 180px; max-width: 320px; }
.vl-group { margin-bottom: 24px; }
.vl-group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.vl-group-title { font-size: 15px; font-weight: 700; }
.vl-group-count { padding: 0 8px; border-radius: 999px; background: var(--ad-bg-soft); color: var(--ad-text-muted); font-size: 12px; line-height: 20px; font-variant-numeric: tabular-nums; }
.vl-chip-hot { background: var(--ad-brand-soft); color: var(--ad-brand); border-color: transparent; }
.vl-no-match { padding: 40px; text-align: center; }
.voice-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
.voice-card { padding: var(--ad-sp-5) var(--ad-sp-6); display: flex; flex-direction: column; gap: 12px; }
.vc-head { gap: 8px; }
.vc-audio audio { width: 100%; height: 38px; }
.vc-no-audio { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 18px 0; background: var(--ad-bg-soft); border-radius: var(--ad-radius-sm); font-size: 12px; }
.vc-ops { margin-top: 4px; }
@media (max-width: 768px) {
  .voice-grid { grid-template-columns: 1fr; }
  .vl-filters .el-select { width: 100%; }
}
</style>
