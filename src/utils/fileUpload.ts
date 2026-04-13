import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { randomBytes } from 'crypto';

const UPLOAD_DIR = join(process.cwd(), 'data', 'documents');
const MAX_FILE_SIZE = 25 * 1024 * 1024;

const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
};

function ensureUploadDir(): void {
  if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

export function validateFile(fileName: string, fileSize: number, mimeType: string): { valid: boolean; error?: string } {
  if (fileSize > MAX_FILE_SIZE) {
    return { valid: false, error: `File size exceeds maximum of 25MB` };
  }

  const ext = extname(fileName).toLowerCase();
  const allowedExts = Object.values(ALLOWED_MIME_TYPES).flat();
  if (!allowedExts.includes(ext)) {
    return { valid: false, error: `File type ${ext} is not allowed. Allowed: PDF, DOCX, XLSX, PPTX, PNG, JPG` };
  }

  return { valid: true };
}

export async function saveUploadedFile(buffer: Buffer, originalName: string, mimeType: string): Promise<{ filePath: string; fileName: string; fileSize: number; mimeType: string }> {
  ensureUploadDir();

  const ext = extname(originalName).toLowerCase();
  const uniqueName = `${Date.now()}_${randomBytes(8).toString('hex')}${ext}`;
  const filePath = join(UPLOAD_DIR, uniqueName);

  writeFileSync(filePath, buffer);

  return {
    filePath: `/data/documents/${uniqueName}`,
    fileName: originalName,
    fileSize: buffer.length,
    mimeType,
  };
}

export function getUploadedFile(relativePath: string): { buffer: Buffer; fileName: string } | null {
  const normalizedPath = relativePath.replace(/\.\./g, '').replace(/\/\//g, '/');
  if (!normalizedPath.startsWith('/data/documents/')) return null;
  const fullPath = join(UPLOAD_DIR, normalizedPath.replace('/data/documents/', ''));
  if (!existsSync(fullPath)) return null;
  return { buffer: readFileSync(fullPath), fileName: normalizedPath.split('/').pop() || 'file' };
}

export function deleteUploadedFile(relativePath: string): boolean {
  try {
    const normalizedPath = relativePath.replace(/\.\./g, '').replace(/\/\//g, '/');
    if (!normalizedPath.startsWith('/data/documents/')) return false;
    const fullPath = join(UPLOAD_DIR, normalizedPath.replace('/data/documents/', ''));
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
