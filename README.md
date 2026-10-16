# QQ Linux 通知补丁(v6.6)

修复 QQ Linux 3.2.34「收到新消息不弹系统通知」的本地补丁。
仅适用于 x64 Linux + KDE/GNOME 等标准通知环境 + /opt/QQ 安装的 QQ 3.2.34。

## 安装

```bash
cd qq-notify-patch
sudo ./install.sh        # 然后重启 QQ(完全退出托盘后重新打开)
```

## 卸载

```bash
sudo ./install.sh --restore
```

## 行为

- QQ **无焦点/被遮挡/最小化**时,新消息弹系统通知(标题=会话名,正文=消息预览)
- **免打扰**会话(灰色徽标)不弹
- 正在前台使用 QQ 时不弹(不打扰)
- **点击通知** → QQ 置前并打开对应会话
- 节流:同会话 20 秒最多 1 条;相同内容 45 秒去重;全局每分钟最多 4 条

## 已知限制

- 基于 QQ 渲染层 DOM 识别,腾讯更新 UI 后可能失效(此时无通知但 QQ 正常)
- 会话列表为虚拟滚动:列表可视区外的会话,首条消息内容可能显示为「(新消息)」(名字与提醒仍然正确)
- 极活跃的免打扰群会频繁重排会话列表,个别通知的正文会延迟数秒
- QQ 自动更新覆盖 /opt/QQ 后需重新安装本补丁

## 原理(一段话)

QQ Linux 的 Electron 主进程从不调用系统通知(缺省移植不完整,设置页亦无开关)。
本补丁通过 `package.json` 的 `main` 字段接管主进程入口,先注入补丁再链回原启动链;
补丁向所有 session 注册 preload,在渲染层监听会话列表的未读变化,
经 ipcMain 集中节流后用 Electron `Notification`(libnotify/D-Bus)发出系统通知。

## 文件

| 文件 | 作用 |
|---|---|
| `qq-notifier-main.js` | 主进程侧:节流裁决 + 发通知 + 点击打开会话 + preload 注入 |
| `qq-notifier-preload.js` | 渲染层侧:未读检测/免打扰过滤/预览提取 |
| `install.sh` | 安装/卸载(改 `/opt/QQ/resources/app`) |

日志:`~/.qq-notify-patch.log`(排障用)。
