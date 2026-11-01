<script setup>
import { ref, computed, nextTick, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { streamAssistantChat } from '../api/assistant.js';

const { t } = useI18n();

const props = defineProps({
  visible: { type: Boolean, default: false },
});
const emit = defineEmits(['update:visible']);

const drawerVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
});

// —— 助手悬浮入口可拖动（pointer 事件区分「拖动」与「点击打开」；位置持久化到 localStorage）——
const FAB_KEY = 'ast-fab-pos';
function restoreFabPos() {
  try {
    const raw = localStorage.getItem(FAB_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.top === 'number') {
      const maxY = Math.max(window.innerHeight - 60, 0);
      return { top: Math.min(Math.max(p.top, 0), maxY) };
    }
  } catch { /* 忽略 */ }
  return null;
}
function saveFabPos(p) {
  try { localStorage.setItem(FAB_KEY, JSON.stringify(p)); } catch { /* 忽略 */ }
}
const fabPos = ref(restoreFabPos());
// 只设顶边 top；水平始终 right:0（由 CSS 控制），垂直居中由 --ty 切换
const fabStyle = computed(() => (fabPos.value ? { top: `${fabPos.value.top}px` } : null));
const drag = reactive({ on: false, moved: false, sy: 0, oy: 0, h: 0 });
function onFabPointerDown(e) {
  if (e.button != null && e.button !== 0) return; // 仅主键
  const rect = e.currentTarget.getBoundingClientRect();
  drag.on = true; drag.moved = false;
  drag.sy = e.clientY; drag.oy = rect.top; drag.h = rect.height;
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
}
function onFabPointerMove(e) {
  if (!drag.on) return;
  const dy = e.clientY - drag.sy;
  if (!drag.moved && Math.abs(dy) > 4) drag.moved = true; // 超过阈值才算拖动
  if (!drag.moved) return;
  const maxY = Math.max(window.innerHeight - drag.h, 0);
  fabPos.value = { top: Math.min(Math.max(drag.oy + dy, 0), maxY) };
}
function onFabPointerUp(e) {
  if (!drag.on) return;
  drag.on = false;
  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
  if (drag.moved) saveFabPos(fabPos.value); // 拖动结束：保存位置，不打开
  else drawerVisible.value = true; // 未拖动 = 点击：打开抽屉
}

const messages = ref([]); // [{ role:'user'|'assistant', content, streaming }]
const input = ref('');
const loading = ref(false);
const listRef = ref(null);
let controller = null;

const QUICK = computed(() => [
  t('chat.quick1'),
  t('chat.quick2'),
  t('chat.quick3'),
  t('chat.quick4'),
]);

const EMPTY = computed(() => messages.value.length === 0);

async function scrollToBottom() {
  await nextTick();
  const el = listRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function stop() {
  if (controller) controller.abort();
}

function clearAll() {
  if (loading.value) return;
  messages.value = [];
}

/** 发送一条消息（text 用于点击快捷提问） */
async function send(text) {
  const content = (text ?? input.value).trim();
  if (!content || loading.value) return;
  input.value = '';

  messages.value.push({ role: 'user', content });
  // 发给后端的历史 = 当前所有已完成消息（刚 push 的 user 在内）
  const history = messages.value
    .filter((m) => m.content && m.content.trim())
    .map(({ role, content }) => ({ role, content }));
  const asstIdx = messages.value.length;
  messages.value.push({ role: 'assistant', content: '', streaming: true });

  loading.value = true;
  controller = new AbortController();
  await scrollToBottom();

  try {
    await streamAssistantChat({
      messages: history,
      signal: controller.signal,
      onDelta: (d) => {
        const m = messages.value[asstIdx];
        if (m) { m.content += d; scrollToBottom(); }
      },
      onError: (msg) => {
        const m = messages.value[asstIdx];
        if (m && !m.content) m.content = t('chat.errorInline', { msg });
        else if (m) m.content += `\n\n${t('chat.errorInline', { msg })}`;
      },
    });
  } catch (e) {
    if (e?.name !== 'AbortError') {
      const m = messages.value[asstIdx];
      if (m) m.content += `\n\n${t('chat.networkErrorInline', { msg: e.message || t('chat.tryLater') })}`;
    }
  } finally {
    const m = messages.value[asstIdx];
    if (m) m.streaming = false;
    loading.value = false;
    controller = null;
    scrollToBottom();
  }
}

/** Enter 发送 / Shift+Enter 换行；中文输入法 composing 期间不触发 */
function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <!-- 收起态：右侧悬浮触发条（浮云图标），点击重新滑出助手 -->
  <div
    v-show="!drawerVisible"
    class="ast-fab"
    :class="{ dragging: drag.on && drag.moved, 'ast-fab-set': fabPos }"
    :style="fabStyle"
    :title="t('chat.openAssistant')"
    @pointerdown="onFabPointerDown"
    @pointermove="onFabPointerMove"
    @pointerup="onFabPointerUp"
    @pointercancel="onFabPointerUp"
  >
    <el-icon class="ast-fab-icon"><ChatDotRound /></el-icon>
    <span class="ast-fab-label">{{ t('chat.assistantName') }}</span>
  </div>

  <el-drawer
    v-model="drawerVisible"
    direction="rtl"
    size="420px"
    :modal="false"
    :lock-scroll="false"
    :with-header="false"
    :append-to-body="true"
    modal-class="ast-overlay"
    class="ast-drawer"
  >
    <div class="ast-root">
      <!-- 头部 -->
      <header class="ast-header">
        <div class="ast-id">
          <div class="ast-avatar">星</div>
          <div class="ast-id-text">
            <div class="ast-name">{{ t('chat.assistantName') }}</div>
            <div class="ast-sub">{{ t('chat.assistantSub') }}</div>
          </div>
        </div>
        <div class="ast-header-actions">
          <button class="ast-icon-btn" :title="t('chat.clear')" :disabled="loading || EMPTY" @click="clearAll">
            <el-icon><Delete /></el-icon>
          </button>
          <button class="ast-close-btn" @click="drawerVisible = false">
            <el-icon><Fold /></el-icon>
            <span>{{ t('nav.collapse') }}</span>
          </button>
        </div>
      </header>

      <!-- 消息列表 -->
      <div ref="listRef" class="ast-body">
        <!-- 空状态 + 快捷提问 -->
        <div v-if="EMPTY" class="ast-empty">
          <div class="ast-empty-logo">星</div>
          <div class="ast-empty-title">{{ t('chat.greeting') }}</div>
          <div class="ast-empty-desc">{{ t('chat.emptyDesc') }}</div>
          <div class="ast-quick">
            <button v-for="q in QUICK" :key="q" class="ast-chip" @click="send(q)">{{ q }}</button>
          </div>
        </div>

        <!-- 对话气泡 -->
        <template v-else>
          <div v-for="(m, i) in messages" :key="i" class="ast-msg" :class="m.role">
            <div v-if="m.role === 'assistant'" class="ast-msg-avatar">星</div>
            <div class="ast-bubble" :class="{ streaming: m.streaming }">
              <template v-if="m.content">{{ m.content }}</template>
              <span v-else class="ast-typing"><i></i><i></i><i></i></span>
              <span v-if="m.streaming && m.content" class="ast-cursor">▌</span>
            </div>
          </div>
        </template>
      </div>

      <!-- 输入区 -->
      <footer class="ast-footer">
        <el-input size="large"
          v-model="input"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 5 }"
          :placeholder="t('chat.inputPlaceholder')"
          resize="none"
          :disabled="loading"
          @keydown="onKeydown"
        />
        <button v-if="!loading" class="ast-send" :disabled="!input.trim()" @click="send()">
          <el-icon><Promotion /></el-icon>
          <span>{{ t('chat.send') }}</span>
        </button>
        <button v-else class="ast-send ast-stop" @click="stop">
          <el-icon><VideoPause /></el-icon>
          <span>{{ t('chat.stop') }}</span>
        </button>
      </footer>
    </div>
  </el-drawer>
</template>

<style scoped>
/* 让 el-drawer body 撑满、无内边距，承载自定义布局 */
.ast-drawer :deep(.el-drawer__body) {
  padding: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.ast-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--ad-bg);
  color: var(--ad-text);
}

/* 头部 */
.ast-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--ad-border);
  background: var(--ad-bg-elevated);
}
.ast-id { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ast-avatar {
  width: 36px; height: 36px; flex: 0 0 auto;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--ad-brand); color: var(--ad-brand-contrast);
  font-size: 16px; font-weight: 800;
  box-shadow: 0 4px 12px var(--ad-brand-soft);
}
.ast-id-text { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }
.ast-name { font-size: 15px; font-weight: 700; color: var(--ad-text); }
.ast-sub { font-size: 12px; color: var(--ad-text-muted); }
.ast-header-actions { display: flex; align-items: center; gap: 4px; }
.ast-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px;
  border: none; background: transparent; cursor: pointer;
  border-radius: var(--ad-radius-sm); color: var(--ad-text-muted);
  font-size: 16px; transition: background 0.15s, color 0.15s;
}
.ast-icon-btn:hover:not(:disabled) { background: var(--ad-bg-soft); color: var(--ad-text); }
.ast-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ast-close-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 12px;
  border: 1px solid var(--ad-border); background: var(--ad-bg-soft);
  border-radius: var(--ad-radius-sm); color: var(--ad-text-soft);
  font-size: 13px; font-weight: 600; cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.ast-close-btn:hover { background: var(--ad-bg-elevated); color: var(--ad-text); border-color: var(--ad-border-strong); }

/* 消息列表 */
.ast-body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 18px 16px;
  display: flex; flex-direction: column; gap: 16px;
}
.ast-msg { display: flex; gap: 8px; align-items: flex-end; }
.ast-msg.user { justify-content: flex-end; }
.ast-msg-avatar {
  width: 28px; height: 28px; flex: 0 0 auto;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--ad-brand); color: var(--ad-brand-contrast);
  font-size: 12px; font-weight: 800;
}
.ast-bubble {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 14px;
  font-size: 14px; line-height: 1.65;
  white-space: pre-wrap; word-break: break-word;
}
.ast-msg.assistant .ast-bubble {
  background: var(--ad-bg-elevated);
  color: var(--ad-text);
  border: 1px solid var(--ad-border);
  border-bottom-left-radius: 4px;
}
.ast-msg.user .ast-bubble {
  background: var(--ad-brand);
  color: var(--ad-brand-contrast);
  border-bottom-right-radius: 4px;
}
.ast-cursor { display: inline-block; margin-left: 1px; animation: ast-blink 1s step-end infinite; color: var(--ad-brand); }
.ast-msg.user .ast-cursor { color: var(--ad-brand-contrast); }
@keyframes ast-blink { 50% { opacity: 0; } }

/* 等待中的三点动画 */
.ast-typing { display: inline-flex; gap: 4px; align-items: center; padding: 2px 0; }
.ast-typing i {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--ad-text-muted);
  animation: ast-dot 1.2s infinite ease-in-out;
}
.ast-typing i:nth-child(2) { animation-delay: 0.2s; }
.ast-typing i:nth-child(3) { animation-delay: 0.4s; }
@keyframes ast-dot { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }

/* 空状态 */
.ast-empty { margin: auto; text-align: center; padding: 20px 8px; }
.ast-empty-logo {
  width: 60px; height: 60px; margin: 0 auto 14px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--ad-brand); color: var(--ad-brand-contrast);
  font-size: 26px; font-weight: 800;
  box-shadow: 0 8px 24px var(--ad-gold-soft);
}
.ast-empty-title { font-size: 17px; font-weight: 700; color: var(--ad-text); }
.ast-empty-desc { font-size: 13px; color: var(--ad-text-muted); margin: 6px 0 16px; }
.ast-quick { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
.ast-chip {
  padding: 10px 14px;
  border: 1px solid var(--ad-border);
  background: var(--ad-bg-elevated);
  color: var(--ad-text-soft);
  border-radius: var(--ad-radius);
  font-size: 13px; cursor: pointer; text-align: left;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.ast-chip:hover { border-color: var(--ad-brand); color: var(--ad-brand); background: var(--ad-bg-soft); }

/* 输入区 */
.ast-footer {
  display: flex; align-items: flex-end; gap: 10px;
  padding: 12px 16px 16px;
  border-top: 1px solid var(--ad-border);
  background: var(--ad-bg-elevated);
}
.ast-footer :deep(.el-textarea__inner) {
  background: var(--ad-bg-soft);
  border-color: var(--ad-border);
  color: var(--ad-text);
  border-radius: var(--ad-radius);
  padding: 9px 12px;
  font-size: 14px; line-height: 1.5;
  box-shadow: none;
}
.ast-footer :deep(.el-textarea__inner:focus) { border-color: var(--ad-brand); box-shadow: none; }
.ast-send {
  display: inline-flex; align-items: center; gap: 5px;
  height: 36px; padding: 0 16px; flex: 0 0 auto;
  border: none; border-radius: var(--ad-radius-sm);
  background: var(--ad-brand); color: var(--ad-brand-contrast);
  font-size: 14px; font-weight: 600; cursor: pointer;
  transition: opacity 0.15s, transform 0.05s;
}
.ast-send:hover:not(:disabled) { opacity: 0.92; }
.ast-send:active:not(:disabled) { transform: translateY(1px); }
.ast-send:disabled { opacity: 0.5; cursor: not-allowed; }
.ast-send.ast-stop { background: var(--ad-text-soft); }

/* 右侧悬浮触发条（助手收起态的「浮云」入口） */
.ast-fab {
  position: fixed;
  right: 0;
  top: 50%;
  --tx: 0px;
  --ty: -50%;
  transform: translate(var(--tx), var(--ty));
  z-index: 1500;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 8px;
  border: 1px solid var(--ad-brand);
  border-right: none;
  border-radius: var(--ad-radius) 0 0 var(--ad-radius);
  background: var(--ad-brand);
  color: var(--ad-brand-contrast);
  cursor: grab;
  box-shadow: var(--ad-shadow-md);
  user-select: none;
  touch-action: none;
  transition: filter 0.15s ease, transform 0.15s ease;
}
.ast-fab:hover { filter: brightness(1.06); --tx: -2px; }
.ast-fab.ast-fab-set { --ty: 0px; } /* 拖动后：顶边对齐 top，不再垂直居中 */
.ast-fab.dragging { cursor: grabbing; transition: none; }
.ast-fab-icon { font-size: 20px; }
.ast-fab-label {
  writing-mode: vertical-rl;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 2px;
  line-height: 1;
}

/* 响应式：窄屏收窄 */
@media (max-width: 640px) {
  .ast-drawer :deep(.el-drawer.rtl) { width: 100% !important; }
}
/* 手机端（≤768px）隐藏右侧浮云触发条（星网助理不适配手机，与侧栏「使用帮助」入口一致） */
@media (max-width: 768px) {
  .ast-fab { display: none; }
}
</style>

<!-- 全局：非模态抽屉——让背后页面可点击，overlay 不拦截事件，仅抽屉面板可交互 -->
<style>
.ast-overlay.el-overlay { pointer-events: none; background: transparent; }
.ast-overlay .el-drawer { pointer-events: auto; }
</style>
