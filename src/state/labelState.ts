import * as fs from 'fs';
import * as path from 'path';
import { LABEL_STATE_FILENAME } from '../utils/fileUtils';

/** 单张图片的标注状态 */
export type LabelStatus = 'keep' | 'delete' | null;

/** 标注状态文件的 JSON 结构 */
export interface LabelStateFile {
  version: 1;
  folder: string;
  lastUpdated: string;
  files: Record<string, LabelStatus>;
}

/** 文件夹标注进度 */
export interface FolderProgress {
  total: number;
  reviewed: number;
  kept: number;
  deleted: number;
  unreviewed: number;
}

/**
 * LabelState — 管理单个文件夹的 .label-state.json
 *
 * 高性能模式：setStatus 只更新内存，save 通过 debounce 延迟写盘。
 * 标注速度可达 30〜120fps，不再受同步磁盘 I/O 限制。
 */
export class LabelState {
  private folderPath: string;
  private stateFile: LabelStateFile;
  private stateFilePath: string;
  private dirty: boolean = false;

  constructor(folderPath: string) {
    this.folderPath = folderPath;
    this.stateFilePath = path.join(folderPath, LABEL_STATE_FILENAME);
    this.stateFile = this.load();
  }

  /** 加载状态文件，不存在则创建空状态 */
  private load(): LabelStateFile {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as LabelStateFile;
        if (parsed.version === 1 && typeof parsed.files === 'object') {
          return parsed;
        }
      }
    } catch {
      // 文件损坏或无法读取，重新创建
    }

    return {
      version: 1,
      folder: this.folderPath,
      lastUpdated: new Date().toISOString(),
      files: {}
    };
  }

  /**
   * 刷新到磁盘（仅当有未保存的更改时）
   * 使用异步 writeFile 避免阻塞事件循环
   */
  flush(): void {
    if (!this.dirty) { return; }
    this.dirty = false;
    this.stateFile.lastUpdated = new Date().toISOString();
    const data = JSON.stringify(this.stateFile, null, 2);
    fs.writeFile(this.stateFilePath, data, 'utf-8', (err) => {
      if (err) {
        console.error(`[LabelState] Failed to save state file: ${this.stateFilePath}`, err);
        this.dirty = true; // 标记回 dirty，下次 flush 重试
      }
    });
  }

  /** 同步刷新（用于扩展停用时的最后一次保存） */
  flushSync(): void {
    if (!this.dirty) { return; }
    this.dirty = false;
    this.stateFile.lastUpdated = new Date().toISOString();
    try {
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.stateFile, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[LabelState] Failed to save state file: ${this.stateFilePath}`, err);
    }
  }

  /** 获取某个文件的标注状态 */
  getStatus(fileName: string): LabelStatus {
    return this.stateFile.files[fileName] ?? null;
  }

  /** 设置某个文件的标注状态（内存操作，不立即写盘） */
  setStatus(fileName: string, status: LabelStatus): void {
    if (status === null) {
      delete this.stateFile.files[fileName];
    } else {
      this.stateFile.files[fileName] = status;
    }
    this.dirty = true;
  }

  /** 批量设置标注状态 */
  setStatusBatch(updates: Record<string, LabelStatus>): void {
    for (const [fileName, status] of Object.entries(updates)) {
      if (status === null) {
        delete this.stateFile.files[fileName];
      } else {
        this.stateFile.files[fileName] = status;
      }
    }
    this.dirty = true;
  }

  /** 清除该文件夹的所有标注 */
  clearAll(): void {
    this.stateFile.files = {};
    this.dirty = true;
  }

  /** 获取文件夹标注进度 */
  getProgress(totalFiles: number): FolderProgress {
    let kept = 0;
    let deleted = 0;

    for (const status of Object.values(this.stateFile.files)) {
      if (status === 'keep') { kept++; }
      if (status === 'delete') { deleted++; }
    }

    return {
      total: totalFiles,
      reviewed: kept + deleted,
      kept,
      deleted,
      unreviewed: totalFiles - kept - deleted
    };
  }

  /** 获取所有标注记录 */
  getAllRecords(): Record<string, LabelStatus> {
    return { ...this.stateFile.files };
  }
}

/**
 * LabelStateManager — 管理多个 LabelState 实例（缓存 + 统一刷盘）
 */
export class LabelStateManager {
  private cache: Map<string, LabelState> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** 获取指定文件夹的 LabelState 实例 */
  get(folderPath: string): LabelState {
    const normalized = path.normalize(folderPath);
    let state = this.cache.get(normalized);
    if (!state) {
      state = new LabelState(normalized);
      this.cache.set(normalized, state);
    }
    return state;
  }

  /** 安全清除缓存（先同步刷盘再清，防止数据丢失） */
  clearCache(): void {
    // 先刷新所有脏状态到磁盘
    for (const state of this.cache.values()) {
      state.flushSync();
    }
    this.cache.clear();
  }

  /** 根据单个文件路径获取其状态 */
  getFileStatus(filePath: string): LabelStatus {
    const folder = path.dirname(filePath);
    const fileName = path.basename(filePath);
    return this.get(folder).getStatus(fileName);
  }

  /** 设置单个文件的标注状态（内存操作） */
  setFileStatus(filePath: string, status: LabelStatus): void {
    const folder = path.dirname(filePath);
    const fileName = path.basename(filePath);
    this.get(folder).setStatus(fileName, status);
  }

  /**
   * 安排延迟刷盘 — 2 秒无操作后自动写入磁盘
   * 多次连续调用会重置计时器
   */
  scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushAll();
    }, 2000);
  }

  /** 立即刷新所有脏状态（异步写盘） */
  flushAll(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const state of this.cache.values()) {
      state.flush();
    }
  }

  /** 同步刷新所有脏状态（扩展停用时调用） */
  flushAllSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const state of this.cache.values()) {
      state.flushSync();
    }
  }
}
