import { defineStore } from 'pinia';
import { projectApi } from '../api';
import { isOwner, can } from '../utils/perms';

export const useProjectStore = defineStore('project', {
  state: () => ({
    current: null,
    loading: false,
  }),
  getters: {
    // 当前项目是否为本人创建（owner 隐式全权限）
    isOwner: (s) => isOwner(s.current),
    // 当前项目是否拥有某权限，如 can('script.edit')
    can: (s) => (perm) => can(s.current, perm),
  },
  actions: {
    async load(id) {
      this.loading = true;
      try {
        this.current = await projectApi.get(id);
        return this.current;
      } finally {
        this.loading = false;
      }
    },
    clear() {
      this.current = null;
    },
  },
});
