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
 * 判断目录是否应该跳过（隐藏目录 / node_modules）
 */
function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** 单层目录扫描结果 */
export interface DirectoryListing {
  /** 直接子目录（不含图片的子目录，作为树中间节点） */
  subdirs: string[];
  /** 直接包含的图片文件 */
  images: string[];
}

/**
 * 单层扫描：只列出 dir 下的直接子项（不递归）
 *
 * 这是高性能设计的核心 — 对于千万级图片的目录树，只在用户展开某个节点时
 * 才扫描该层，避免启动时全量递归扫描整个工作区。
 */
export function listDirectory(dir: string): DirectoryListing {
  const subdirs: string[] = [];
  const images: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { subdirs, images };
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name)) {
        subdirs.push(path.join(dir, entry.name));
      }
    } else if (entry.isFile()) {
      if (isImageFile(entry.name) && !isLabelStateFile(entry.name)) {
        images.push(path.join(dir, entry.name));
      }
    }
  }

  // 按名称排序（数字感知）
  const collator = new Intl.Collator(undefined, { numeric: true });
  subdirs.sort((a, b) => collator.compare(path.basename(a), path.basename(b)));
  images.sort((a, b) => collator.compare(path.basename(a), path.basename(b)));

  return { subdirs, images };
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
      return;
    }

    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) { return -1; }
      if (!a.isDirectory() && b.isDirectory()) { return 1; }
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    for (const entry of sorted) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) {
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
 * 用于构建树视图（兼容旧代码，新代码用 listDirectory）
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

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) {
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
