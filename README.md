# Virtual Display (Cindy Plugin)

一个用于 **macOS** 的 [Cindy](https://cindy.dev) 虚拟显示器插件（软件替代 HDMI 欺骗器），通过 macOS 原生 `CGVirtualDisplay` 一键创建、切换分辨率和关闭虚拟屏幕，方便无物理显示器的 Mac 维持图形桌面会话、远程桌面以及应用保活。

## 功能特性
- **面板一键操作**：提供 `1080p`、`2K (1440p)`、`1440×900`、`720p`、`4K` 预设与自定义分辨率 / 刷新率 / HiDPI 创建，支持原地切换分辨率、单个或全部关闭。
- **AI 工具 & `$vdisplay`**：对话中可直接让 Cindy 查看在线显示器、创建、调整和关闭虚拟屏。
- **独立子进程隔离与自动回收**：每块虚拟屏由独立轻量级原生子进程托管（`arm64` + `x86_64` 通用二进制），关闭虚拟屏、停用插件或退出 Cindy 时自动断开回收，无残留虚拟屏。

## 安装方式

### 方式一：下载 Release `.cindy` 包（推荐）
1. 前往本仓库 **Releases** 页面下载 `virtual-display-1.0.0.cindy`。
2. 直接把 `.cindy` 文件拖入 Cindy 窗口，或在「插件 → 添加插件 → 从文件安装」中导入并确认权限。
3. 启用后在插件页点「使用」打开虚拟屏面板，或在对话中输入 `$vdisplay` 调用。

### 方式二：作为自定义插件市场订阅
在 Cindy「插件 → 添加插件 → 添加插件市场」中填入本仓库地址 `https://github.com/nocmk2/cindy-virtual-display`。

## 目录结构
- `ghost.json`：插件清单（`schemaVersion: 3`，`node.lifecycle: "resident"`）
- `main.js`：沙箱电子脑，桥接 AI 工具与面板请求
- `panel.html` / `panel.css` / `panel.js`：插件交互面板
- `node/worker.cjs`：常驻 Node JSON-RPC 工作进程，按屏托管原生子进程
- `native/virtual-display-helper.m` & `native/build.sh`：原生 macOS 虚拟显示器助手源码与构建脚本
- `bin/virtual-display-helper`：预编译好的通用二进制（`arm64` + `x86_64`）
- `assets/icon.png`：插件图标

## 从源码重新编译原生助手
```bash
./native/build.sh
```

## 注意事项
- **仅支持 macOS**（依赖 CoreGraphics 私有 `CGVirtualDisplay` 接口）。
- 虚拟屏在用户登录进图形桌面且 Cindy 启动后生效；如果无头 Mac 重启后停在系统登录界面，需配合 macOS「自动登录」使用。
