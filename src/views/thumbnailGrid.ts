import * as vscode from 'vscode';
import * as path from 'path';
import { LabelStateManager, LabelStatus } from '../state/labelState';
import { scanImageFiles } from '../utils/fileUtils';

/**
 * ThumbnailGrid — 缩略图网格 Panel
 *
 * 功能：网格展示文件夹内所有图片 + 多选 + 批量操作 + 筛选
 * 双击缩略图 → 切换到单张大图查看器
 */
export class ThumbnailGrid {
  private static currentPanel: ThumbnailGrid | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _stateManager: LabelStateManager;
  private _disposables: vscode.Disposable[] = [];
  private _folderPath: string = '';
  private _images: string[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    stateManager: LabelStateManager,
    folderPath: string
  ) {
    this._panel = panel;
    this._stateManager = stateManager;
    this._folderPath = folderPath;
    this._images = scanImageFiles(folderPath);

    this._panel.webview.html = this.getHtmlContent();
    this._panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(folderPath)]
    };

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      this.handleMessage.bind(this),
      null,
      this._disposables
    );

    // 初始发送图片列表
    this.sendImageList();
  }

  /**
   * 获取或创建 ThumbnailGrid 实例
   */
  static show(
    stateManager: LabelStateManager,
    folderPath: string
  ): void {
    if (ThumbnailGrid.currentPanel) {
      ThumbnailGrid.currentPanel._panel.reveal(vscode.ViewColumn.Active);
      ThumbnailGrid.currentPanel._folderPath = folderPath;
      ThumbnailGrid.currentPanel._images = scanImageFiles(folderPath);
      ThumbnailGrid.currentPanel.sendImageList();
    } else {
      const panel = vscode.window.createWebviewPanel(
        'labelThumbnailGrid',
        '缩略图网格',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(folderPath)]
        }
      );

      ThumbnailGrid.currentPanel = new ThumbnailGrid(panel, stateManager, folderPath);
    }
  }

  /**
   * 发送图片列表到 webview
   */
  private sendImageList(): void {
    const folder = this._folderPath;
    const state = this._stateManager.get(folder);
    const images = this._images;

    const imageData = images.map(imgPath => {
      const fileName = path.basename(imgPath);
      const status = state.getStatus(fileName);
      const uri = this._panel.webview.asWebviewUri(vscode.Uri.file(imgPath));
      return {
        path: imgPath,
        fileName,
        status,
        uri: uri.toString()
      };
    });

    this._panel.title = `缩略图网格 - ${path.basename(folder)}`;

    this._panel.webview.postMessage({
      type: 'loadImages',
      images: imageData,
      folderPath: folder
    });
  }

  /**
   * 处理来自 webview 的消息
   */
  private handleMessage(message: { command: string; files?: string[]; status?: LabelStatus; filePath?: string }): void {
    switch (message.command) {
      case 'batchMark': {
        const files = message.files || [];
        const status = message.status || null;
        if (files.length > 0) {
          const folder = path.dirname(files[0]);
          const state = this._stateManager.get(folder);
          const updates: Record<string, LabelStatus> = {};
          for (const f of files) {
            updates[path.basename(f)] = status;
          }
          state.setStatusBatch(updates);
          this._stateManager.scheduleFlush();
          // 防抖树刷新 + 重新发送列表
          vscode.commands.executeCommand('label.refreshTree');
          // 重新发送列表
          this.sendImageList();
        }
        break;
      }

      case 'openViewer': {
        const filePath = message.filePath;
        if (filePath) {
          vscode.commands.executeCommand('label.openViewer', filePath);
        }
        break;
      }

      case 'refresh':
        this._images = scanImageFiles(this._folderPath);
        this.sendImageList();
        break;
    }
  }

  /**
   * 生成 HTML 内容
   */
  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>缩略图网格</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ====== 顶部工具栏 ====== */
    #toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: var(--vscode-titleBar-activeBackground, #252526);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      gap: 12px;
      flex-wrap: wrap;
    }
    #toolbar .left, #toolbar .right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .filter-btn {
      padding: 6px 14px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 16px;
      background: transparent;
      color: var(--vscode-editor-foreground);
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.15s;
      font-family: inherit;
    }
    .filter-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .filter-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }

    #stats { font-size: 12px; color: var(--vscode-descriptionForeground); }
    #selection-count { font-size: 12px; color: var(--vscode-textLink-foreground); display: none; }

    /* ====== 批量操作浮动栏 ====== */
    #batch-bar {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 10px 16px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 100;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    }
    #batch-bar.show { display: flex; }
    #batch-bar button {
      padding: 6px 14px;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.15s;
    }
    #batch-bar button:hover { filter: brightness(1.2); }
    #batch-keep { background: #2e7d32; color: #fff; }
    #batch-delete { background: #c62828; color: #fff; }
    #batch-clear { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }

    /* ====== 缩略图网格 ====== */
    #grid-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }
    #grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 10px;
    }
    .thumb-item {
      position: relative;
      aspect-ratio: 1;
      border-radius: 8px;
      overflow: hidden;
      cursor: pointer;
      border: 3px solid transparent;
      background: var(--vscode-input-background);
      transition: all 0.15s;
    }
    .thumb-item:hover { transform: scale(1.03); z-index: 2; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
    .thumb-item.selected { border-color: var(--vscode-focusBorder); }
    .thumb-item.status-keep { border-color: #4caf50; }
    .thumb-item.status-delete { border-color: #f44336; }
    .thumb-item.status-unreviewed { border-color: transparent; }

    .thumb-item img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    /* 状态标记角标 */
    .thumb-badge {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      color: #fff;
      pointer-events: none;
    }
    .badge-keep { background: #2e7d32; }
    .badge-delete { background: #c62828; }

    /* 选中勾选框 */
    .thumb-check {
      position: absolute;
      top: 6px;
      left: 6px;
      width: 20px;
      height: 20px;
      border-radius: 4px;
      background: rgba(0,0,0,0.5);
      border: 2px solid #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      color: #fff;
      opacity: 0;
      transition: opacity 0.15s;
      pointer-events: none;
    }
    .thumb-item.selected .thumb-check,
    .thumb-item:hover .thumb-check { opacity: 1; }
    .thumb-item.selected .thumb-check { background: var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }

    /* 文件名标签 */
    .thumb-label {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 4px 6px;
      background: linear-gradient(transparent, rgba(0,0,0,0.7));
      color: #fff;
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }

    /* ====== 空状态 ====== */
    #empty-state {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground);
      gap: 8px;
    }
    #empty-state.show { display: flex; }
    #empty-state .icon { font-size: 48px; opacity: 0.5; }
  </style>
</head>
<body>
  <div id="toolbar">
    <div class="left">
      <button class="filter-btn active" data-filter="all">全部</button>
      <button class="filter-btn" data-filter="unreviewed">未标注</button>
      <button class="filter-btn" data-filter="keep">保留</button>
      <button class="filter-btn" data-filter="delete">删除</button>
    </div>
    <div class="right">
      <span id="selection-count">已选: 0</span>
      <span id="stats"></span>
    </div>
  </div>

  <div id="grid-container">
    <div id="grid"></div>
    <div id="empty-state">
      <span class="icon">📂</span>
      <span>没有匹配的图片</span>
    </div>
  </div>

  <div id="batch-bar">
    <button id="batch-keep">✓ 批量保留</button>
    <button id="batch-clear">✕ 清除标注</button>
    <button id="batch-delete">🗑 批量删除</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const grid = document.getElementById('grid');
    const batchBar = document.getElementById('batch-bar');
    const selectionCount = document.getElementById('selection-count');
    const statsEl = document.getElementById('stats');
    const emptyState = document.getElementById('empty-state');

    // ====== 状态 ======
    let allImages = [];
    let selectedPaths = new Set();
    let currentFilter = 'all';
    let lastClickedIndex = -1;

    // ====== 筛选按钮 ======
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderGrid();
      });
    });

    // ====== 批量操作按钮 ======
    document.getElementById('batch-keep').addEventListener('click', () => {
      vscode.postMessage({ command: 'batchMark', files: Array.from(selectedPaths), status: 'keep' });
    });
    document.getElementById('batch-delete').addEventListener('click', () => {
      vscode.postMessage({ command: 'batchMark', files: Array.from(selectedPaths), status: 'delete' });
    });
    document.getElementById('batch-clear').addEventListener('click', () => {
      vscode.postMessage({ command: 'batchMark', files: Array.from(selectedPaths), status: null });
    });

    // ====== 点击空白区域取消选择 ======
    document.getElementById('grid-container').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        selectedPaths.clear();
        lastClickedIndex = -1;
        updateSelectionUI();
      }
    });

    // ====== 接收扩展消息 ======
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'loadImages') {
        allImages = msg.images;
        selectedPaths.clear();
        lastClickedIndex = -1;
        updateStats();
        renderGrid();
        updateSelectionUI();
      }
    });

    function updateStats() {
      const total = allImages.length;
      let kept = 0, deleted = 0, unreviewed = 0;
      for (const img of allImages) {
        if (img.status === 'keep') kept++;
        else if (img.status === 'delete') deleted++;
        else unreviewed++;
      }
      statsEl.textContent = '共 ' + total + ' 张 | 保留 ' + kept + ' | 删除 ' + deleted + ' | 未标注 ' + unreviewed;
    }

    function renderGrid() {
      grid.innerHTML = '';
      const filtered = currentFilter === 'all'
        ? allImages
        : allImages.filter(img => {
            if (currentFilter === 'unreviewed') return img.status === null;
            return img.status === currentFilter;
          });

      if (filtered.length === 0) {
        emptyState.classList.add('show');
        grid.style.display = 'none';
      } else {
        emptyState.classList.remove('show');
        grid.style.display = '';
      }

      filtered.forEach((img, idx) => {
        const item = document.createElement('div');
        item.className = 'thumb-item';
        item.dataset.path = img.path;
        item.dataset.index = idx;

        // 状态边框
        if (img.status === 'keep') item.classList.add('status-keep');
        else if (img.status === 'delete') item.classList.add('status-delete');
        else item.classList.add('status-unreviewed');

        // 选中状态
        if (selectedPaths.has(img.path)) item.classList.add('selected');

        // 缩略图
        const imgEl = document.createElement('img');
        imgEl.src = img.uri;
        imgEl.loading = 'lazy';
        imgEl.draggable = false;
        item.appendChild(imgEl);

        // 选中勾选框
        const check = document.createElement('div');
        check.className = 'thumb-check';
        check.textContent = selectedPaths.has(img.path) ? '✓' : '';
        item.appendChild(check);

        // 状态角标
        if (img.status === 'keep') {
          const badge = document.createElement('div');
          badge.className = 'thumb-badge badge-keep';
          badge.textContent = '✓';
          item.appendChild(badge);
        } else if (img.status === 'delete') {
          const badge = document.createElement('div');
          badge.className = 'thumb-badge badge-delete';
          badge.textContent = '✗';
          item.appendChild(badge);
        }

        // 文件名标签
        const label = document.createElement('div');
        label.className = 'thumb-label';
        label.textContent = img.fileName;
        item.appendChild(label);

        // 单击：选择
        item.addEventListener('click', (e) => {
          handleItemClick(img.path, parseInt(item.dataset.index), e);
        });

        // 双击：打开查看器
        item.addEventListener('dblclick', () => {
          vscode.postMessage({ command: 'openViewer', filePath: img.path });
        });

        grid.appendChild(item);
      });

      // 重新渲染后更新可能变化的选中UI
      updateSelectionUI();
    }

    function handleItemClick(path, index, event) {
      if (event.ctrlKey || event.metaKey) {
        // Ctrl+点击：切换选择
        if (selectedPaths.has(path)) {
          selectedPaths.delete(path);
        } else {
          selectedPaths.add(path);
        }
        lastClickedIndex = index;
      } else if (event.shiftKey && lastClickedIndex >= 0) {
        // Shift+点击：范围选择
        const filtered = getFilteredImages();
        const start = Math.min(lastClickedIndex, index);
        const end = Math.max(lastClickedIndex, index);
        if (!event.ctrlKey && !event.metaKey) selectedPaths.clear();
        for (let i = start; i <= end; i++) {
          selectedPaths.add(filtered[i].path);
        }
      } else {
        // 普通点击：单选
        if (selectedPaths.size === 1 && selectedPaths.has(path)) {
          selectedPaths.clear();
        } else {
          selectedPaths.clear();
          selectedPaths.add(path);
        }
        lastClickedIndex = index;
      }

      updateSelectionUI();
      // 更新 DOM 上的 selected 类
      document.querySelectorAll('.thumb-item').forEach(el => {
        const p = el.dataset.path;
        if (selectedPaths.has(p)) {
          el.classList.add('selected');
          el.querySelector('.thumb-check').textContent = '✓';
        } else {
          el.classList.remove('selected');
          el.querySelector('.thumb-check').textContent = '';
        }
      });
    }

    function getFilteredImages() {
      if (currentFilter === 'all') return allImages;
      return allImages.filter(img => {
        if (currentFilter === 'unreviewed') return img.status === null;
        return img.status === currentFilter;
      });
    }

    function updateSelectionUI() {
      const count = selectedPaths.size;
      if (count > 0) {
        batchBar.classList.add('show');
        selectionCount.style.display = '';
        selectionCount.textContent = '已选: ' + count;
      } else {
        batchBar.classList.remove('show');
        selectionCount.style.display = 'none';
      }
    }

    // 初始请求刷新
    vscode.postMessage({ command: 'refresh' });
  </script>
</body>
</html>`;
  }

  /**
   * 释放资源
   */
  private dispose(): void {
    ThumbnailGrid.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }
}
