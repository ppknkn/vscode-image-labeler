import * as vscode from 'vscode';
import * as path from 'path';
import { ImageTreeItem } from './imageTreeItem';
import { LabelStateManager } from '../state/labelState';
import { listDirectory } from '../utils/fileUtils';

/**
 * ImageTreeProvider — 惰性层次化树视图
 *
 * 树结构（按需加载，每次只扫描一层）：
 *   [目录A/]  (12 张)        ← 含图片的子目录
 *     ├── [子目录A1/]         ← 嵌套子目录（无直接图片时不显示count）
 *     ├── img001.jpg  ✓保留
 *     └── img002.jpg  ✗删除
 *   [目录B/]  (5 张)
 *     └── ...
 *   img_root.jpg  ◻未标注     ← 工作区根目录的直接图片
 *
 * 关键设计：启动时只扫描工作区根目录一层 (O(n) n=直接子项数)，
 * 展开节点时才扫描下一层，完全避免了递归全量扫描。
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
   * 获取某个目录下的直接子项（子目录 + 图片）
   * 只扫描一层，O(n) 在 n=直接子项数量
   */
  private getChildrenFor(dirPath: string): ImageTreeItem[] {
    const listing = listDirectory(dirPath);
    const children: ImageTreeItem[] = [];

    // 子目录（可展开）
    for (const subdir of listing.subdirs) {
      // 快速再扫一层判断子目录是否有内容（避免展开后为空）
      const subListing = listDirectory(subdir);
      const hasContent = subListing.subdirs.length > 0 || subListing.images.length > 0;
      if (hasContent) {
        children.push(
          ImageTreeItem.createDirectoryNode(
            subdir,
            this.workspaceRoot,
            subListing.images.length
          )
        );
      }
    }

    // 直接图片
    for (const imgPath of listing.images) {
      const status = this.stateManager.getFileStatus(imgPath);
      const siblingImages = listing.images; // 同目录下的所有图片
      children.push(ImageTreeItem.createImageNode(imgPath, status, siblingImages));
    }

    return children;
  }
}
