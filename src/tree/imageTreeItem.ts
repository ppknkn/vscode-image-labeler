import * as vscode from 'vscode';
import * as path from 'path';
import { LabelStatus } from '../state/labelState';

/** TreeItem 类型 */
export type ImageTreeItemType = 'folder' | 'image';

/**
 * ImageTreeItem — TreeView 中的每个节点
 * 可以是文件夹（包含图片的子目录）或图片文件
 */
export class ImageTreeItem extends vscode.TreeItem {
  /** 树节点类型 */
  public readonly itemType: ImageTreeItemType;

  /** 图片或文件夹的绝对路径 */
  public readonly filePath: string;

  /** 对于图片节点，该文件夹下所有图片的路径列表 */
  public readonly siblingImages?: string[];

  constructor(
    itemType: ImageTreeItemType,
    filePath: string,
    label: string,
    status?: LabelStatus,
    siblingImages?: string[],
    collapsibleState?: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState ?? vscode.TreeItemCollapsibleState.None);

    this.itemType = itemType;
    this.filePath = filePath;
    this.siblingImages = siblingImages;

    // 必须设置 id：treeView.reveal() 依赖 id 在不同树刷新周期中匹配节点
    // 两种节点类型用不同前缀避免 id 冲突
    this.id = itemType === 'folder' ? `folder:${filePath}` : `image:${filePath}`;

    // 设置上下文值用于 when 条件
    this.contextValue = itemType;

    if (itemType === 'folder') {
      this.setFolderProperties();
    } else {
      this.setImageProperties(status);
    }
  }

  /** 设置文件夹节点的属性 */
  private setFolderProperties(): void {
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = this.filePath;
    this.description = this.label?.toString(); // label 被用作 description
  }

  /** 设置图片节点的属性 */
  private setImageProperties(status?: LabelStatus): void {
    // 根据状态设置图标
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

    // 单击图片节点时执行的命令
    this.command = {
      command: 'label.openViewer',
      title: '打开图片查看器',
      arguments: [this.filePath]
    };
  }

  /**
   * 创建文件夹节点（带进度描述）
   */
  static createFolderNode(
    folderPath: string,
    workspaceRoot: string,
    totalImages: number,
    reviewedCount: number
  ): ImageTreeItem {
    const relativePath = path.relative(workspaceRoot, folderPath) || path.basename(folderPath);
    const progress = `${reviewedCount}/${totalImages}`;
    const label = relativePath;

    const item = new ImageTreeItem(
      'folder',
      folderPath,
      label,
      undefined,
      undefined,
      totalImages > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    // 覆写 description 显示进度
    item.description = progress;
    return item;
  }

  /**
   * 创建图片叶子节点
   */
  static createImageNode(
    imagePath: string,
    status: LabelStatus,
    siblingImages: string[]
  ): ImageTreeItem {
    const fileName = path.basename(imagePath);
    return new ImageTreeItem('image', imagePath, fileName, status, siblingImages);
  }
}
