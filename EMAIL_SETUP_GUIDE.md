# 📧 GameStudio 邮件汇报配置指南

## 📍 邮箱配置文件位置

**文件路径**：`/Volumes/ovokit2t/aiwork/gamestudio/.openclaw/email_config.sh`

请编辑此文件，填入你的邮箱信息：

```bash
# SMTP 服务器设置（以 QQ 邮箱为例）
SMTP_SERVER="smtp.qq.com"
SMTP_PORT="465"
SMTP_USER="your_email@qq.com"        # ← 在这里配置你的发件邮箱
SMTP_PASS="your_smtp_password"        # ← 在这里配置 SMTP 授权码（不是登录密码！）

# 收件人设置
RECIPIENT="your_email@qq.com"         # ← 在这里配置收件邮箱（可以和发件人相同）
SENDER_NAME="GameStudio Reporter"     # 发件人显示名称
```

## 🔑 如何获取 SMTP 授权码

### QQ 邮箱
1. 登录 QQ 邮箱网页版
2. 进入 **设置 → 账户**
3. 找到 **POP3/SMTP 服务**，点击 **开启**
4. 按提示发送短信验证
5. 获得 **授权码**（16 位字母，不是你的 QQ 密码）
6. 将授权码填入 `SMTP_PASS`

### 163 邮箱
1. 登录 163 邮箱网页版
2. 进入 **设置 → POP3/SMTP/IMAP**
3. 开启 **SMTP 服务**
4. 获得 **客户端授权码**
5. 填入 `SMTP_PASS`

### Gmail
1. 开启两步验证
2. 进入 **Google 账户 → 安全性 → 应用专用密码**
3. 生成新密码
4. 填入 `SMTP_PASS`

## ⏰ 定时任务配置

**定时任务文件**：`/Volumes/ovokit2t/aiwork/gamestudio/.openclaw/com.gamestudio.reporter.plist`

当前配置为 **每 3 小时执行一次**。

### 修改执行频率

编辑 plist 文件，修改 `<key>StartInterval</key>` 的值（单位：秒）：
- 每 1 小时：`3600`
- 每 3 小时：`10800`（当前）
- 每 6 小时：`21600`
- 每天一次：`86400`

### 或者使用固定时间点

取消注释 `<key>StartCalendarInterval</key>` 部分，可以指定每天的具体时间：
```xml
<key>StartCalendarInterval</key>
<array>
    <dict>
        <key>Hour</key>
        <integer>9</integer>   <!-- 每天 9:00 -->
    </dict>
    <dict>
        <key>Hour</key>
        <integer>12</integer>  <!-- 每天 12:00 -->
    </dict>
    <dict>
        <key>Hour</key>
        <integer>18</integer>  <!-- 每天 18:00 -->
    </dict>
</array>
```

## 🚀 手动测试

编辑好配置后，立即测试一次：

```bash
cd /Volumes/ovokit2t/aiwork/gamestudio
bash scripts/lifecycle/reporter_email.sh
```

检查你的邮箱是否收到汇报邮件。

## ⚙️ 启用/关闭定时汇报

完成邮箱配置后，执行：

```bash
cd /Volumes/ovokit2t/aiwork/gamestudio
bash scripts/lifecycle/setup_reporter_schedule.sh
```

查看是否已加载：

```bash
bash scripts/lifecycle/status_project.sh
```

关闭定时汇报：

```bash
bash scripts/lifecycle/teardown_reporter_schedule.sh
```

## 📋 邮件内容示例

```
📊 GameStudio 项目状态汇报
汇报时间：2026-04-13 17:45:00
=========================

🖥️ 核心服务状态
- Server (:1999): ✅ 运行中
- Editor (:8868): ✅ 可访问
- Gateway (:18789): ✅ 正常

🤖 AI 模型状态
- omlx 模型服务: ✅ 正常 (加载了 2 个模型)

💾 资源监控
- 磁盘空间: 45%

📋 任务进度
- 已完成: 3 项 | 待办: 2 项

待办任务列表:
[ ] 正式场景出图验证
[ ] 资产漂移记录

📈 今日进展
- 修复了 reporter 邮件发送功能
- 配置了定时汇报任务

=========================
汇报完毕。
```

## 🛠️ 故障排查

### 问题：收不到邮件
1. 检查 `email_config.sh` 中的邮箱地址是否正确
2. 检查 SMTP 授权码是否正确（注意不是登录密码）
3. 检查垃圾箱/垃圾邮件文件夹
4. 运行 `bash scripts/lifecycle/reporter_email.sh` 查看错误信息

### 问题：SMTP 连接失败
1. 检查防火墙是否阻止了 SMTP 端口（465 或 587）
2. 确认邮箱服务商的 SMTP 服务已开启
3. 尝试更换 SMTP 端口（465 → 587 或反之）

### 问题：定时任务不执行
1. 先执行一次 `bash scripts/lifecycle/setup_reporter_schedule.sh`
2. 检查 plist 文件是否已复制到 `~/Library/LaunchAgents/`
3. 运行 `launchctl list | grep gamestudio` 查看任务状态
4. 查看日志：`cat /tmp/gamestudio_reporter.log`
5. 重新加载任务：
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.gamestudio.reporter.plist
   launchctl load ~/Library/LaunchAgents/com.gamestudio.reporter.plist
   ```

## 📂 相关文件

| 文件 | 用途 |
|------|------|
| `.openclaw/email_config.sh` | 邮箱配置（需要编辑） |
| `scripts/lifecycle/reporter_email.sh` | 邮件汇报脚本 |
| `.openclaw/com.gamestudio.reporter.plist` | 定时任务配置 |
| `/tmp/gamestudio_reporter.log` | 执行日志 |
| `/tmp/gamestudio_reporter.err` | 错误日志 |
