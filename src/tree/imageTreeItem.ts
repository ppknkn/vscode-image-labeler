import * as vscode from 'vscode';
import * as path from 'path';
import { LabelStatus } from '../state/labelState';

/** TreeItem 类型 */
export type ImageTreeItemType = 'directory' | 'image';

/**
 * ImageTreeItem — TreeView 中的每个节点
 *
 * 层次化树结构（惰性加载，支持千万级图片目录）：
 *   [目录]     → 展开后显示子目录 + 直接包含的图片
 *   [图片]     → 叶子节点，单击打开查看器
 */
export class ImageTreeItem extends vscode.TreeItem {
  public readonly itemType: ImageTreeItemType;
  public readonly filePath: string;

  /** 对于图片节点，其所在目录下所有图片的路径（用于导航） */
  public readonly siblingImages?: string[];

  /** 目录下的直接图片数量（用于描述展示） */
  public readonly directImageCount?: number;

  constructor(
    itemType: ImageTreeItemType,
    filePath: string,
    label: string,
    status?: LabelStatus,
    siblingImages?: string[],
    collapsibleState?: vscode.TreeItemCollapsibleState,
    directImageCount?: number
  ) {
    super(label, collapsibleState ?? vscode.TreeItemCollapsibleState.None);

    this.itemType = itemType;
    this.filePath = filePath;
    this.siblingImages = siblingImages;
    this.directImageCount = directImageCount;

    // 必须设置 id：treeView.reveal() 依赖 id 在不同树刷新周期中匹配节点
    this.id = itemType === 'directory' ? `dir:${filePath}` : `image:${filePath}`;

    // 上下文值用于 when 条件
    this.contextValue = itemType;

    if (itemType === 'directory') {
      this.setDirectoryProperties();
    } else {
      this.setImageProperties(status);
    }
  }

  private setDirectoryProperties(): void {
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = this.filePath;
  }

  private setImageProperties(status?: LabelStatus): void {
    switch (status) {
      case 'keep':
        this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
        break;
      case 'delete':
        this.iconPath = new vscode.ThemeIcon('trash', new vscode.ThemeColor('charts.red'));
        break;
      default:
        this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
        break;
    }

    this.tooltip = this.filePath;
    this.description = status === 'keep' ? '保留' : status === 'delete' ? '删除' : undefined;

    this.command = {
      command: 'label.openViewer',
      title: '打开图片查看器',
      arguments: [this.filePath]
    };
  }

  /** 创建目录节点 */
  static createDirectoryNode(
    dirPath: string,
    workspaceRoot: string,
    imageCount: number
  ): ImageTreeItem {
    const relativePath = path.relative(workspaceRoot, dirPath) || path.basename(dirPath);
    const label = relativePath || path.basename(dirPath);
    const item = new ImageTreeItem(
      'directory',
      dirPath,
      label,
      undefined,
      undefined,
      vscode.TreeItemCollapsibleState.Collapsed,
      imageCount
    );
    // 描述展示该目录下的直接图片数
    item.description = imageCount > 0 ? `${imageCount} 张` : undefined;
    return item;
  }

  /** 创建图片叶子节点 */
  static createImageNode(
    imagePath: string,
    status: LabelStatus,
    siblingImages: string[]
  ): ImageTreeItem {
    const fileName = path.basename(imagePath);
    return new ImageTreeItem('image', imagePath, fileName, status, siblingImages);
  }
}
