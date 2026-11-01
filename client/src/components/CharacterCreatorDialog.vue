<script setup>
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { characterOptionApi } from '../api';
import { ElMessage } from 'element-plus';

/**
 * 角色自定义弹窗（纯表单哑组件）：点选外貌/人设选项 + 自由描述，
 * confirm 后由父组件走统一「模型+价格」确认页提交创建任务。
 * 选项注册表来自 GET /character-options（含预览图 URL，未生成为 null 显示占位）。
 */
const visible = defineModel({ type: Boolean, default: false });
const emit = defineEmits(['confirm']);
const props = defineProps({
  projectId: [String, Number],
  submitting: { type: Boolean, default: false },
});
const { t, te } = useI18n();

const loading = ref(false);
const groups = ref([]);
const name = ref('');
const freeText = ref('');
const selections = ref({});

// 注册表会话级缓存：内容稳定（只有预览图 URL 的版本号会变），重复打开不重复拉取
let registryCache = null;

// i18n 缺失回退：任何语言缺 key 时显示服务端下发的中文 label，而非 key 路径
const label = (keyPath, zh) => (te(keyPath) ? t(keyPath) : zh);

const genderOptions = computed(() => groups.value.find((g) => g.key === 'gender')?.options || []);

// 按当前性别过滤后的分组（性别组单独渲染；无匹配选项的组隐藏，如男性时隐藏「胸」组）
const visibleGroups = computed(() => {
  const g = selections.value.gender;
  return groups.value
    .filter((x) => x.key !== 'gender')
    .map((x) => ({ ...x, options: x.options.filter((o) => !g || (o.genders || []).includes(g)) }))
    .filter((x) => x.options.length > 0);
});

watch(visible, async (v) => {
  if (!v) return;
  name.value = '';
  freeText.value = '';
  selections.value = {};
  if (registryCache) { groups.value = registryCache; return; }
  loading.value = true;
  try {
    const data = await characterOptionApi.options();
    registryCache = data.groups || [];
    groups.value = registryCache;
  } finally {
    loading.value = false;
  }
});

// 性别切换：清掉与新性别不兼容的已选项（如女性发型/胸围）
watch(() => selections.value.gender, (g) => {
  if (!g) return;
  for (const grp of groups.value) {
    if (grp.key === 'gender') continue;
    const cur = grp.options.find((o) => o.key === selections.value[grp.key]);
    if (cur && !(cur.genders || []).includes(g)) delete selections.value[grp.key];
  }
});

function selectGender(key) {
  selections.value.gender = key; // 必选项：点换即设，不可取消
}

function pickOption(groupKey, option) {
  if (selections.value[groupKey] === option.key) delete selections.value[groupKey]; // 再点取消
  else selections.value[groupKey] = option.key;
}

function onConfirm() {
  if (!selections.value.gender) return ElMessage.warning(t('charCreator.genderRequired'));
  emit('confirm', {
    name: name.value.trim(),
    selections: { ...selections.value },
    freeText: freeText.value.trim(),
  });
}
</script>

<template>
  <el-dialog v-model="visible" :title="t('charCreator.title')" width="min(1080px, 94vw)" top="4vh" class="char-creator-dialog">
    <div class="cc-body" v-loading="loading">
      <!-- 性别（必选） -->
      <div class="cc-section">
        <div class="cc-group-title">
          {{ label('charCreator.group.gender', '性别') }}<span class="cc-required">*</span>
        </div>
        <div class="cc-gender-row">
          <div
            v-for="o in genderOptions" :key="o.key"
            class="cc-gender-card ad-card" :class="{ active: selections.gender === o.key }"
            @click="selectGender(o.key)"
          >
            <div class="cc-opt-img">
              <img v-if="o.preview" :src="o.preview" :alt="label(`charCreator.option.gender.${o.key}`, o.zh)" />
              <div v-else class="cc-placeholder">{{ label(`charCreator.option.gender.${o.key}`, o.zh) }}</div>
              <div v-if="selections.gender === o.key" class="cc-check"><el-icon><Check /></el-icon></div>
            </div>
            <div class="cc-opt-label">{{ label(`charCreator.option.gender.${o.key}`, o.zh) }}</div>
          </div>
        </div>
      </div>

      <!-- 外貌/人设选项组 -->
      <div v-for="g in visibleGroups" :key="g.key" class="cc-section">
        <div class="cc-group-title">
          {{ label(`charCreator.group.${g.key}`, g.zh) }}
          <span class="cc-optional">{{ t('charCreator.optional') }}</span>
        </div>
        <div class="cc-grid">
          <div
            v-for="o in g.options" :key="o.key"
            class="cc-card ad-card" :class="{ active: selections[g.key] === o.key }"
            @click="pickOption(g.key, o)"
          >
            <div class="cc-opt-img">
              <img v-if="o.preview" :src="o.preview" loading="lazy" :alt="label(`charCreator.option.${g.key}.${o.key}`, o.zh)" />
              <div v-else class="cc-placeholder">{{ label(`charCreator.option.${g.key}.${o.key}`, o.zh) }}</div>
              <div v-if="selections[g.key] === o.key" class="cc-check"><el-icon><Check /></el-icon></div>
            </div>
            <div class="cc-opt-label">{{ label(`charCreator.option.${g.key}.${o.key}`, o.zh) }}</div>
          </div>
        </div>
      </div>

      <!-- 名称与自由描述 -->
      <div class="cc-section">
        <el-form label-position="top" class="cc-form">
          <el-form-item :label="t('charCreator.nameLabel')">
            <el-input size="large" v-model="name" :placeholder="t('charCreator.namePlaceholder')" maxlength="64" />
          </el-form-item>
          <el-form-item :label="t('charCreator.freeTextLabel')">
            <el-input
              v-model="freeText" type="textarea" :rows="3" maxlength="500" show-word-limit
              :placeholder="t('charCreator.freeTextPlaceholder')"
            />
          </el-form-item>
        </el-form>
      </div>
    </div>
    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" class="btn-ink" :disabled="!selections.gender" :loading="props.submitting" @click="onConfirm">
        {{ t('charCreator.confirmText') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.cc-body { max-height: 64vh; overflow-y: auto; padding-right: 4px; }
.cc-section { margin-bottom: 20px; }
.cc-section:last-child { margin-bottom: 0; }

.cc-group-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 14px; font-weight: 700; margin-bottom: 10px;
}
.cc-required { color: var(--el-color-danger); }
.cc-optional {
  font-size: 12px; font-weight: 500; color: var(--ad-text-muted);
  padding: 1px 8px; border-radius: 999px; background: var(--ad-bg-soft);
}

/* 性别大卡 */
.cc-gender-row { display: grid; grid-template-columns: repeat(2, minmax(0, 220px)); gap: 12px; }
.cc-gender-card {
  cursor: pointer; border: 2px solid transparent; transition: all 0.15s; overflow: hidden;
}
.cc-gender-card:hover { box-shadow: var(--ad-shadow-hover); transform: translateY(-1px); }
.cc-gender-card.active { border-color: var(--ad-brand); }

/* 选项卡片网格 */
.cc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 10px; }
.cc-card {
  cursor: pointer; border: 2px solid transparent; transition: all 0.15s; overflow: hidden;
  display: flex; flex-direction: column;
}
.cc-card:hover { box-shadow: var(--ad-shadow-hover); transform: translateY(-1px); }
.cc-card.active { border-color: var(--ad-brand); }

.cc-opt-img {
  position: relative; width: 100%; aspect-ratio: 16 / 9; overflow: hidden;
  background: var(--ad-bg-soft);
}
.cc-opt-img img { width: 100%; height: 100%; object-fit: cover; display: block; }

/* 预览图未生成时的占位（渐变底 + label） */
.cc-placeholder {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  padding: 6px; text-align: center;
  font-size: 12px; font-weight: 600; color: var(--ad-text-muted);
  background: linear-gradient(135deg, var(--ad-brand-soft), var(--ad-bg-soft));
}

/* 选中角标 */
.cc-check {
  position: absolute; top: 6px; right: 6px;
  width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--ad-brand); color: var(--ad-brand-contrast);
  box-shadow: var(--ad-shadow-lg);
}

.cc-opt-label {
  padding: 6px 8px; font-size: 13px; font-weight: 600; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.cc-form { margin-top: 4px; }

/* ===== 响应式 ===== */
@media (max-width: 768px) {
  .cc-gender-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cc-grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; }
  .cc-opt-label { font-size: 12px; padding: 4px 6px; }
}
</style>
