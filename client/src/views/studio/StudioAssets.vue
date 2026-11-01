<script setup>
/**
 * 创作台 · 资产页签。直接内嵌 /projects 的 AssetLibrary：
 * 卡片 UI、编辑弹窗（角色声音选择/服饰添加生成/参考图/上传/拖拽/关键帧/自定义角色）与
 * /projects 完全同源，零删减。
 * embedded 模式共享 StudioView 的 st.assets 同一份响应式数组——两侧任一动作落库即双向可见，
 * 无需事件同步或重挂载。
 */
import { inject } from 'vue';
import AssetLibrary from '../workspace/AssetLibrary.vue';

const ctx = inject('studio');
const { st } = ctx;
</script>

<template>
  <div class="as">
    <AssetLibrary
      v-if="st.project"
      :project="st.project"
      :project-id="st.project.id"
      :assets="st.assets"
      :focus-signal="st.focus"
      embedded
    />
  </div>
</template>

<style scoped>
.as { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 10px 14px 14px; overflow-y: auto; }
@media (max-width: 900px) {
  .as { padding: 8px 10px 10px; }
}
</style>
