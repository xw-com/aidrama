import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import db from '../db/index.js';
import { asyncHandler, ok, badRequest } from '../utils/index.js';
import { authRequired, adminAuthRequired } from '../middleware/auth.js';
import { genFilePath, toUrl, deleteUrlFiles } from '../utils/fileUtil.js';
import { config } from '../config/index.js';

const router = Router();
const { Voice } = db;

// 音频上传：内存存储、25MB 上限
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// 音频 mimetype → 扩展名
function extForAudioMime(mime) {
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') return 'mp3';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return 'wav';
  if (mime === 'audio/mp4' || mime === 'audio/m4a') return 'm4a';
  if (mime === 'audio/aac') return 'aac';
  if (mime === 'audio/ogg') return 'ogg';
  if (mime === 'audio/flac') return 'flac';
  if (mime === 'audio/webm') return 'webm';
  return 'mp3';
}

// 列表（读开放给所有登录用户）：音色库全局共享，直接返回全部；
// 资产页角色「绑定声音」下拉需用。写操作（新建/上传/改/删）限 admin。
router.get('/', authRequired, asyncHandler(async (req, res) => {
  const rows = await Voice.findAll({ order: [['id', 'ASC']] });
  return ok(res, rows);
}));

// 新建（仅元数据，音频随后上传）
router.post('/', adminAuthRequired, asyncHandler(async (req, res) => {
  const { name, gender, scene, age_range, age_range_text, emotion_type } = req.body;
  if (!name) throw badRequest('voice.name_required');
  const row = await Voice.create({
    name, gender: gender || null, audio_url: null,
    scene: scene || null,
    age_range: age_range ?? null,
    age_range_text: age_range_text || null,
    emotion_type: emotion_type ?? null,
  });
  return ok(res, row, 'voice.created');
}));

// 上传/替换声音样本
router.post('/:id/upload', adminAuthRequired, upload.single('file'), asyncHandler(async (req, res) => {
  const row = await Voice.findByPk(req.params.id);
  if (!row) throw badRequest('common.not_found');
  if (!req.file) throw badRequest('voice.no_audio_file');
  if (!req.file.mimetype || !req.file.mimetype.startsWith('audio/')) throw badRequest('voice.audio_only');
  const ext = extForAudioMime(req.file.mimetype);
  const { absPath } = genFilePath(config.uploadDir, ext, 'voice');
  const oldUrl = row.audio_url;
  fs.writeFileSync(absPath, req.file.buffer);
  await row.update({ audio_url: toUrl(absPath) });
  deleteUrlFiles([oldUrl]); // 清掉被替换的旧样本
  return ok(res, row, 'voice.audio_uploaded');
}));

// 更新元数据
router.put('/:id', adminAuthRequired, asyncHandler(async (req, res) => {
  const row = await Voice.findByPk(req.params.id);
  if (!row) throw badRequest('common.not_found');
  const { name, gender, scene, age_range, age_range_text, emotion_type } = req.body;
  await row.update({
    ...(name !== undefined && { name }),
    ...(gender !== undefined && { gender }),
    // 分类目录字段：null 表示清空分类
    ...(scene !== undefined && { scene: scene || null }),
    ...(age_range !== undefined && { age_range }),
    ...(age_range_text !== undefined && { age_range_text: age_range_text || null }),
    ...(emotion_type !== undefined && { emotion_type }),
  });
  return ok(res, row, 'voice.updated');
}));

// 删除（连同声音样本文件一并删除）
router.delete('/:id', adminAuthRequired, asyncHandler(async (req, res) => {
  const row = await Voice.findByPk(req.params.id);
  if (!row) throw badRequest('common.not_found');
  deleteUrlFiles([row.audio_url]);
  await row.destroy();
  return ok(res, null, 'voice.deleted');
}));

export default router;
