import { Router } from 'express';
import multer from 'multer';
import * as mediaController from './controller.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const router = Router();

router.post('/upload', upload.single('file'), mediaController.uploadMedia);
router.get('/:id', mediaController.getMediaById);

export default router;
