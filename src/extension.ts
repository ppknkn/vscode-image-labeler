import * as vscode from 'vscode';
import { ImageTreeProvider } from './tree/imageTreeProvider';
import { ImageTreeItem } from './tree/imageTreeItem';
import { LabelStateManager } from './state/labelState';
import { registerCommands } from './commands/commands';
import { ImageViewer } from './views/imageViewer';
import { getSiblingImages } from './utils/fileUtils';

// 全局引用，供 deactivate 时刷盘
let _stateManager: LabelStateManager | undefined;

/**
 * 扩展激活入口
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('[Image Labeler] Extension activated');

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('图片标注器：请先打开一个文件夹');
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  // 初始化状态管理器（全局引用，供 deactivate 刷盘）
  const stateManager = new LabelStateManager();
  _stateManager = stateManager;

  // 初始化树视图
  const treeProvider = new ImageTreeProvider(workspaceRoot, stateManager);

  // 注册树视图
  const treeView = vscode.window.createTreeView('label-explorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });

  // 当查看器导航到新图片时，自动在侧边栏定位并高亮
  ImageViewer.onNavigate = async (imagePath: string) => {
    const siblings = getSiblingImages(imagePath);
    const status = stateManager.getFileStatus(imagePath);
    const imageItem = ImageTreeItem.createImageNode(imagePath, status, siblings);
    await treeView.reveal(imageItem, { select: true, focus: false, expand: 2 });
  };

  // 防抖刷新侧边栏 — 快速标注时最多每 250ms 刷新一次树图标和进度
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  ImageViewer.refreshTreeDebounced = () => {
    if (refreshTimer) { return; }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      treeProvider.refresh();
    }, 250);
  };

  // 注册所有命令
  const commandDisposables = registerCommands(context, treeProvider, stateManager);

  // 监听文件变化时自动刷新树
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{jpg,jpeg,png,gif,bmp,webp}');
  const onFileChange = fileWatcher.onDidChange(() => treeProvider.refresh());
  const onFileCreate = fileWatcher.onDidCreate(() => treeProvider.refresh());
  const onFileDelete = fileWatcher.onDidDelete(() => treeProvider.refresh());

  context.subscriptions.push(
    treeView,
    ...commandDisposables,
    fileWatcher,
    onFileChange,
    onFileCreate,
    onFileDelete
  );
}

/**
 * 扩展停用 — 确保所有内存中的标注状态都写入磁盘
 */
export function deactivate() {
  console.log('[Image Labeler] Extension deactivated');
  if (_stateManager) {
    _stateManager.flushAllSync();
  }
}
