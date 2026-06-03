import { Router } from "express";
import multer from "multer";
import express from "express";
import { uploadFile, getUploadStatus, getQueueStats } from "../controllers/uploadController.js";
import { uploadLimits } from "../config/uploadLimits.js";

// P-019: cap upload size. 1 GiB in-memory was an OOM risk; realistic user
// datasets fit comfortably under 200 MB. Operators can raise via UPLOAD_MAX_BYTES.
const UPLOAD_MAX_BYTES = uploadLimits.maxUploadBytes;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: UPLOAD_MAX_BYTES,
  },
  fileFilter: (req: express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const allowedTypes = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    
    if (allowedTypes.includes(file.mimetype) || 
        file.originalname.match(/\.(csv|xls|xlsx)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload CSV or Excel files.'));
    }
  },
});

const router = Router();

// File upload endpoint - now returns jobId immediately
router.post('/upload', upload.single('file'), (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Handle multer errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const limitMb = (UPLOAD_MAX_BYTES / 1024 / 1024).toFixed(0);
      return res.status(400).json({
        error: 'File too large',
        message: `File size exceeds the maximum limit of ${limitMb}MB.`,
        maxSize: `${limitMb}MB`,
        receivedSize: req.headers['content-length'] ? `${(parseInt(req.headers['content-length']) / 1024 / 1024).toFixed(2)}MB` : 'unknown'
      });
    }
    return res.status(400).json({ 
      error: 'Upload error', 
      message: err.message 
    });
  }
  // Handle other errors
  if (err) {
    return res.status(400).json({ 
      error: 'Upload error', 
      message: err.message 
    });
  }
  next();
}, uploadFile);

// Upload status endpoint
router.get('/upload/status/:jobId', getUploadStatus);

// Queue statistics endpoint (for monitoring)
router.get('/upload/queue/stats', getQueueStats);

export default router;
