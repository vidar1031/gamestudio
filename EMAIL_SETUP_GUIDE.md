# GameStudio 邮件汇报指南（当前生效版）

## 当前发送方式

- 发送脚本优先使用 macOS Mail App（AppleScript），失败时回退 sendmail。
- 当前链路不依赖 SMTP 授权码配置。
- 邮件配置文件：`/Volumes/ovokit2t/aiwork/gamestudio/.openclaw/email_config.sh`

当前有效字段：

```bash
SENDER_EMAIL="..."
RECIPIENT="..."
SENDER_NAME="GameStudio Reporter"
SUBJECT_PREFIX="[GameStudio]"
```

## 手动发送测试

```bash
cd /Volumes/ovokit2t/aiwork/gamestudio
bash scripts/lifecycle/reporter_email.sh
```

成功标志（任一）：

- `邮件已通过 Mail App 发送至: ...`
- `邮件已通过 sendmail 发送至: ...`

## 定时任务（launchd）

### 启用

```bash
cd /Volumes/ovokit2t/aiwork/gamestudio
bash scripts/lifecycle/setup_reporter_schedule.sh
```

### 状态检查

```bash
bash scripts/lifecycle/status_project.sh
```

### 关闭

```bash
bash scripts/lifecycle/teardown_reporter_schedule.sh
```

## 已知限制（重要）

在本机当前环境中，`launchd` 读取外置盘路径 `/Volumes/ovokit2t/...` 的脚本可能被系统策略拦截，表现为：

- `last exit code = 126`
- `Operation not permitted`
- 日志出现 `Sandbox deny file-read-data ... reporter_email.sh`

这表示“定时任务已加载但执行失败”。手动执行脚本通常正常。

## 故障排查

### 1) 手动可发，定时不发

先看状态：

```bash
launchctl print gui/$(id -u)/com.gamestudio.reporter | head -120
tail -n 80 /tmp/gamestudio_reporter.err 2>/dev/null || true
```

若见 `Operation not permitted`，优先使用手动发送，或将执行链路迁移到不受限路径。

### 2) Mail App 无已发送记录

- 确认 Mail 已配置账号并可手发邮件。
- 再执行：`bash scripts/lifecycle/reporter_email.sh`
- 检查垃圾箱/所有邮件与发件箱。

### 3) 收件地址错误

编辑：`/Volumes/ovokit2t/aiwork/gamestudio/.openclaw/email_config.sh`，只保留目标邮箱即可。

## 相关文件

- `.openclaw/email_config.sh`
- `scripts/lifecycle/reporter_email.sh`
- `scripts/lifecycle/setup_reporter_schedule.sh`
- `scripts/lifecycle/teardown_reporter_schedule.sh`
- `.openclaw/com.gamestudio.reporter.plist`
