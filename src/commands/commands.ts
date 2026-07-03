import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ImageTreeProvider } from '../tree/imageTreeProvider';
import { ImageTreeItem } from '../tree/imageTreeItem';
import { LabelStateManager, FolderProgress } from '../state/labelState';
import { ImageViewer } from '../views/imageViewer';
import { ThumbnailGrid } from '../views/thumbnailGrid';
import { scanImageFiles, getSiblingImages, getImageIndex } from '../utils/fileUtils';

/**
 * VS Code 从 view/title 和 view/item/context 菜单调用命令时，会传入
 * TreeView / TreeItem 等对象作为参数。我们需要从各种可能的参数类型中
 * 提取出实际的文件路径或文件夹路径。
 */
function extractFilePath(arg: any): string | undefined {
  if (typeof arg === 'string') { return arg; }
  // ImageTreeItem 或其普通对象形式
  if (arg && typeof arg.filePath === 'string') { return arg.filePath; }
  // VS Code 可能传入 Uri
  if (arg && arg.fsPath && typeof arg.fsPath === 'string') { return arg.fsPath; }
  return undefined;
}

function extractFolderPath(arg: any): string | undefined {
  if (typeof arg === 'string') { return arg; }
  // ImageTreeItem
  if (arg && typeof arg.filePath === 'string') { return path.dirname(arg.filePath); }
  return undefined;
}

/**
 * 注册所有命令
 * 返回 disposables 以便在 deactivate 时清理
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  treeProvider: ImageTreeProvider,
  stateManager: LabelStateManager
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // ====== label.refreshTree ======
  disposables.push(
    vscode.commands.registerCommand('label.refreshTree', () => {
      treeProvider.refresh();
    })
  );

  // ====== label.openViewer ======
  disposables.push(
    vscode.commands.registerCommand('label.openViewer', (arg?: any) => {
      let imagePath = extractFilePath(arg);

      // 如果未从参数获得，尝试从活动编辑器获取
      if (!imagePath) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          imagePath = editor.document.uri.fsPath;
        }
      }

      if (!imagePath) {
        vscode.window.showWarningMessage('请先在侧边栏选择一张图片');
        return;
      }

      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('请先打开一个文件夹');
        return;
      }

      // 设置 context key 以启用快捷键
      vscode.commands.executeCommand('setContext', 'labelViewerActive', true);

      ImageViewer.show(context.extensionUri, stateManager, imagePath);
    })
  );

  // ====== label.openGrid ======
  disposables.push(
    vscode.commands.registerCommand('label.openGrid', (arg?: any) => {
      let folderPath = extractFolderPath(arg);

      // 如果未获得文件夹路径，尝试从第一个选中的 TreeItem 获取
      if (!folderPath && treeProvider) {
        // 无法获取选中项，提示用户
        vscode.window.showWarningMessage('请在侧边栏右键点击一个文件夹，选择"打开缩略图网格"');
        return;
      }

      if (!folderPath) {
        vscode.window.showWarningMessage('请在侧边栏选择一个文件夹，或右键点击文件夹');
        return;
      }

      ThumbnailGrid.show(stateManager, folderPath);
    })
  );

  // ====== label.markKeep ======
  disposables.push(
    vscode.commands.registerCommand('label.markKeep', (arg?: any) => {
      const imagePath = extractFilePath(arg);
      if (!imagePath) { return; }
      stateManager.setFileStatus(imagePath, 'keep');
      stateManager.scheduleFlush();
      // 通知查看器
      const folder = path.dirname(imagePath);
      const images = getSiblingImages(imagePath);
      const state = stateManager.get(folder);
      ImageViewer.notifyStatusChange('keep', state.getProgress(images.length));
      // 刷新树
      treeProvider.refresh();
      // 跳到下一张
      tryAdvanceAfterMark(imagePath, stateManager, treeProvider);
    })
  );

  // ====== label.markDelete ======
  disposables.push(
    vscode.commands.registerCommand('label.markDelete', (arg?: any) => {
      const imagePath = extractFilePath(arg);
      if (!imagePath) { return; }
      stateManager.setFileStatus(imagePath, 'delete');
      stateManager.scheduleFlush();
      // 通知查看器
      const folder = path.dirname(imagePath);
      const images = getSiblingImages(imagePath);
      const state = stateManager.get(folder);
      ImageViewer.notifyStatusChange('delete', state.getProgress(images.length));
      // 刷新树
      treeProvider.refresh();
      // 跳到下一张
      tryAdvanceAfterMark(imagePath, stateManager, treeProvider);
    })
  );

  // ====== label.clearLabel ======
  disposables.push(
    vscode.commands.registerCommand('label.clearLabel', (arg?: any) => {
      const imagePath = extractFilePath(arg);
      if (!imagePath) { return; }
      stateManager.setFileStatus(imagePath, null);
      stateManager.scheduleFlush();
      // 通知查看器更新状态
      const folder = path.dirname(imagePath);
      const images = getSiblingImages(imagePath);
      const state = stateManager.get(folder);
      const progress = state.getProgress(images.length);
      ImageViewer.notifyStatusChange(null, progress);
      // 刷新树
      treeProvider.refresh();
    })
  );

  // ====== label.exportResults ======
  disposables.push(
    vscode.commands.registerCommand('label.exportResults', async () => {
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('请先打开一个文件夹');
        return;
      }

      const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const allImages = scanImageFiles(workspaceRoot);

      // 按文件夹分组统计
      const folderStats: Record<string, { total: number; kept: string[]; deleted: string[] }> = {};
      for (const imgPath of allImages) {
        const folder = path.dirname(imgPath);
        const fileName = path.basename(imgPath);
        const status = stateManager.getFileStatus(imgPath);

        if (!folderStats[folder]) {
          folderStats[folder] = { total: 0, kept: [], deleted: [] };
        }
        folderStats[folder].total++;
        if (status === 'keep') { folderStats[folder].kept.push(fileName); }
        if (status === 'delete') { folderStats[folder].deleted.push(fileName); }
      }

      // 生成 CSV
      let csv = '文件夹,文件名,标注结果\n';
      let totalKept = 0;
      let totalDeleted = 0;
      let totalUnreviewed = 0;

      for (const [folder, stats] of Object.entries(folderStats)) {
        // 列出该文件夹的所有图片
        const folderImages = scanImageFiles(folder);
        for (const imgPath of folderImages) {
          const fileName = path.basename(imgPath);
          const status = stateManager.getFileStatus(imgPath);
          const statusLabel = status === 'keep' ? '保留' : status === 'delete' ? '删除' : '未标注';
          const relFolder = path.relative(workspaceRoot, folder) || '.';
          csv += `"${relFolder}","${fileName}","${statusLabel}"\n`;
        }
        totalKept += stats.kept.length;
        totalDeleted += stats.deleted.length;
        totalUnreviewed += stats.total - stats.kept.length - stats.deleted.length;
      }

      // 保存 CSV
      const defaultUri = vscode.Uri.file(path.join(workspaceRoot, 'label-results.csv'));
      const uri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { 'CSV 文件': ['csv'], '所有文件': ['*'] }
      });

      if (uri) {
        fs.writeFileSync(uri.fsPath, csv, 'utf-8');
        vscode.window.showInformationMessage(
          `✅ 导出完成！保留 ${totalKept} | 删除 ${totalDeleted} | 未标注 ${totalUnreviewed} | 共 ${allImages.length} 张`
        );
      }
    })
  );

  // ====== label.nextUnreviewed ======
  disposables.push(
    vscode.commands.registerCommand('label.nextUnreviewed', (currentPath?: string) => {
      navigateUnreviewed(currentPath, 1, stateManager);
    })
  );

  // ====== label.prevUnreviewed ======
  disposables.push(
    vscode.commands.registerCommand('label.prevUnreviewed', (currentPath?: string) => {
      navigateUnreviewed(currentPath, -1, stateManager);
    })
  );

  return disposables;
}

/**
 * 标记后尝试跳转到下一张未标注的图片
 */
function tryAdvanceAfterMark(
  imagePath: string,
  stateManager: LabelStateManager,
  treeProvider: ImageTreeProvider
): void {
  const siblings = getSiblingImages(imagePath);
  const currentIndex = getImageIndex(imagePath, siblings);

  // 搜索下一张未标注的
  for (let i = currentIndex + 1; i < siblings.length; i++) {
    if (stateManager.getFileStatus(siblings[i]) === null) {
      vscode.commands.executeCommand('label.openViewer', siblings[i]);
      return;
    }
  }

  // 从头搜索
  for (let i = 0; i < currentIndex; i++) {
    if (stateManager.getFileStatus(siblings[i]) === null) {
      vscode.commands.executeCommand('label.openViewer', siblings[i]);
      return;
    }
  }

  // 全部完成
  vscode.window.showInformationMessage('🎉 当前文件夹所有图片已标注完成！');
}

/**
 * 导航上一张/下一张未标注图片
 */
function navigateUnreviewed(
  currentPath: string | undefined,
  direction: 1 | -1,
  stateManager: LabelStateManager
): void {
  if (!currentPath) {
    // 尝试从活动 webview 推断
    return;
  }

  const siblings = getSiblingImages(currentPath);
  const currentIndex = getImageIndex(currentPath, siblings);

  for (
    let i = currentIndex + direction;
    direction > 0 ? i < siblings.length : i >= 0;
    i += direction
  ) {
    if (stateManager.getFileStatus(siblings[i]) === null) {
      vscode.commands.executeCommand('label.openViewer', siblings[i]);
      return;
    }
  }

  vscode.window.showInformationMessage('没有更多未标注图片');
}
