<script setup>
import { onMounted, ref, reactive, computed, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { projectApi, artStyleApi, memberApi } from '../api';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '../stores/auth';
import { useCostAction } from '../composables/useCostAction';
import EmptyState from '../components/EmptyState.vue';
import ArtStylePicker from '../components/ArtStylePicker.vue';
import MemberManagerDialog from '../components/MemberManagerDialog.vue';
import CoverMaterialsDialog from '../components/CoverMaterialsDialog.vue';

const router = useRouter();
const route = useRoute();
const { t } = useI18n();
const auth = useAuthStore();
const list = ref([]);
const loading = ref(false);
const showDialog = ref(false);
const formMode = ref('create'); // 'create' | 'edit'
const editingId = ref(null);
const submitting = ref(false);
const form = reactive({ name: '', style: '', aspect_ratio: '9:16', cover: '', producer: '', copyright: '', narrative_type: '' });
// 项目封面：coverFile 为本次新选的文件（提交时上传），coverPreviewUrl 为本地预览
const coverFile = ref(null);
const coverPreviewUrl = ref('');
const coverImg = computed(() => coverPreviewUrl.value || form.cover || '');
function adoptCoverFile(f) {
  coverFile.value = f;
  if (coverPreviewUrl.value) URL.revokeObjectURL(coverPreviewUrl.value);
  coverPreviewUrl.value = URL.createObjectURL(f);
}
function onCoverChange(file) {
  if (file.raw) adoptCoverFile(file.raw);
}
// 已有封面时点击封面 = 大图预览（el-image），上传入口移至「上传封面」按钮（隐藏 input 兜底触发）
const coverInputEl = ref(null);
function pickCoverFile() {
  coverInputEl.value?.click();
}
function onCoverInput(e) {
  const f = e.target.files?.[0];
  if (f) adoptCoverFile(f);
  e.target.value = '';
}
function clearCover() {
  coverFile.value = null;
  if (coverPreviewUrl.value) { URL.revokeObjectURL(coverPreviewUrl.value); coverPreviewUrl.value = ''; }
  form.cover = '';
}

const dialogTitle = computed(() => (formMode.value === 'create' ? t('project.newProject') : t('project.editProject')));
const submitText = computed(() => (formMode.value === 'create' ? t('project.submitCreate') : t('project.submitSave')));

// —— AI 生成封面（仅编辑态：新项目尚无分镜/资产/剧本素材）——
// 两步确认：① 素材选择弹窗（角色/场景/道具多选，默认勾选出镜最多的一个；可附一句描述）
//          ② 统一「模型+价格」确认页；缺素材由后端预检报错提示
const { runJob } = useCostAction();
const coverAiChecking = ref(false);
const coverMaterials = ref(null); // 候选素材（按出镜次数降序，首项即默认勾选）
const coverPickVisible = ref(false);
async function aiCover() {
  if (!editingId.value || coverAiChecking.value) return;
  coverAiChecking.value = true;
  try {
    coverMaterials.value = await projectApi.coverAiMaterials(editingId.value);
    coverPickVisible.value = true;
  } catch {
    return; // 缺分镜/资产图片/剧本概要：拦截器已提示
  } finally {
    coverAiChecking.value = false;
  }
}
async function onCoverPicks(picks) {
  coverPickVisible.value = false;
  const job = await runJob({
    modelType: 'image',
    selection: {},
    estimateFor: (sel) => projectApi.coverAiEstimate(editingId.value, sel.modelConfigId),
    createFor: (sel) => projectApi.coverAi(editingId.value, sel.modelConfigId, picks).then((data) => ({ job: data.job })),
    title: t('project.aiCoverButton'),
    desc: form.name,
    onDone: (j) => {
      if (j.status === 'succeeded' && j.result?.cover_url) {
        // 弹窗还开着：预览切到新封面（已选的本地文件让位）；关了则只刷列表
        form.cover = j.result.cover_url;
        coverFile.value = null;
        if (coverPreviewUrl.value) {
          URL.revokeObjectURL(coverPreviewUrl.value);
          coverPreviewUrl.value = '';
        }
      }
      load();
    },
  });
  if (job) ElMessage.success(t('project.aiCoverQueued'));
}

// 美术风格列表（仅用于项目卡片上「风格 key → 中文名」展示；选择器见 ArtStylePicker 组件）
const artStyles = ref([]);
const styleNameMap = computed(() => {
  const m = {};
  artStyles.value.forEach((s) => { m[s.key] = s.name; });
  return m;
});
const styleName = (key) => styleNameMap.value[key] || key;

// 叙事类型（与后端 NARRATIVE_TYPES 一致；复用 script.genre.* 译文，与剧本创作页保持统一）
const NARRATIVE_TYPES = computed(() => [
  { key: 'Sweet_romance_novel', name: t('script.genre.Sweet_romance_novel') },
  { key: 'Urban_workplace_drama', name: t('script.genre.Urban_workplace_drama') },
  { key: 'Xianxia_fantasy', name: t('script.genre.Xianxia_fantasy') },
  { key: 'Comedy_humor', name: t('script.genre.Comedy_humor') },
  { key: 'Mystery_thriller', name: t('script.genre.Mystery_thriller') },
  { key: 'Hot_blooded_action', name: t('script.genre.Hot_blooded_action') },
  { key: 'Coming_of_age', name: t('script.genre.Coming_of_age') },
  { key: 'Family_warmth', name: t('script.genre.Family_warmth') },
  { key: 'Historical_epic', name: t('script.genre.Historical_epic') },
  { key: 'Psychological_drama', name: t('script.genre.Psychological_drama') },
  { key: 'Horror_supernatural', name: t('script.genre.Horror_supernatural') },
  { key: 'Scifi_post_apocalypse', name: t('script.genre.Scifi_post_apocalypse') },
]);

async function loadStyles() {
  try { artStyles.value = await artStyleApi.list(); } catch { /* ignore */ }
}

async function load() {
  loading.value = true;
  try {
    list.value = await projectApi.list();
  } finally {
    loading.value = false;
  }
}

// 新建项目默认风格：都市影像（列表未加载或不含该 key 时回退第一项）
const DEFAULT_STYLE_KEY = 'realpeople_modern_city';

function openCreate() {
  formMode.value = 'create';
  editingId.value = null;
  form.name = '';
  form.style = artStyles.value.some((s) => s.key === DEFAULT_STYLE_KEY)
    ? DEFAULT_STYLE_KEY
    : (artStyles.value[0]?.key || '');
  form.aspect_ratio = '9:16';
  form.cover = '';
  form.producer = '';
  form.copyright = '';
  form.narrative_type = '';
  coverFile.value = null;
  if (coverPreviewUrl.value) { URL.revokeObjectURL(coverPreviewUrl.value); coverPreviewUrl.value = ''; }
  showDialog.value = true;
}

function openEdit(p) {
  formMode.value = 'edit';
  editingId.value = p.id;
  form.name = p.name;
  form.style = p.style;
  form.aspect_ratio = p.aspect_ratio;
  form.cover = p.cover || '';
  form.producer = p.producer || '';
  form.copyright = p.copyright || '';
  form.narrative_type = p.narrative_type || '';
  coverFile.value = null;
  if (coverPreviewUrl.value) { URL.revokeObjectURL(coverPreviewUrl.value); coverPreviewUrl.value = ''; }
  showDialog.value = true;
}

async function submit() {
  if (!form.name.trim()) return ElMessage.warning(t('project.nameRequired'));
  if (!form.style) return ElMessage.warning(t('project.styleRequired'));
  submitting.value = true;
  try {
    if (formMode.value === 'create') {
      const p = await projectApi.create({ name: form.name, style: form.style, aspect_ratio: form.aspect_ratio, producer: form.producer, copyright: form.copyright, narrative_type: form.narrative_type || null });
      if (coverFile.value) await projectApi.uploadCover(p.id, coverFile.value);
      showDialog.value = false;
      ElMessage.success(t('project.created'));
      router.push(`/projects/${p.id}`);
    } else {
      // 始终回传封面：clearCover 置空串才能真删（服务端白名单按 !== undefined 收 cover）；
      // 未动封面时回传原值幂等，新文件仍由下方 uploadCover 覆盖
      await projectApi.update(editingId.value, { name: form.name, style: form.style, aspect_ratio: form.aspect_ratio, producer: form.producer, copyright: form.copyright, narrative_type: form.narrative_type || null, cover: form.cover || '' });
      if (coverFile.value) await projectApi.uploadCover(editingId.value, coverFile.value);
      showDialog.value = false;
      ElMessage.success(t('project.updated'));
      load();
    }
  } finally {
    submitting.value = false;
  }
}

async function remove(p) {
  await ElMessageBox.confirm(t('project.deleteConfirm', { name: p.name }), t('project.deleteProject'), { type: 'warning' });
  await projectApi.remove(p.id);
  ElMessage.success(t('common.deleteSuccess'));
  load();
}

const STATUS_PCT = { outline: 33, assets: 66, video: 90, done: 100 };
// 项目状态 → 工作区步骤：打开项目时精准直达当前阶段对应页签（资产库状态 → 资产库，而非自动推断的分集视频）
const STATUS_STEP = { outline: '1', assets: '2', video: '3', done: '3' };
function openProject(p) {
  const step = STATUS_STEP[p.status];
  router.push(step ? `/projects/${p.id}?step=${step}` : `/projects/${p.id}`);
}
const statusLabel = (code) => {
  if (!code) return '';
  return ({
    outline: t('project.status.outline'),
    assets: t('project.status.assets'),
    video: t('project.status.video'),
    done: t('project.status.done'),
  })[code] || code;
};

const COVER_PALETTES = [
  'linear-gradient(135deg,#667eea,#764ba2)', 'linear-gradient(135deg,#f093fb,#f5576c)',
  'linear-gradient(135deg,#4facfe,#00f2fe)', 'linear-gradient(135deg,#43e97b,#38f9d7)',
  'linear-gradient(135deg,#fa709a,#fee140)', 'linear-gradient(135deg,#30cfd0,#330867)',
];
function coverBg(id) {
  return COVER_PALETTES[((id - 1) % COVER_PALETTES.length + COVER_PALETTES.length) % COVER_PALETTES.length];
}

// —— 团队共享 ——
const isOwner = (p) => p.my_role === 'owner';
const memberDialogVisible = ref(false);
const memberProjectId = ref(null);
function openMembers(p) {
  memberProjectId.value = p.id;
  memberDialogVisible.value = true;
}

// 成员自助退出共享项目
async function leaveProject(p) {
  try {
    await ElMessageBox.confirm(t('team.leaveConfirm', { name: p.name }), t('team.leave'), { type: 'warning' });
  } catch { return; } // 用户取消
  await memberApi.leave(p.id);
  ElMessage.success(t('team.left'));
  load();
}

onMounted(() => {
  loadStyles();
  load();
});

// 邀请中心接受邀请后带 refresh 时间戳跳转回来：当前页已挂载，靠 query 变化重载列表（否则 toast 说已加入、页面却还是空态）
watch(() => route.query.refresh, (v) => { if (v) load(); });
</script>

<template>
  <div class="ad-page">
    <div class="ad-container">
      <div class="ad-page-head ad-flex-between" style="flex-wrap: wrap; gap: 12px;">
        <div>
          <div class="ad-title-lg ad-title">{{ t('project.title') }}</div>
          <div class="ad-sub">{{ t('project.welcome', { name: auth.displayName }) }}</div>
        </div>
        <el-button type="primary" class="btn-ink" size="large" @click="openCreate">
          <el-icon><Plus /></el-icon> {{ t('project.newProject') }}
        </el-button>
      </div>
      <hr class="ad-rule" style="margin: 0 0 20px;" />

      <div v-loading="loading" class="grid ad-stagger" :class="{ 'grid-empty': !loading && !list.length }">
        <div v-for="p in list" :key="p.id" class="proj-card ad-card" @click="openProject(p)">
          <div class="cover" :style="p.cover ? {} : { background: coverBg(p.id) }">
            <img v-if="p.cover" :src="p.cover_thumb || p.cover" class="cover-img" loading="lazy" decoding="async" :alt="t('project.coverAlt')" />
            <span v-else class="cover-emoji">🎬</span>
            <span class="chip chip-accent aspect">{{ p.aspect_ratio }}</span>
          </div>
          <div class="body">
            <div class="ad-flex-between">
              <div class="ad-title ellipsis">{{ p.name }}</div>
              <el-dropdown trigger="click" placement="bottom-end">
                <div class="more" @click.stop>
                  <el-icon><MoreFilled /></el-icon>
                </div>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click="openProject(p)">{{ t('project.openProject') }}</el-dropdown-item>
                    <template v-if="isOwner(p)">
                      <el-dropdown-item @click="openEdit(p)">{{ t('project.editProject') }}</el-dropdown-item>
                      <el-dropdown-item @click="openMembers(p)">{{ t('team.manageMembers') }}</el-dropdown-item>
                      <el-dropdown-item divided @click="remove(p)">{{ t('project.deleteProject') }}</el-dropdown-item>
                    </template>
                    <el-dropdown-item v-else divided @click="leaveProject(p)">{{ t('team.leave') }}</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
            <!-- 共享项目：标注创建者（本项目是他人创建并邀请我加入的） -->
            <div v-if="p.shared" class="shared-line">
              <el-icon><Share /></el-icon>
              <span>{{ t('team.shared') }} · {{ p.owner_name }}</span>
            </div>
            <div class="ad-sub ellipsis">{{ t('project.styleLabel') }} · {{ styleName(p.style) }}</div>
            <div v-if="p.producer || p.copyright" class="meta-line">
              <span v-if="p.producer">{{ t('project.producerLabel') }} · {{ p.producer }}</span>
              <span v-if="p.copyright">{{ t('project.copyrightLabel') }} · {{ p.copyright }}</span>
            </div>
            <div class="ad-flex-between" style="margin-top: 10px;">
              <span class="chip">
                {{ t('project.episodes', { count: p.episode_count || 0 }) }}
                <span v-if="p.my_role === 'member' && !(p.my_permissions && p.my_permissions.length)" class="chip-ro">{{ t('team.readonlyTag') }}</span>
              </span>
              <!-- 状态徽标即精准入口：点击直达当前阶段页签（如「资产库」→ 资产库步骤） -->
              <span
                class="chip chip-link"
                :class="p.status === 'done' ? 'chip-success' : 'chip-accent'"
                :title="statusLabel(p.status)"
                @click.stop="openProject(p)"
              >{{ statusLabel(p.status) }}</span>
            </div>
            <el-progress :percentage="STATUS_PCT[p.status] || 0" :show-text="false" :stroke-width="4" style="margin-top: 12px;" />
          </div>
        </div>

        <EmptyState
          v-if="!loading && !list.length"
          class="ad-card"
          icon="🎞️"
          :title="t('project.emptyTitle')"
          :description="t('project.emptyDesc')"
          :action-label="t('project.newProject')"
          @action="openCreate"
        >
          <template #action-icon><el-icon><Plus /></el-icon></template>
          <template #extra>
            <span class="es-script-lead">{{ t('project.emptyScriptLead') }}</span>
            <el-button text type="primary" class="es-script-link" @click="router.push('/script-writer')">
              {{ t('project.emptyScriptCta') }}
              <el-icon class="el-icon--right"><ArrowRight /></el-icon>
            </el-button>
          </template>
        </EmptyState>
      </div>
    </div>

    <el-dialog v-model="showDialog" :title="dialogTitle" width="min(720px, 94vw)" top="4vh" class="proj-dialog">
      <!-- 表单排版对齐剧本创作页「导出项目」步骤：弱化小标题（ad-sub ad-muted）+ 区块间距 -->
      <div class="proj-form">
        <div class="proj-field">
          <label class="ad-sub ad-muted">{{ t('project.name') }}</label>
          <el-input size="large" v-model="form.name" :placeholder="t('project.namePlaceholder')" maxlength="40" show-word-limit />
        </div>
        <!-- 编辑态：封面 + 制作人/版权 同行排布，压缩纵向高度（封面盒 2:3 竖版，右侧两栏输入） -->
        <div v-if="formMode === 'edit'" class="meta-row">
          <div class="proj-field">
            <label class="ad-sub ad-muted">{{ t('project.coverLabel') }}</label>
            <div class="cover-uploader">
              <el-upload v-if="!coverImg" :show-file-list="false" :auto-upload="false" accept="image/*" :on-change="onCoverChange">
                <div class="cover-up-box">
                  <el-icon class="cover-up-icon"><Plus /></el-icon>
                  <span class="ad-sub" style="font-size:12px;">{{ t('project.uploadCover') }}</span>
                </div>
              </el-upload>
              <!-- 已有封面：点击进 el-image 大图预览（teleport 出弹窗避免裁剪），上传走下方按钮 -->
              <div v-else class="cover-up-box cover-up-view">
                <el-image :src="coverImg" fit="cover" class="cover-up-img" :alt="t('project.coverPreviewAlt')"
                  :preview-src-list="[coverImg]" preview-teleported hide-on-click-modal />
              </div>
              <input ref="coverInputEl" type="file" accept="image/*" hidden @change="onCoverInput">
              <div class="cover-actions">
                <el-button v-if="coverImg" size="small" @click="pickCoverFile">{{ t('project.uploadCover') }}</el-button>
                <el-button size="small" :loading="coverAiChecking" :title="t('project.aiCoverHint')" @click="aiCover">
                  <el-icon><MagicStick /></el-icon> {{ t('project.aiCoverButton') }}
                </el-button>
                <el-button v-if="coverImg" link type="danger" size="small" @click="clearCover">{{ t('project.removeCover') }}</el-button>
              </div>
            </div>
          </div>
          <div class="meta-col">
            <div class="proj-field">
              <label class="ad-sub ad-muted">{{ t('project.producerLabel') }}</label>
              <el-input size="large" v-model="form.producer" :placeholder="t('project.producerPlaceholder')" maxlength="64" />
            </div>
            <div class="proj-field">
              <label class="ad-sub ad-muted">{{ t('project.copyrightLabel') }}</label>
              <el-input size="large" v-model="form.copyright" :placeholder="t('project.copyrightPlaceholder')" maxlength="128" />
            </div>
          </div>
        </div>
        <div class="proj-field">
          <label class="ad-sub ad-muted">{{ t('project.narrativeType') }}</label>
          <el-select class="narrative-select" v-model="form.narrative_type" :placeholder="t('project.narrativeTypePlaceholder')" clearable size="large" style="width: 100%;">
            <el-option v-for="n in NARRATIVE_TYPES" :key="n.key" :label="n.name" :value="n.key" />
          </el-select>
          <div class="ad-muted ad-sub proj-field-hint">{{ t('project.narrativeTypeHint') }}</div>
        </div>
        <div class="proj-field">
          <label class="ad-sub ad-muted">{{ t('project.visualStyle') }}</label>
          <ArtStylePicker
            v-model="form.style"
            v-model:aspect="form.aspect_ratio"
            default-style="realpeople_modern_city"
            :hint="t('project.styleHint')"
            expand
          />
        </div>
      </div>
      <template #footer>
        <el-button @click="showDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" class="btn-ink" :loading="submitting" @click="submit">{{ submitText }}</el-button>
      </template>
    </el-dialog>

    <!-- 成员管理（团队共享，owner 专属） -->
    <MemberManagerDialog v-model="memberDialogVisible" :project-id="memberProjectId" />

    <!-- 封面素材选择（AI 生成封面第一步：多选角色/场景/道具 + 补充描述） -->
    <CoverMaterialsDialog v-model="coverPickVisible" :materials="coverMaterials" @confirm="onCoverPicks" />
  </div>
</template>

<style scoped>
/* 窄屏下对话框不出屏 */
:deep(.proj-dialog) { max-width: calc(100vw - 24px); }
/* 长内容（风格网格全展开）时弹窗体内部滚动，同剧本创作页「导出项目」的滚动区 */
:deep(.proj-dialog .el-dialog__body) { max-height: calc(92vh - 170px); overflow-y: auto; }
/* 主区域纵向撑满：页面 → 容器 → 网格逐级拉伸，空状态时卡片顶到底部 */
.ad-page { display: flex; flex-direction: column; }
/* 与任务中心/积分中心一致：theme.scss 默认 max-width 1200px 居中 + padding 24px。
   注意：父级 .ad-page 是 flex 列容器，而 .ad-container 自带 margin:0 auto——flex 子项 cross 轴 auto margin 会使 stretch 失效、按内容收缩，
   故必须显式 width:100% + border-box（content-box 叠加 padding 会横向溢出） */
.ad-container { flex: 1; width: 100%; box-sizing: border-box; display: flex; flex-direction: column; min-width: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 18px; }
/* 无项目时网格吃掉剩余高度，EmptyState 卡片随网格撑满（内容垂直居中） */
.grid-empty { flex: 1; }
/* 主区域（空状态卡片）「新建项目」主按钮放大：更高更宽，宽度不收窄 */
:deep(.es-action) {
  height: 56px;
  min-width: 260px;
  padding: 0 40px;
  font-size: 17px;
  font-weight: 700;
  border-radius: 14px;
}
:deep(.es-action .el-icon) { font-size: 20px; }
/* 空状态「没有剧本？」引导文案，与「试试 AI 剧本创作」链接同行 */
.es-script-lead { font-size: 13px; color: var(--ad-text-soft); margin-right: 6px; }
:deep(.es-script-link) { vertical-align: middle; }
.proj-card { cursor: pointer; overflow: hidden; transition: all 0.18s; }
.proj-card:hover { box-shadow: var(--ad-shadow-hover); transform: translateY(-2px); }
.cover { height: 130px; display: flex; align-items: center; justify-content: center; position: relative; }
.cover-emoji { font-size: 44px; filter: drop-shadow(0 2px 6px rgba(0,0,0,0.2)); }
.aspect { position: absolute; top: 10px; right: 10px; }
.body { padding: 14px 16px 16px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.more { cursor: pointer; color: var(--ad-text-muted); display: inline-flex; align-items: center; justify-content: center; padding: 4px; border-radius: 6px; transition: background 0.18s, color 0.18s; }
.more:hover { background: var(--ad-bg-soft); color: var(--ad-text); }
.more:focus-visible { outline: 2px solid var(--ad-accent); outline-offset: 1px; }
/* 状态徽标可点击：悬停浮起提示可直达对应阶段 */
.chip-link { cursor: pointer; transition: box-shadow 0.18s, transform 0.18s; }
.chip-link:hover { box-shadow: 0 2px 8px var(--ad-brand-soft); transform: translateY(-1px); }
.empty { grid-column: 1 / -1; text-align: center; padding: 56px 20px; }
.empty-emoji { font-size: 48px; margin-bottom: 8px; }

/* 项目封面 / 制作人 / 版权 */
.cover-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.meta-line { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; margin-top: 4px; color: var(--ad-text-muted); }
/* 共享给我的项目：创建者标注行 */
.shared-line { display: flex; align-items: center; gap: 4px; font-size: 12px; margin-top: 4px; color: var(--ad-brand); font-weight: 600; }
.shared-line .el-icon { font-size: 13px; }
/* 只读成员的「只读」小标（嵌在集数 chip 内） */
.chip-ro { margin-left: 6px; padding: 0 5px; border-radius: 8px; background: var(--ad-bg-soft); color: var(--ad-text-muted); font-size: 11px; }
/* 表单排版对齐剧本创作页「导出项目」：区块间距 14px、弱化小标题距控件 6px */
.proj-form { display: flex; flex-direction: column; gap: 14px; }
.proj-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
/* 叙事风格下拉：比常规 large 更高一些，与视觉风格选择器视觉分量匹配 */
.narrative-select :deep(.el-select__wrapper) { min-height: 48px; font-size: 15px; }
/* 编辑态元信息行：封面盒 + 右侧制作人/版权两栏 */
.meta-row { display: flex; gap: 20px; align-items: flex-start; }
.meta-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.cover-uploader { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.cover-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; justify-content: center; }
.cover-up-box {
  width: 132px; height: 198px; /* 2:3 竖版，与 AI 封面出图比例一致（横版上传图居中裁切显示） */
  border: 2px dashed var(--ad-border-strong);
  border-radius: var(--ad-radius);
  overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  cursor: pointer;
  background: var(--ad-bg-soft);
  transition: border-color 0.18s;
}
.cover-up-box:hover { border-color: var(--ad-accent); }
.cover-up-view { cursor: zoom-in; }
.cover-up-img { display: block; width: 100%; height: 100%; object-fit: cover; }
.cover-up-icon { font-size: 22px; color: var(--ad-text-muted); }
</style>
