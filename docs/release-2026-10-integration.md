# release-2026-10 整合说明（t51）

> 目标：把 t39/t41/t45/t48(H3)/t49/t42(t43) 六条分支合流为**单一可部署分支** `release-2026-10`，
> 供一次停机窗口全量部署。本任务仅产出分支与证据：**未推 GitHub main、未 sync aliyun、未重建生产、未重启任何机器**。

## 1. 合入清单（部署前对账表）

| 来源分支 | 提交 | 内容 | 进入 release-2026-10 的合并提交 |
|---|---|---|---|
| origin/main | `15a89d1` | 基底（含 t33/t35/t37） | 分支起点 |
| origin/t39-gpu-uuid | `f82b904` | 硬件指纹 GPU UUID 三级回退 + hw_source 上报 | `dd32712` |
| t41（本地克隆 /tmp/cybercafe-t41） | `138e25a` | uninstall-all.sh 根目录统一下发 + 白名单作用域映射 + compose 扩挂载 | `07782a6` |
| origin/t45-layer-split | `c384da2` | 三层拆分（L2 脚本更新管理 / L3 独立模型脚本）+ 清理 .wt33 | `4cac737` |
| release-h3（本地克隆 /tmp/cybercafe-h3） | `24da1b2`（含 `6d3af53` t48 + t55 文档修复） | minimax-h3 CUDA 版 install/uninstall + README + nvml_monitor | `37cad37` |
| origin/t49-gpu-multi-source | `09b5a63` | GPU 多源采集（NVML v2 主源）+ ^GPU- 校验修 t40#4 + VERSION 0.6.0 | `473b8d5` |
| origin/t42-ocr-venv-fix | `2ea03ca` | ocr/install.sh venv 修复（t43 真机终验通过） | `b805e60` |

祖先链验证：`git merge-base --is-ancestor` 对 f82b904 / 138e25a / c384da2 / 6d3af53 逐一通过。

## 2. 冲突解决逐处留证

仅一处合并出现冲突：**release-h3 为独立仓库根（其根提交 `49a0352` 与主仓库无共同祖先），
采用 `--allow-unrelated-histories` 合法嫁接**（非 -X ours/theirs 蒙混），产生 4 处 add/add 冲突，逐处人工解决：

| 文件 | 两侧内容 | 最终取值 |
|---|---|---|
| `README.md`（根） | ours=项目 README（main+t41 集成版）；theirs=H3 部署文档（首行「# CyberCafe MiniMax-H3 本地部署」） | **保留 ours**（项目 README）+ 尾部追加一行指向 `minimax-h3/README.md` 的链接 |
| `minimax-h3/install.sh` | ours=107 行旧版（t25 预编译方案）；theirs=266 行 CUDA 编译版（t48/t55 最终） | **取 theirs**（266 行，sha256 `b2b8d725d2c0192f`，与队长核对的当前 sha 一致；契约里写的 252 行/`286c003e89f37447` 是 t48 阶段状态，t55 文档修复后为 266 行/`b2b8d725d2c0192f`，以当前为准） |
| `minimax-h3/uninstall.sh` | ours=旧版；theirs=新版 | **取 theirs** |
| `minimax-h3/README.md` | ours=旧 README；theirs=H3 部署文档（含档位/GPU 放置语义/卸载说明） | **取 theirs** |

其余分支（t39/t41/t45/t49/t42）合并全部干净（ort 策略自动合并，无冲突）。

**README 硬化复核**：`git diff origin/main:README.md HEAD:README.md` 仅含 ① t41 的目标机获取命令段（合法并入内容）
与 ② 我新增的 minimax-h3 指向行——H3 分支的引擎文档**未覆盖**根 README。

**根级文件审计**：release-h3 嫁接在根目录新增的文件仅 `nvml_monitor.py`（57 行，与
`minimax-h3/nvml_monitor.py` 逐字节一致，t56 确认的「双份一致」）；**无根级 install.sh 被覆盖**。
如队长认为根级 nvml_monitor.py 属冗余可后续单独清理，本任务按双份一致保留。

**cloud/.wt33 净化**：该 miniflare 测试残留（t33 时代误提交 main）随 t45 `c384da2` 删除，`git ls-tree -r HEAD cloud/` 0 命中。

## 3. Docker 镜像源死源修复（t51 顺带修的真缺陷）

**实测依据（2026-10-08，XZ-31-001/6026）**：`docker.m.daocloud.io` 拉 alpine 3.3s / ollama 1s（唯一可用源）；
另两个候选站与直连 docker.io 均 60s 超时；docker 对 registry-mirrors 多源并发会被死源拖垮。

**修法**（agent/cybercafe-deploy.py）：
- `REGISTRY_MIRRORS` 收窄为 `["https://docker.m.daocloud.io"]`（死源 URL 字面量从代码移除——
  契约 verify `! grep -q 'docker.1ms.run'` 为硬约束，故不能保留候选字面量；死源信息以注释记载）。
- 保留**健康探测机制**（`_probe_mirrors`，threading 标准库并行、3s 短超时、registry `/v2/` 任意应答含 401 即视为可达）：
  - daocloud **恒保底且排首位**（探测误判也保留，绝不写空列表）；
  - 全灭时保留候选原样 + 告警日志「所有镜像源探测失败，已保留候选原样写入，docker pull 可能变慢」；
  - 仅 `step_mirrors` 配置镜像时探测一次（非每次 deploy）；串行最坏 len×3s、并行收敛 ~3s（注释写明）。
- **ocr/install.sh pip 源核查**：`PIP_INDEX` 默认清华 pypi（`https://pypi.tuna.tsinghua.edu.cn/simple`）——可用国内源，无同类死源问题，无需修改。

## 4. 版本标注

- `agent/cybercafe-agent.py`：`VERSION = "0.6.0"`（t49 交付值）✓
- `agent/install.sh` / `agent/provision.sh`：`# Version: 1.0.2`（t49 已上调，与契约「取 t39 的 1.0.2」一致）✓
- `minimax-h3/install.sh`：保留自带版本注释（266 行最终版）✓

## 5. 验证命令与结果（全部通过）

| 验证 | 结果 |
|---|---|
| 祖先链（f82b904/138e25a/c384da2/6d3af53） | ANCESTRY-OK |
| 全仓库无冲突标记（cloud/agent/ocr/minimax-h3/uninstall-all.sh/README.md） | 0 命中 |
| `node --check cloud/src/index.js` + `py_compile`（agent.py + deploy.py） | SYNTAX-OK |
| `bash -n` ×6（install/provision/ocr/uninstall-all/minimax-h3 install+uninstall） | SHELL-OK |
| `REGISTRY_MIRRORS` 仅 daocloud、无 1ms 字面量 | MIRROR-FIXED |
| index.js：hw_source×5 / INSTALL_EXTRA_ALLOW×2（完整 5 项白名单）/ cybercafe-deploy.py×1 / RETIRE_AFTER_S×3 | 四关切全在 |
| index.html：hwSrc×2 / retire×25 / 指纹来源×1 / remote_ip×1 / `isOn ? "在线" : "离线"` 心跳语义 | 四关切全在 |
| minimax-h3/install.sh 266 行 sha `b2b8d725d2c0192f`；scripts/ 与 minimax-h3/ 双份逐字节一致（install+uninstall） | 一致 |
| `cloud/.wt33` 不在树上 | 0 命中 |
| L2→L3 链路：agent.py run_l3 三子命令（deploy/stop/restart_tunnel）调用 cybercafe-deploy.py | 在位（t45 交付 + t53 评审通过） |

## 6. 回归证据链引用

- **t50** 独立验收 10/10 PASS（覆盖 t49 GPU 多源采集链路）
- **t52** 评审 t49：verdict=pass（NVML v2 符号/无 v1 回退/四类异常降级/常量指纹零命中）
- **t53** 评审 t45 三层拆分：verdict=pass（L3 纯标准库 / L2 每次重取+校验+不静默回退 / L1 零改动 / 武装休眠熄火保留）
- **t56** 评审 t55（H3 文档修复）：verdict=pass（F1 VRAM 语义澄清 / F2 档位对齐，5/5）
- **t57** t40 缺陷#4 收口：修复在 t49/09b5a63，12 项 PASS
- **t43** OCR venv 修复真机终验：9 项全过（复现/修复/自愈/systemd/无-apt/未越界/卸载/终态）

## 7. 交付状态

- 分支：`release-2026-10`（本地 + GitHub 远程分支，未触碰 main）
- **未推 GitHub main**（`git log origin/main -1` 仍为 15a89d1）；未 sync aliyun；未重建生产容器；未重启任何机器
- 待用户放行后：合入 main → sync aliyun → 单次停机窗口全量部署（t35/t37/t39/t41/t45/t48/t49/t42 一并上线）
