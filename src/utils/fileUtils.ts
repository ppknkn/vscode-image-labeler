import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** 支持的图片文件扩展名（小写） */
export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'
]);

/** 标注状态文件名 */
export const LABEL_STATE_FILENAME = '.label-state.json';

/**
 * 判断文件是否为支持的图片格式
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * 判断路径是否为标注状态文件
 */
export function isLabelStateFile(filePath: string): boolean {
  return path.basename(filePath) === LABEL_STATE_FILENAME;
}

/**
 * 递归扫描目录，返回所有图片文件的完整路径（排序后）
 * 忽略隐藏文件夹（以 . 开头）和 node_modules
 */
export function scanImageFiles(folderPath: string): string[] {
  const result: string[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 跳过无法读取的目录
    }

    // 文件夹在前，文件在后，各自按名称排序
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) { return -1; }
      if (!a.isDirectory() && b.isDirectory()) { return 1; }
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    for (const entry of sorted) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // 跳过隐藏文件夹和 node_modules
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (isImageFile(entry.name) && !isLabelStateFile(entry.name)) {
          result.push(fullPath);
        }
      }
    }
  }

  walk(folderPath);
  return result;
}

/**
 * 获取某个文件所在文件夹的所有图片文件
 */
export function getSiblingImages(imagePath: string): string[] {
  const dir = path.dirname(imagePath);
  return scanImageFiles(dir);
}

/**
 * 获取某个文件在其所在文件夹图片列表中的索引
 */
export function getImageIndex(imagePath: string, allImages: string[]): number {
  const normalized = path.normalize(imagePath);
  return allImages.findIndex(img => path.normalize(img) === normalized);
}

/**
 * 获取相对于工作区根目录的路径
 */
export function getRelativePath(absolutePath: string, workspaceRoot: string): string {
  return path.relative(workspaceRoot, absolutePath);
}

/**
 * 获取某一文件夹下所有子文件夹中包含图片的目录列表
 * 用于构建树视图
 */
export function getImageFolders(workspaceRoot: string): string[] {
  const folders = new Set<string>();

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    let hasImages = false;
    let hasSubdirs = false;

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          hasSubdirs = true;
          walk(fullPath);
        }
      } else if (entry.isFile() && isImageFile(entry.name)) {
        hasImages = true;
      }
    }

    if (hasImages) {
      folders.add(dir);
    }
  }

  walk(workspaceRoot);
  return Array.from(folders).sort();
}

/**
 * 从文件路径中获取文件夹路径
 */
export function getFolderPath(filePath: string): string {
  return path.dirname(filePath);
}
