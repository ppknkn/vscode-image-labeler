import * as vscode from 'vscode';
import * as path from 'path';
import { ImageTreeItem } from './imageTreeItem';
import { LabelStateManager } from '../state/labelState';
import { listDirectory, isImageFile } from '../utils/fileUtils';

/**
 * ImageTreeProvider — 惰性层次化树视图（单层扫描，零额外 I/O）
 *
 * 核心设计：每个 getChildren 调用只做一次 readdirSync，
 * 目录节点全部显示（不预判是否为空），展开时才扫描下一层。
 * 根节点下即使有数万个子目录也不做额外 I/O。
 */
export class ImageTreeProvider implements vscode.TreeDataProvider<ImageTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ImageTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private workspaceRoot: string;
  private stateManager: LabelStateManager;

  constructor(workspaceRoot: string, stateManager: LabelStateManager) {
    this.workspaceRoot = workspaceRoot;
    this.stateManager = stateManager;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  refreshItem(item: ImageTreeItem): void {
    this._onDidChangeTreeData.fire(item);
  }

  getTreeItem(element: ImageTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * getParent — 通过向上找父目录来支持 treeView.reveal()
   */
  getParent(element: ImageTreeItem): vscode.ProviderResult<ImageTreeItem> {
    const parentDir = path.dirname(element.filePath);

    // 如果父目录就是工作区根目录，或已经超出工作区，返回 null（根节点）
    const normalizedParent = path.normalize(parentDir);
    const normalizedRoot = path.normalize(this.workspaceRoot);

    if (normalizedParent === normalizedRoot || !normalizedParent.startsWith(normalizedRoot)) {
      return null;
    }

    // 返回父目录节点
    return ImageTreeItem.createDirectoryNode(parentDir, this.workspaceRoot, 0);
  }

  /**
   * getChildren — 惰性加载
   *
   * - undefined（根）→ 工作区根目录的单层扫描结果
   * - directory   → 该目录的单层扫描结果
   * - image       → []（叶子节点）
   */
  async getChildren(element?: ImageTreeItem): Promise<ImageTreeItem[]> {
    if (!element) {
      return this.getChildrenFor(this.workspaceRoot);
    }

    if (element.itemType === 'directory') {
      return this.getChildrenFor(element.filePath);
    }

    return [];
  }

  /**
   * 获取某个目录下的直接子项（仅一次 readdirSync，不预扫子目录）
   */
  private getChildrenFor(dirPath: string): ImageTreeItem[] {
    const listing = listDirectory(dirPath);
    const children: ImageTreeItem[] = [];

    // 子目录 — 全部显示为可展开节点，不预判是否为空（避免 N 次额外 I/O）
    for (const subdir of listing.subdirs) {
      children.push(
        ImageTreeItem.createDirectoryNode(subdir, this.workspaceRoot, 0)
      );
    }

    // 直接图片
    for (const imgPath of listing.images) {
      const status = this.stateManager.getFileStatus(imgPath);
      const siblingImages = listing.images;
      children.push(ImageTreeItem.createImageNode(imgPath, status, siblingImages));
    }

    return children;
  }
}
