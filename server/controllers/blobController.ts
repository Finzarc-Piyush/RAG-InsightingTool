import { Request, Response } from "express";
import {
  listUserFiles,
  getFileFromBlob,
  deleteFileFromBlob,
  generateSasUrl,
} from "../lib/blobStorage.js";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";

// Get all files for a user from blob storage
export const getUserFiles = async (req: Request, res: Response) => {
  try {
    const authed = requireUsername(req);
    const pathUser = decodeURIComponent(req.params.username || "")
      .trim()
      .toLowerCase();
    if (!pathUser || pathUser !== authed) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const files = await listUserFiles(authed);

    res.json({ files });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error("Get user files error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get user files",
    });
  }
};

// Download a specific file from blob storage
export const downloadFile = async (req: Request, res: Response) => {
  try {
    const { blobName } = req.params;
    const username = requireUsername(req);

    if (!blobName.startsWith(username.replace(/[^a-zA-Z0-9]/g, "_"))) {
      return res.status(403).json({ error: "Access denied" });
    }

    const fileBuffer = await getFileFromBlob(blobName);

    const fileName = blobName.split("/").pop() || "file";
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "application/octet-stream");

    res.send(fileBuffer);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error("Download file error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to download file",
    });
  }
};

// Delete a file from blob storage
export const deleteFile = async (req: Request, res: Response) => {
  try {
    const { blobName } = req.params;
    const username = requireUsername(req);

    if (!blobName.startsWith(username.replace(/[^a-zA-Z0-9]/g, "_"))) {
      return res.status(403).json({ error: "Access denied" });
    }

    await deleteFileFromBlob(blobName);

    res.json({ message: "File deleted successfully" });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error("Delete file error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to delete file",
    });
  }
};

// Generate a temporary SAS URL for file access
export const generateFileAccessUrl = async (req: Request, res: Response) => {
  try {
    const { blobName } = req.params;
    const { expiresInMinutes = 60 } = req.body;
    const username = requireUsername(req);

    if (!blobName.startsWith(username.replace(/[^a-zA-Z0-9]/g, "_"))) {
      return res.status(403).json({ error: "Access denied" });
    }

    const sasUrl = await generateSasUrl(blobName, expiresInMinutes);

    res.json({
      sasUrl,
      expiresInMinutes,
      expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString(),
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error("Generate file access URL error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to generate file access URL",
    });
  }
};

// Get file metadata
export const getFileMetadata = async (req: Request, res: Response) => {
  try {
    const { blobName } = req.params;
    const username = requireUsername(req);

    if (!blobName.startsWith(username.replace(/[^a-zA-Z0-9]/g, "_"))) {
      return res.status(403).json({ error: "Access denied" });
    }

    const files = await listUserFiles(username);
    const file = files.find((f) => f.blobName === blobName);

    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }

    res.json({
      blobName: file.blobName,
      fileName: file.fileName,
      size: file.size,
      lastModified: file.lastModified,
      contentType: file.contentType,
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error("Get file metadata error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get file metadata",
    });
  }
};
