import db from '../db/index.js';

/**
 * 成片选版公共算法：给出一个项目「每集当前应播放/下载的成片版本」。
 * 口径与工作台成片列表展示 / 批量下载 / 分享播放页完全一致（原实现内联在 public.routes.js，
 * 展示中心与接单中心交付也需要同一口径，抽为公共服务）：
 * - 只认 episode_videos 成片落档中未隐藏的 compose / subtitle / edit 三类记录，
 *   按 created_at 倒序（find 即最新）；成片查询与 jobs 表解耦（Job 清理/删除不影响选版）
 * - 每集 root = 最近一次生成的成片（合成版/剪辑版同权）；优先取挂在其名下已烧录的字幕版
 *   （字幕版从不写 episode.video_url，需按 source_job_id 追溯；只认挂在选中版本名下的字幕版，
 *   避免重新合成/剪辑后还播旧版本的过期字幕）
 * - 无任何成片记录（或均已删）时回退 episode.video_url
 * - 没有可播视频的分集整集跳过（返回数组中不出现）
 *
 * @param {number} projectId 项目 id
 * @returns {Promise<Array<{id:number, idx:number, title:string, video_url:string, duration:number}>>}
 */
export async function listPlayableEpisodeFilms(projectId) {
  const map = await mapPlayableEpisodeFilms([projectId]);
  return map.get(projectId) || [];
}

/**
 * 批量版：一次算多个项目的可播分集成片（展示中心列表算每条的可播分集数用）。
 * 与单项目版共用同一套选版逻辑，仅把「每项目 2 条查询」合并为总共 2 条，
 * 避免 size=48 时一页打 96 条查询的 N+1。
 *
 * @param {number[]} projectIds
 * @returns {Promise<Map<number, Array<{id:number, idx:number, title:string, video_url:string, duration:number}>>>}
 */
export async function mapPlayableEpisodeFilms(projectIds) {
  const ids = [...new Set(projectIds.map(Number).filter(Number.isFinite))];
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;

  const rows = (await db.Episode.findAll({
    where: { project_id: ids },
    order: [['idx', 'ASC']],
    attributes: ['id', 'project_id', 'idx', 'title', 'video_url', 'duration'],
  })).filter((e) => map.has(e.project_id)); // LEFT JOIN 语义防护：脏数据 project_id 不在入参时丢弃

  // 两段式取数免大 JSON 行 filesort（同 job.service 口径）：先只取 id 列按 created_at 倒序
  // （排序元组极小），再按 id IN 点查整行后 JS 内恢复倒序；下游分组依赖此序，选版语义不变
  const filmIdRows = await db.EpisodeVideo.findAll({
    where: {
      project_id: ids,
      hidden: false,
      kind: { [db.Sequelize.Op.in]: ['compose', 'subtitle', 'edit'] },
    },
    attributes: ['id'], order: [['created_at', 'DESC']],
  });
  const films = filmIdRows.length
    ? (await db.EpisodeVideo.findAll({ where: { id: { [db.Sequelize.Op.in]: filmIdRows.map((r) => r.id) } } }))
        .sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || (b.id - a.id))
        .filter((f) => f.video_url || (f.kind === 'subtitle' && f.srt_url)) // 与成片列表一致：字幕草稿行无视频不参与选版
    : [];

  // 按项目分组（films 全局按 created_at 倒序，分组后组内仍保持倒序，选版语义不变）
  const filmsByProject = new Map(ids.map((id) => [id, []]));
  for (const f of films) {
    if (filmsByProject.has(f.project_id)) filmsByProject.get(f.project_id).push(f);
  }

  for (const e of rows) {
    const filmsOf = filmsByProject.get(e.project_id) || [];
    const root = filmsOf.find((f) => f.kind !== 'subtitle' && f.episode_id === e.id); // 该集最新生成的成片（合成版/剪辑版同权）
    const sub = root && filmsOf.find((f) => (
      f.kind === 'subtitle'
      && f.episode_id === e.id
      && String(f.source_job_id ?? '') === String(root.job_id ?? '')
      && f.video_url
    ));
    const film = {
      id: e.id,
      idx: e.idx,
      title: e.title,
      video_url: sub?.video_url || root?.video_url || e.video_url,
      duration: sub?.duration || root?.duration || e.duration,
    };
    if (film.video_url && film.video_url.trim() !== '') map.get(e.project_id).push(film);
  }
  return map;
}
