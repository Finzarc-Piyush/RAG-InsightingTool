import { Router } from "express";
import { 
  getUserFiles, 
  downloadFile, 
  deleteFile, 
  generateFileAccessUrl,
  getFileMetadata 
} from "../controllers/blobController.js";

const router = Router();

// Get all files for a user
router.get('/files/user/:username', getUserFiles);

// Get file metadata
router.get('/files/:blobName/metadata', getFileMetadata);

// Download a file
router.get('/files/:blobName/download', downloadFile);

// Generate temporary access URL
router.post('/files/:blobName/access-url', generateFileAccessUrl);

// Delete a file
router.delete('/files/:blobName', deleteFile);

export default router;

