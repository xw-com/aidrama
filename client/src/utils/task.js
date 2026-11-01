/**
 * 任务展示名：label + 章节/分镜号（如有）+ 具体事项目（meta.targetName），用于区分同类任务。
 * episodeIdx/episodeTitle/shotNo/targetName 均由后端建任务时写入 meta：
 * 分镜级任务带「第N集 · 镜号」；集级任务只有集（targetName=集标题，去重不重复展示）。
 * 存量任务缺字段时自动退化，只显示有的部分。
 * @param {object} job Job 行（含 meta）
 * @param {string} fallback label 缺省时的兜底文案（调用方传 i18n 文案）
 * @returns {string} 如「生成视频 · 第2集·夜市追逐 镜2-3 · 遇袭」
 */
export function taskName(job, fallback = '') {
  const meta = job?.meta || {};
  const label = meta.label || fallback;
  const epIdx = meta.episodeIdx ? `第${meta.episodeIdx}集` : '';
  const epTitle = meta.episodeTitle || '';
  const epPart = [epIdx, epTitle !== epIdx ? epTitle : ''].filter(Boolean).join('·');
  const shotPart = meta.shotNo ? `镜${meta.shotNo}` : '';
  // 集级任务 targetName 即集标题，已含在集信息里，不再重复
  const target = meta.targetName && meta.targetName !== epTitle ? meta.targetName : '';
  return [label, [epPart, shotPart].filter(Boolean).join(' '), target].filter(Boolean).join(' · ');
}
