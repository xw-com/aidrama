/** 任务名拼接（从 client/utils/task.js 原样移植） */
import { i18n } from '../i18n';

export function taskName(job, fallback) {
  const t = i18n.global.t;
  if (!job) return fallback || '';
  const label = job.meta && job.meta.label;
  const target = job.meta && job.meta.targetName;
  if (label && target) return `${label} · ${target}`;
  if (label) return label;
  if (target) return target;
  return fallback || job.type || t('tasks.untitled');
}
