import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LabelStateManager, LabelStatus } from '../state/labelState';
import { getSiblingImages, getImageIndex, scanImageFiles, isImageFile } from '../utils/fileUtils';

/**
 * ImageViewer — 单张大图预览 Panel
 *
 * 功能：大图显示 + 标注操作（保留/删除）+ 导航 + 跨文件夹自动跳转
 * 性能：标注操作纯内存，无同步 I/O 阻塞，支持 30〜120fps 快速标注
 *
 * 快捷键（在 webview 内被拦截处理）：
 *   K / → : 保留并跳到下一张
 *   D / ← : 删除并跳到下一张
 *   Space : 切换保留/删除
 *   ↑ : 上一张（不改变状态）
 *   ↓ : 下一张（不改变状态）
 */
export class ImageViewer {
  private static currentPanel: ImageViewer | undefined;

  /** 当查看器导航到新图片时触发，用于侧边栏跟随 */
  static onNavigate: ((imagePath: string) => void) | null = null;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _stateManager: LabelStateManager;
  private _disposables: vscode.Disposable[] = [];

  /** 当前状态 */
  /** 防抖刷新树视图的回调（由 extension.ts 注册） */
  static refreshTreeDebounced: (() => void) | null = null;

  private _currentImagePath: string = '';
  private _currentFolder: string = '';
  private _siblingImages: string[] = [];
  private _currentStatus: LabelStatus = null;

  /** 防止快速连续标注时并发执行（extension 端互斥） */
  private _busy: boolean = false;

  // ====== 播放模式状态 ======
  private _isPlaying: boolean = false;
  private _playbackTimer: ReturnType<typeof setInterval> | null = null;
  private _fps: number = 30;
  /** 播放时默认标注动作：帧被自动标记为此值，用户按键则标记相反值 */
  private _defaultPlaybackAction: 'keep' | 'delete' = 'keep';

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    stateManager: LabelStateManager,
    imagePath: string
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._stateManager = stateManager;
    this._currentImagePath = imagePath;
    this._siblingImages = getSiblingImages(imagePath);

    // 收集所有工作区根目录 + 当前图片所在目录作为 localResourceRoots
    const resourceRoots: vscode.Uri[] = [];
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        resourceRoots.push(folder.uri);
      }
    }
    const imageDir = vscode.Uri.file(path.dirname(imagePath));
    if (!resourceRoots.some(r => r.fsPath === imageDir.fsPath)) {
      resourceRoots.push(imageDir);
    }

    // 设置 webview 内容
    this._panel.webview.html = this.getHtmlContent();
    this._panel.webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots
    };

    // 监听面板关闭
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // 监听 webview 消息
    this._panel.webview.onDidReceiveMessage(
      this.handleMessage.bind(this),
      null,
      this._disposables
    );

    // 初始加载图片
    this.navigateToImage(imagePath);
  }

  /**
   * 获取或创建 ImageViewer 实例
   */
  static show(
    extensionUri: vscode.Uri,
    stateManager: LabelStateManager,
    imagePath: string
  ): void {
    if (ImageViewer.currentPanel) {
      // 复用现有面板 — 确保 localResourceRoots 包含新图片所在目录
      ImageViewer.currentPanel.ensureResourceRoot(imagePath);
      // 导航到新图片
      ImageViewer.currentPanel._panel.reveal(vscode.ViewColumn.Active);
      ImageViewer.currentPanel.navigateToImage(imagePath);
    } else {
      // 收集 localResourceRoots
      const resourceRoots: vscode.Uri[] = [];
      if (vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
          resourceRoots.push(folder.uri);
        }
      }
      const imageDir = vscode.Uri.file(path.dirname(imagePath));
      if (!resourceRoots.some(r => r.fsPath === imageDir.fsPath)) {
        resourceRoots.push(imageDir);
      }

      const panel = vscode.window.createWebviewPanel(
        'labelImageViewer',
        '图片查看器',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: resourceRoots
        }
      );

      ImageViewer.currentPanel = new ImageViewer(panel, extensionUri, stateManager, imagePath);
    }
  }

  /**
   * 确保 webview 的 localResourceRoots 包含指定图片所在的目录
   * 当导航到不同文件夹的图片时需要调用，否则图片会被 VS Code 安全策略拦截
   */
  private ensureResourceRoot(imagePath: string): void {
    const imageDir = vscode.Uri.file(path.dirname(imagePath));
    const currentRoots = this._panel.webview.options.localResourceRoots || [];
    const alreadyCovered = currentRoots.some(root => {
      // 检查 imageDir 是否在某个 root 的范围内
      return imageDir.fsPath.startsWith(root.fsPath) ||
        root.fsPath.startsWith(imageDir.fsPath);
    });

    if (!alreadyCovered) {
      const newRoots = [...currentRoots, imageDir];
      this._panel.webview.options = {
        ...this._panel.webview.options,
        localResourceRoots: newRoots
      };
    }
  }

  /**
   * 导航到指定图片
   */
  private navigateToImage(imagePath: string): void {
    this.ensureResourceRoot(imagePath);

    this._currentImagePath = imagePath;

    // 只在切换文件夹时重新扫描 sibling 列表（播放期间同一文件夹无需重复扫描）
    const newFolder = path.dirname(imagePath);
    if (newFolder !== this._currentFolder) {
      this._currentFolder = newFolder;
      this._siblingImages = getSiblingImages(imagePath);
    }

    this._currentStatus = this._stateManager.getFileStatus(imagePath);

    // 更新 webview 中显示的图片
    const imageUri = this._panel.webview.asWebviewUri(vscode.Uri.file(imagePath));
    const fileName = path.basename(imagePath);
    const index = getImageIndex(imagePath, this._siblingImages);
    const progress = this.getProgress();

    this._panel.title = `图片查看器 - ${fileName}`;

    // 通知侧边栏跟随（播放期间跳过，节省性能）
    if (ImageViewer.onNavigate && !this._isPlaying) {
      ImageViewer.onNavigate(imagePath);
    }

    this._panel.webview.postMessage({
      type: 'loadImage',
      imageUri: imageUri.toString(),
      fileName,
      index,
      total: this._siblingImages.length,
      status: this._currentStatus,
      progress
    });
  }

  /** 获取当前文件夹的标注进度 */
  private getProgress() {
    const folder = path.dirname(this._currentImagePath);
    const state = this._stateManager.get(folder);
    return state.getProgress(this._siblingImages.length);
  }

  /**
   * 处理来自 webview 的消息
   */
  private handleMessage(message: { command: string; [key: string]: any }): void {
    const mutatingCommands = ['keep', 'delete', 'toggle', 'clear'];

    // 播放模式下的标注消息：只标记不跳转（tick 负责跳转）
    if (this._isPlaying && (message.command === 'keep' || message.command === 'delete')) {
      this.markCurrentOnly(message.command as 'keep' | 'delete');
      return;
    }

    if (mutatingCommands.includes(message.command)) {
      if (this._busy) { return; }
      this._busy = true;
    }

    try {
      switch (message.command) {
        case 'keep':
          this.markAndAdvance('keep');
          break;

        case 'delete':
          this.markAndAdvance('delete');
          break;

        case 'toggle':
          if (this._isPlaying) { break; } // 播放中不允许 toggle
          this.toggleAndAdvance();
          break;

        case 'next':
          if (this._busy) { return; }
          this.navigateRelative(1);
          break;

        case 'prev':
          if (this._busy) { return; }
          this.navigateRelative(-1);
          break;

        case 'jump':
          if (this._busy) { return; }
          this.navigateToIndex(message.index);
          break;

        case 'clear':
          this.clearLabel();
          break;

        case 'ready':
          this.navigateToImage(this._currentImagePath);
          break;

        case 'openGrid':
          vscode.commands.executeCommand('label.openGrid', path.dirname(this._currentImagePath));
          break;

        // ====== 播放控制 ======
        case 'startPlayback':
          this.startPlayback(message.fps || 30, message.defaultAction || 'keep');
          break;

        case 'stopPlayback':
          this.stopPlayback();
          break;

        case 'overrideDefault':
          // 播放中用户按下反选键
          if (this._isPlaying) {
            const opposite = this._defaultPlaybackAction === 'keep' ? 'delete' : 'keep';
            this.markCurrentOnly(opposite);
          }
          break;

        case 'setDefaultAction':
          // 播放中切换默认标注行为（不中断播放）
          if (this._isPlaying) {
            this._defaultPlaybackAction = message.defaultAction as 'keep' | 'delete';
          }
          break;
      }
    } finally {
      if (mutatingCommands.includes(message.command)) {
        this._busy = false;
      }
    }
  }

  /** 标记并跳到下一张未标注的图片（由 handleMessage 做 _busy 互斥） */
  private markAndAdvance(status: 'keep' | 'delete'): void {
    // 纯内存操作 — 不触发同步磁盘 I/O
    this._stateManager.setFileStatus(this._currentImagePath, status);
    this._stateManager.scheduleFlush();

    this._currentStatus = status;

    // 通知 webview 状态已更新
    this._panel.webview.postMessage({
      type: 'statusUpdated',
      status,
      progress: this.getProgress()
    });

    // 防抖刷新侧边栏
    if (ImageViewer.refreshTreeDebounced) {
      ImageViewer.refreshTreeDebounced();
    }

    // 立即跳到下一张
    this.navigateToNextUnreviewed();
  }

  /** 切换状态并跳到下一张 */
  private toggleAndAdvance(): void {
    const newStatus: 'keep' | 'delete' =
      this._currentStatus === 'keep' ? 'delete' : 'keep';
    this.markAndAdvance(newStatus);
  }

  /**
   * 跳到下一张未标注的图片
   *
   * 优先级：
   *   1. 当前文件夹内，当前位置之后的第一张未标注
   *   2. 当前文件夹内，从头开始的第一张未标注（环回）
   *   3. 下一个文件夹的第一张未标注（跨文件夹）
   *   4. 所有文件夹都完成 → 显示庆祝提示
   */
  private navigateToNextUnreviewed(): void {
    // 阶段 1: 当前文件夹下，当前位置之后
    const currentIndex = getImageIndex(this._currentImagePath, this._siblingImages);
    for (let i = currentIndex + 1; i < this._siblingImages.length; i++) {
      if (this._stateManager.getFileStatus(this._siblingImages[i]) === null) {
        this.navigateToImage(this._siblingImages[i]);
        return;
      }
    }

    // 阶段 2: 当前文件夹内环回
    for (let i = 0; i < currentIndex; i++) {
      if (this._stateManager.getFileStatus(this._siblingImages[i]) === null) {
        this.navigateToImage(this._siblingImages[i]);
        return;
      }
    }

    // 当前文件夹全部标注完成 → 提示用户手动切换
    vscode.window.showInformationMessage('🎉 当前文件夹所有图片已标注完成！请在侧边栏切换到下一个文件夹继续');
    this._panel.webview.postMessage({
      type: 'allDone',
      progress: this.getProgress()
    });
  }

  /** 相对导航（上/下一张，不改变状态） */
  private navigateRelative(delta: number): void {
    const currentIndex = getImageIndex(this._currentImagePath, this._siblingImages);
    const newIndex = currentIndex + delta;

    if (newIndex >= 0 && newIndex < this._siblingImages.length) {
      this.navigateToImage(this._siblingImages[newIndex]);
    }
  }

  /** 跳转到指定索引 */
  private navigateToIndex(index: number): void {
    if (index >= 0 && index < this._siblingImages.length) {
      this.navigateToImage(this._siblingImages[index]);
    }
  }

  /** 清除当前图片的标注 */
  private clearLabel(): void {
    this._stateManager.setFileStatus(this._currentImagePath, null);
    this._stateManager.scheduleFlush();
    this._currentStatus = null;

    // 刷新侧边栏图标
    if (ImageViewer.refreshTreeDebounced) {
      ImageViewer.refreshTreeDebounced();
    }

    this._panel.webview.postMessage({
      type: 'statusUpdated',
      status: null,
      progress: this.getProgress()
    });
  }

  /**
   * 获取通知 webview 更新（由外部调用，比如快捷键命令）
   */
  static notifyStatusChange(status: LabelStatus, progress: any): void {
    if (ImageViewer.currentPanel) {
      ImageViewer.currentPanel._currentStatus = status;
      ImageViewer.currentPanel._panel.webview.postMessage({
        type: 'statusUpdated',
        status,
        progress
      });
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
  <title>图片查看器</title>
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
      user-select: none;
    }

    /* ====== 顶部信息栏 ====== */
    #info-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: var(--vscode-titleBar-activeBackground, #252526);
      border-bottom: 1px solid var(--vscode-panel-border);
      min-height: 44px;
      flex-shrink: 0;
    }
    #file-name { font-size: 14px; font-weight: 600; }
    #file-index { font-size: 12px; color: var(--vscode-descriptionForeground); }
    #status-badge {
      padding: 3px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      transition: all 0.2s;
    }
    .status-keep { background: #1b5e20; color: #a5d6a7; }
    .status-delete { background: #b71c1c; color: #ef9a9a; }
    .status-unreviewed { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

    /* ====== 图片显示区 ====== */
    #image-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      background: var(--vscode-editor-background);
      position: relative;
    }
    #main-image {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      transition: opacity 0.15s;
    }
    #image-container.dragover { background: var(--vscode-list-dropBackground); }

    /* 导航覆盖层 */
    .nav-zone {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 30%;
      cursor: pointer;
      z-index: 2;
    }
    .nav-zone:hover { background: rgba(255,255,255,0.03); }
    #nav-prev { left: 0; }
    #nav-next { right: 0; }

    /* ====== 底部操作栏 ====== */
    #action-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 10px 16px;
      background: var(--vscode-titleBar-activeBackground, #252526);
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    button {
      padding: 8px 18px;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: inherit;
    }
    button:hover { filter: brightness(1.2); transform: translateY(-1px); }
    button:active { transform: translateY(0); }

    #btn-keep { background: #2e7d32; color: #fff; }
    #btn-delete { background: #c62828; color: #fff; }
    #btn-clear { background: transparent; color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-panel-border); }
    #btn-grid { background: transparent; color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-panel-border); }

    .shortcut-hint { font-size: 10px; opacity: 0.7; margin-left: 4px; }

    /* ====== 进度条 ====== */
    #progress-bar {
      height: 3px;
      background: var(--vscode-progressBar-background);
      flex-shrink: 0;
      transition: width 0.3s;
    }

    /* ====== 全部完成遮罩 ====== */
    #done-overlay {
      display: none;
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 10;
      align-items: center;
      justify-content: center;
      flex-direction: column;
    }
    #done-overlay.show { display: flex; }
    #done-overlay .msg { font-size: 24px; font-weight: 700; margin-bottom: 12px; }
    #done-overlay .sub { font-size: 14px; color: var(--vscode-descriptionForeground); }

    /* ====== 播放指示器 ====== */
    #playback-indicator {
      display: none;
      position: absolute;
      top: 10px;
      left: 10px;
      padding: 5px 12px;
      background: rgba(255,152,0,0.85);
      color: #000;
      border-radius: 14px;
      font-size: 11px;
      font-weight: 700;
      z-index: 5;
      pointer-events: none;
    }
    #playback-indicator.show { display: block; }
    #playback-indicator.paused { background: rgba(255,255,255,0.7); }

    /* ====== 播放控制栏 ====== */
    #playback-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 8px 16px;
      background: var(--vscode-editorWidget-background);
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    #playback-bar label { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    #playback-bar select, #playback-bar input {
      padding: 4px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-size: 12px;
      font-family: inherit;
    }
    #fps-input { width: 50px; text-align: center; }
    #btn-play {
      padding: 6px 16px;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.15s;
      background: #e65100; color: #fff;
      min-width: 70px;
    }
    #btn-play:hover { filter: brightness(1.2); }
    #btn-play.paused { background: #2e7d32; }
    #default-action-toggle {
      padding: 4px 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-editor-foreground);
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      font-family: inherit;
      transition: all 0.15s;
    }
    #default-action-toggle.keep { background: #1b5e20; color: #a5d6a7; border-color: #2e7d32; }
    #default-action-toggle.delete { background: #b71c1c; color: #ef9a9a; border-color: #c62828; }

    /* 播放中隐藏导航覆盖层，防止误触 */
    body.playing .nav-zone { display: none; }
  </style>
</head>
<body>
  <div id="info-bar">
    <span id="file-name">-</span>
    <span id="playback-badge" style="display:none;font-size:11px;font-weight:700;color:#ff9800;">⏵ 播放中</span>
    <span id="status-badge" class="status-unreviewed">未标注</span>
    <span id="file-index">-/-</span>
  </div>

  <div id="progress-bar" style="width: 0%;"></div>

  <div id="image-container">
    <img id="main-image" src="" alt="" />
    <div id="playback-indicator">⏵ 播放中</div>
    <div class="nav-zone" id="nav-prev" title="上一张 (↑)"></div>
    <div class="nav-zone" id="nav-next" title="下一张 (↓)"></div>
    <div id="done-overlay">
      <div class="msg">🎉 全部标注完成！</div>
      <div class="sub">当前文件夹所有图片已标注完毕</div>
    </div>
  </div>

  <div id="action-bar">
    <button id="btn-delete">🗑 删除 <span class="shortcut-hint">(D / ←)</span></button>
    <button id="btn-clear">✕ 清除标注</button>
    <button id="btn-grid">⊞ 网格视图</button>
    <button id="btn-keep">✓ 保留 <span class="shortcut-hint">(K / →)</span></button>
  </div>

  <div id="playback-bar">
    <label>FPS</label>
    <select id="fps-preset">
      <option value="1">1</option>
      <option value="5">5</option>
      <option value="10">10</option>
      <option value="15">15</option>
      <option value="24">24</option>
      <option value="30" selected>30</option>
      <option value="60">60</option>
      <option value="120">120</option>
    </select>
    <label>默认</label>
    <button id="default-action-toggle" class="keep" title="播放时每帧的默认标注">保留</button>
    <button id="btn-play" class="paused">▶ 播放</button>
    <span style="font-size:11px;color:var(--vscode-descriptionForeground);">
      播放中按 <b style="color:#c62828;" id="override-hint">D</b> 反选
    </span>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // ====== 播放状态 ======
    let isPlaying = false;
    let defaultAction = 'keep';  // 'keep' | 'delete'

    // DOM elements
    const mainImage = document.getElementById('main-image');
    const fileNameEl = document.getElementById('file-name');
    const fileIndexEl = document.getElementById('file-index');
    const statusBadge = document.getElementById('status-badge');
    const progressBar = document.getElementById('progress-bar');
    const doneOverlay = document.getElementById('done-overlay');
    const playbackIndicator = document.getElementById('playback-indicator');
    const playbackBadge = document.getElementById('playback-badge');
    const btnPlay = document.getElementById('btn-play');
    const fpsPreset = document.getElementById('fps-preset');
    const defaultActionToggle = document.getElementById('default-action-toggle');
    const overrideHint = document.getElementById('override-hint');

    // ====== 按钮事件（标注） ======
    document.getElementById('btn-keep').addEventListener('click', () => {
      vscode.postMessage({ command: 'keep' });
    });
    document.getElementById('btn-delete').addEventListener('click', () => {
      vscode.postMessage({ command: 'delete' });
    });
    document.getElementById('btn-clear').addEventListener('click', () => {
      vscode.postMessage({ command: 'clear' });
    });
    document.getElementById('btn-grid').addEventListener('click', () => {
      vscode.postMessage({ command: 'openGrid' });
    });

    // 导航覆盖层点击
    document.getElementById('nav-prev').addEventListener('click', () => {
      vscode.postMessage({ command: 'prev' });
    });
    document.getElementById('nav-next').addEventListener('click', () => {
      vscode.postMessage({ command: 'next' });
    });

    // ====== 播放控制事件 ======
    btnPlay.addEventListener('click', () => {
      if (isPlaying) {
        vscode.postMessage({ command: 'stopPlayback' });
      } else {
        const fps = parseInt(fpsPreset.value) || 30;
        vscode.postMessage({ command: 'startPlayback', fps, defaultAction });
      }
    });

    defaultActionToggle.addEventListener('click', () => {
      defaultAction = defaultAction === 'keep' ? 'delete' : 'keep';
      updateDefaultActionUI();
      // 播放中切换默认行为，发送轻量更新（不重启播放）
      if (isPlaying) {
        vscode.postMessage({ command: 'setDefaultAction', defaultAction });
      }
    });

    function updateDefaultActionUI() {
      defaultActionToggle.textContent = defaultAction === 'keep' ? '保留' : '删除';
      defaultActionToggle.className = defaultAction;
      // 更新反选提示
      const oppKey = defaultAction === 'keep' ? 'D' : 'K';
      const oppLabel = defaultAction === 'keep' ? '删除' : '保留';
      overrideHint.textContent = oppKey;
      overrideHint.title = '按 ' + oppKey + ' 标记为' + oppLabel;
    }

    // ====== 键盘快捷键 ======
    let keyLocked = false;
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      const key = e.key.toLowerCase();

      // 空格：播放中 → 暂停/恢复；非播放 → 切换标注
      if (key === ' ') {
        e.preventDefault();
        if (isPlaying) {
          vscode.postMessage({ command: 'stopPlayback' });
        } else {
          if (keyLocked) return;
          keyLocked = true;
          setTimeout(() => { keyLocked = false; }, 10);
          vscode.postMessage({ command: 'toggle' });
        }
        return;
      }

      // P 键：播放/暂停
      if (key === 'p') {
        e.preventDefault();
        btnPlay.click();
        return;
      }

      // 播放模式下的按键处理
      if (isPlaying) {
        const oppositeKey = defaultAction === 'keep' ? 'd' : 'k';
        if (key === oppositeKey) {
          e.preventDefault();
          vscode.postMessage({ command: 'overrideDefault' });
        }
        // 播放中忽略其他标注/导航按键
        return;
      }

      // 非播放模式：原有快捷键
      const actionKeys = ['k', 'd', 'arrowright', 'arrowleft'];
      if (actionKeys.includes(key)) {
        if (keyLocked) { e.preventDefault(); return; }
        keyLocked = true;
        setTimeout(() => { keyLocked = false; }, 10);
      }

      switch (key) {
        case 'k':
        case 'arrowright':
          e.preventDefault();
          vscode.postMessage({ command: 'keep' });
          break;
        case 'd':
        case 'arrowleft':
          e.preventDefault();
          vscode.postMessage({ command: 'delete' });
          break;
        case 'arrowdown':
          e.preventDefault();
          vscode.postMessage({ command: 'next' });
          break;
        case 'arrowup':
          e.preventDefault();
          vscode.postMessage({ command: 'prev' });
          break;
      }
    });

    // ====== 处理扩展发来的消息 ======
    window.addEventListener('message', (event) => {
      const msg = event.data;

      switch (msg.type) {
        case 'loadImage':
          mainImage.src = msg.imageUri;
          fileNameEl.textContent = msg.fileName;
          fileIndexEl.textContent = (msg.index + 1) + ' / ' + msg.total;
          updateStatus(msg.status);
          updateProgress(msg.progress);
          doneOverlay.classList.remove('show');
          break;

        case 'statusUpdated':
          updateStatus(msg.status);
          updateProgress(msg.progress);
          break;

        case 'allDone':
          updateProgress(msg.progress);
          doneOverlay.classList.add('show');
          break;

        case 'playbackState':
          isPlaying = msg.isPlaying;
          updatePlaybackUI();
          break;
      }
    });

    function updatePlaybackUI() {
      if (isPlaying) {
        document.body.classList.add('playing');
        playbackIndicator.classList.add('show');
        playbackIndicator.classList.remove('paused');
        playbackBadge.style.display = '';
        btnPlay.textContent = '⏸ 暂停';
        btnPlay.classList.remove('paused');
      } else {
        document.body.classList.remove('playing');
        playbackIndicator.classList.add('show', 'paused');
        playbackIndicator.textContent = '⏸ 已暂停';
        setTimeout(() => { playbackIndicator.classList.remove('show'); }, 1500);
        playbackBadge.style.display = 'none';
        btnPlay.textContent = '▶ 播放';
        btnPlay.classList.add('paused');
      }
    }

    function updateStatus(status) {
      statusBadge.classList.remove('status-keep', 'status-delete', 'status-unreviewed');
      if (status === 'keep') {
        statusBadge.textContent = '✓ 保留';
        statusBadge.classList.add('status-keep');
      } else if (status === 'delete') {
        statusBadge.textContent = '✗ 删除';
        statusBadge.classList.add('status-delete');
      } else {
        statusBadge.textContent = '未标注';
        statusBadge.classList.add('status-unreviewed');
      }
    }

    function updateProgress(progress) {
      const pct = progress.total > 0
        ? Math.round((progress.reviewed / progress.total) * 100)
        : 0;
      progressBar.style.width = pct + '%';
    }

    // 通知扩展 webview 已就绪
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }

  /**
   * 只标记当前图片，不跳转（播放模式下使用）
   */
  private markCurrentOnly(status: 'keep' | 'delete'): void {
    this._stateManager.setFileStatus(this._currentImagePath, status);
    this._stateManager.scheduleFlush();
    this._currentStatus = status;

    this._panel.webview.postMessage({
      type: 'statusUpdated',
      status,
      progress: this.getProgress()
    });

    // 播放期间跳过树刷新（在 stopPlayback 时统一刷新一次）
    if (ImageViewer.refreshTreeDebounced && !this._isPlaying) {
      ImageViewer.refreshTreeDebounced();
    }
  }

  /**
   * 启动播放模式：按指定 FPS 自动前进，默认标记为 defaultAction
   *
   * 每 tick: ① 标记当前帧为默认值 → ② 前进到下一帧
   */
  private startPlayback(fps: number, defaultAction: 'keep' | 'delete'): void {
    if (this._isPlaying) { return; }

    this._fps = Math.max(1, Math.min(120, fps));
    this._defaultPlaybackAction = defaultAction;
    this._isPlaying = true;

    const intervalMs = Math.round(1000 / this._fps);

    // 立即执行第一帧标记并前进
    this._playbackTick();

    this._playbackTimer = setInterval(() => {
      this._playbackTick();
    }, intervalMs);

    this._panel.webview.postMessage({
      type: 'playbackState',
      isPlaying: true,
      fps: this._fps,
      defaultAction: this._defaultPlaybackAction
    });
  }

  /**
   * 停止播放模式
   */
  private stopPlayback(): void {
    if (!this._isPlaying) { return; }
    this._isPlaying = false;

    if (this._playbackTimer) {
      clearInterval(this._playbackTimer);
      this._playbackTimer = null;
    }

    // 播放结束后刷新树视图（播放期间的标注变更一次性同步到侧边栏）
    if (ImageViewer.refreshTreeDebounced) {
      ImageViewer.refreshTreeDebounced();
    }

    this._panel.webview.postMessage({
      type: 'playbackState',
      isPlaying: false,
      fps: this._fps,
      defaultAction: this._defaultPlaybackAction
    });
  }

  /**
   * 播放的一帧：① 默认标记当前 → ② 前进到下一张
   *
   * 播放模式顺序遍历所有图片，支持跨文件夹自动跳转。
   * 如果当前帧已被用户反选标记过（状态 ≠ 默认且 ≠ null），则跳过标记。
   */
  private _playbackTick(): void {
    // ① 标记当前帧（只在未标注或已是默认值时覆盖；用户的反选标记不会被覆盖）
    const currentStatus = this._stateManager.getFileStatus(this._currentImagePath);
    if (currentStatus === null || currentStatus === this._defaultPlaybackAction) {
      this.markCurrentOnly(this._defaultPlaybackAction);
    }

    // ② 前进到下一张
    const currentIndex = getImageIndex(this._currentImagePath, this._siblingImages);
    const nextIndex = currentIndex + 1;

    if (nextIndex < this._siblingImages.length) {
      this.navigateToImage(this._siblingImages[nextIndex]);
      return;
    }

    // 当前文件夹播完 → 自动暂停，等待用户手动进入下一个文件夹
    this.stopPlayback();
    vscode.window.showInformationMessage('⏸ 当前文件夹播放完毕，请手动切换到下一个文件夹后按 P 继续播放');
  }

  /**
   * 释放资源
   */
  private dispose(): void {
    this.stopPlayback();
    ImageViewer.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }
}
