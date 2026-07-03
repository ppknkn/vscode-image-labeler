import * as vscode from 'vscode';
import * as path from 'path';
import { ImageTreeItem } from './imageTreeItem';
import { LabelStateManager } from '../state/labelState';
import { getImageFolders, scanImageFiles } from '../utils/fileUtils';

/**
 * ImageTreeProvider — 实现 TreeDataProvider<ImageTreeItem>
 *
 * 树结构：
 *   [文件夹A] (已标注/总数)
 *     ├── 🟢 img001.jpg (保留)
 *     ├── 🔴 img002.jpg (删除)
 *     └── ⚪ img003.jpg
 *   [文件夹B] (已标注/总数)
 *     └── ...
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

  /**
   * 刷新整个树（只触发重绘，不清除缓存）
   *
   * 注意：LabelStateManager 的缓存是内存标注的数据源。
   * 清除缓存会销毁尚未写入磁盘的标注数据，导致状态回退。
   * 如果需要强刷，应该先 flushAll() 再 clearCache()。
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** 刷新指定节点 */
  refreshItem(item: ImageTreeItem): void {
    this._onDidChangeTreeData.fire(item);
  }

  getTreeItem(element: ImageTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * 实现 getParent 以支持 treeView.reveal()
   * 图片节点的父节点是所在文件夹节点，文件夹节点的父节点是 null（根）
   */
  getParent(element: ImageTreeItem): vscode.ProviderResult<ImageTreeItem> {
    if (element.itemType === 'image') {
      // 图片的父节点是它所在的文件夹
      const folderPath = path.dirname(element.filePath);
      const images = scanImageFiles(folderPath);
      const state = this.stateManager.get(folderPath);
      const progress = state.getProgress(images.length);
      return ImageTreeItem.createFolderNode(
        folderPath,
        this.workspaceRoot,
        progress.total,
        progress.reviewed
      );
    }
    // 文件夹节点的父节点是根（null）
    return null;
  }

  async getChildren(element?: ImageTreeItem): Promise<ImageTreeItem[]> {
    if (!element) {
      // 根节点 — 返回所有包含图片的文件夹
      return this.getFolderNodes();
    }

    if (element.itemType === 'folder') {
      // 文件夹节点 — 返回其中的所有图片
      return this.getImageNodes(element.filePath);
    }

    // 图片节点没有子节点
    return [];
  }

  /** 获取根级别的文件夹列表 */
  private getFolderNodes(): ImageTreeItem[] {
    const stateManager = this.stateManager;
    const folders = getImageFolders(this.workspaceRoot);

    return folders.map(folderPath => {
      const images = scanImageFiles(folderPath);
      const state = stateManager.get(folderPath);
      const progress = state.getProgress(images.length);

      return ImageTreeItem.createFolderNode(
        folderPath,
        this.workspaceRoot,
        progress.total,
        progress.reviewed
      );
    });
  }

  /** 获取某个文件夹下的图片子节点 */
  private getImageNodes(folderPath: string): ImageTreeItem[] {
    const images = scanImageFiles(folderPath);
    const state = this.stateManager.get(folderPath);

    return images.map(imagePath => {
      const status = state.getStatus(path.basename(imagePath));
      return ImageTreeItem.createImageNode(imagePath, status, images);
    });
  }
}
