# t103：禁止 unattended-upgrades 自动内核升级/自动重启（红线保护）

> 2026-10-10 · 部署运维 · 目标机：XZ-31-001(6026) / XZ-31-002(16721) · 修复状态：已落地两机并验证（t103 attempt 2fcc56dd）

## 背景
XZ-31-002(16721) 于 2026-10-10 05:12 被自动重启（uptime -s=05:12:25，journal boot0 05:12:33），违反用户「机器不得重启」红线。任务：禁用两机 unattended-upgrades 的自动内核升级与自动重启。

## 触发链取证（16721）
「unattended-upgrades 安装内核 27→34 后自动重启」的链**不成立**，证据：
- linux-image-6.14.0-34-generic 为 `ii`，但其安装记录在 `/var/log/dpkg.log.1` = **2025-10-31 14:39**（基础镜像构建期预装，非 05:12 安装）；
- `/boot` 无 vmlinuz-6.14.0-34（仅 vmlinuz-6.14.0-27），运行内核仍 `6.14.0-27`（uname 实证——重启并未换内核）；
- `/etc/apt/apt.conf.d/20auto-upgrades` = `Update-Package-Lists "0"` + `Unattended-Upgrade "0"`（周期通道实际关闭）；
- `/var/log/dpkg.log` 05:00-07:00 无任何内核安装动作；apt-daily-upgrade.timer 上次触发 06:38（在重启之后）。

**更可能的触发源**：厂商 swnetboot/swadmin 层（boot0 内核 cmdline `swsnapid` 由 2b5c4419 变为 a0afb583——厂商侧快照/维护动作）或基础镜像厂商服务。已如实记录；unattended-upgrades 从触发链中排除。

## 修复（两机一致）
写入 `/etc/apt/apt.conf.d/52cybercafe-no-kernel-reboot`：

```
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "false";
Unattended-Upgrade::Package-Blacklist {
    "linux-"; "linux-image-*"; "linux-headers-*"; "linux-modules-*";
    "linux-generic*"; "linux-hwe-*"; "linux-tools-*"; "linux-cloud-tools-*";
    "ubuntu-*linux*"; "nvidia-kernel-*";
};
```

等效机制（可逆）：
- `systemctl disable --now apt-daily-upgrade.timer`（apt-daily.timer 本就 masked）
- `systemctl disable unattended-upgrades.service`

恢复方法：`systemctl enable --now apt-daily-upgrade.timer unattended-upgrades.service` 并删除 52cybercafe-no-kernel-reboot。

## 验证
- `apt-config dump | grep Automatic-Reboot` → `"false"`（两机生效，非注释）；
- `systemctl is-enabled apt-daily-upgrade.timer unattended-upgrades.service` → disabled/disabled；
- uptime 修复前后一致（6026 boot 10-08 18:28:05；16721 boot 10-10 05:12:25），本任务未触发重启；
- 云管两机在线（XZ-31-001=4fcf67b40122、XZ-31-002=6cc579b23da3）。

## 副作用（如实记录）
05:12 重启后 provision 以 GPU 指纹（925d5bee165f）走 `prov:hw` 新建记录，XZ-31-002 云管设备 id 由 8d95cd4026aa 变为 **6cc579b23da3**（旧记录不在列表；机器在线正常，agent 0.7.0 以新 key 心跳）。

## 结论
两机不再会被自动更新（unattended-upgrades）触发重启或安装新内核——红线守住。