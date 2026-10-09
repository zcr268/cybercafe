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

## 7. t58 第二轮整合：t28/t29 镜像零残留修复（131511a）

> 来源：t28-fix-f1 分支 @ `131511a`（t29 真机验收 16721 发现 F1 必修缺陷：uninstall-all.sh 镜像精确前缀匹配不识别 `docker.m.daocloud.io/` mirror 前缀 repo，卸载后残留 ~6G 引擎镜像；F2 ocr/uninstall.sh --yes 接口对齐）。

- **合入提交**：`1375775`（merge commit，ort 策略无冲突）
- **祖先链**：`git merge-base --is-ancestor 941c54b release-2026-10` ✓ + `131511a` ✓（131511a 的父 15a89d1 已在链上，原始提交作为祖先合入，非 cherry-pick 副本）
- **F1 三处同口径**（uninstall-all.sh）：detect_items L117-120 / rm_images L203-218 / verify L293-300 均改包含匹配 `*"$r"*`（识别 daocloud mirror 前缀 repo）；删除改为**按镜像 ID**（`docker rmi -f '$id'`，连带镜像全部 tag 含 mirror 前缀 tag，层才真正释放）——t29 验收实测 Untagged 4 tag + Deleted 层、磁盘 21→16G
- **F2**（ocr/uninstall.sh）：`--yes` 兼容参数（接口对齐 uninstall-all.sh 聚合调用，本脚本无交互确认，接受即忽略）
- **验证（本轮重跑）**：冲突标记 0；node --check + py_compile（agent.py/deploy.py）+ bash -n 全部 sh 全过；minimax-h3/install.sh 与 scripts/install.sh 逐字节一致 sha `b2b8d725d2c0192f`；index.js 四关切（hw_source×5/INSTALL_EXTRA_ALLOW 完整 5 项/cybercafe-deploy.py/RETIRE_AFTER_S）全在；`origin/main` 仍 `15a89d1`

## 8. 交付状态

- 分支：`release-2026-10`（本地 + GitHub 远程分支，未触碰 main）；新 HEAD = `1375775`
- **未推 GitHub main**（`git log origin/main -1` 仍为 15a89d1）；未 sync aliyun；未重建生产容器；未重启任何机器
- 待用户放行后：合入 main → sync aliyun → 单次停机窗口全量部署（t35/t37/t39/t41/t45/t48/t49/t42/t28-fix 一并上线）

---

# 第三轮（t61，2026-10-09）：F1-R2 镜像零残留修复替换首轮过度删除版

## 背景
首轮（t58）合入的 F1 修复（131511a，`docker rmi -f <id>` 按 ID 强删）经 t29 对抗验收确认**中等缺陷**：
同一镜像 ID 同时挂引擎 tag 与非引擎 tag（如 `docker tag ollama/ollama:latest mykeep/util:latest`）时，
非引擎自定义 tag 被连带删光。开发测试修复版 F1-R2（t59 @ 2b190ea + 防御注释 6c83ba0），
部署运维真机复验（t60，16721/XZ-31-002）verdict=pass 8/8 全过。

## 合入记录
- 基线：origin/release-2026-10 = f256fc2（t58 收口态：1375775 首轮合并 + f256fc2 文档）
- 合入：origin/t28-fix-f1 @ 6c83ba0（含 2b190ea F1-R2 + 6c83ba0 防御注释）
- 新 HEAD：`6517213`（Merge remote-tracking branch 'origin/t28-fix-f1'）
- 祖先三证：941c54b（t51）/ 131511a（首轮 F1）/ 2b190ea（F1-R2）逐一 `is-ancestor` 通过

## 冲突解法
**零冲突**（ort 干净合并）：双方 uninstall-all.sh 均以 131511a 的 F1 为基底，2b190ea 的 F1→F1-R2 delta（33+/5-）直接应用；
ocr/uninstall.sh（F2）不受本轮影响。无 -X 蒙混（内容即 F1-R2 最终形态）。

## F1-R2 最终形态（uninstall-all.sh rm_images，自证）
- 引擎匹配 tag 先收集（tag+ID，dry-run 口径=包含匹配识别 mirror 前缀 repo 不变）
- 每 ID `docker inspect --format '{{range .RepoTags}}{{println .}}{{end}}'` 判定：
  全部 RepoTag 皆引擎匹配（line 232 `all_engine` 检查）→ `full_ids` → `docker rmi -f <id>`（连带释放层，line 245）；
  存在任一非引擎 tag → `shared_ids` → 仅 `docker rmi <tag>` untag 引擎 tag（line 236-237，非引擎层保留）
- t59 防御注释（真 dangling 镜像 .RepoTags 返回 [] 的语义）在位（line 221）
- **非首轮无脑 rmi -f 形态**（首轮路径已由本轮替换）

## 验证结果（本轮全绿）
| 项 | 结果 |
|---|---|
| 祖先三证（941c54b/131511a/2b190ea） | ANCESTRY-OK |
| 冲突标记（git grep 全树） | 0 |
| 语法门：node --check / py_compile（agent.py+deploy.py）/ bash -n 全部 .sh | SYNTAX-OK |
| H3 双份逐字节一致 + sha256 前16 `b2b8d725d2c0192f` | H3-COPIES-IDENTICAL |
| REGISTRY_MIRRORS daocloud-only + 探测机制未动；无 docker.1ms.run 字面量 | MIRROR-OK |
| index.js 四关切：hw_source=5 / INSTALL_EXTRA_ALLOW=2（5 项白名单完整）/ cybercafe-deploy.py=1 / RETIRE_AFTER_S=3 | 完整保留 |
| origin/main 未动 | 15a89d1 |
| t59 自验 + t60 真机独立复验 | pass（DinD 共享/纯引擎/daocloud 前缀/dry-run/幂等/防御注释） |

## 部署前对账（最终形态）
release-2026-10 = 6517213，可部署批次：t33/t35/t37/t39/t41/t45/t48(H3)/t49/t42(OCR)/t28-F1-R2 全量合一。

---

# 第四轮（t67，2026-10-09）：放行前预演修复 R2+R3 合流收口

## 背景
放行前预演（R 系列）发现两个真缺陷，均已修复并独立验证：
- **R2（t63，efe4e12）**：gpu_toolkit 外部源 curl 无超时 → 新机部署静默挂起 ~6min；修复 = 显式双超时（`--connect-timeout 10 --max-time 30`）+ curl 与 gpg/sed 分开执行取自身 rc（消除管道 rc 被掩盖的静默成功陷阱）+ `NVIDIA_TOOLKIT_BASE` 备用源环境变量 + apt 限时 + 失败如实 DeployError。
- **R3（t65，e26923b）**：SGLang 首部署网关自检与 nginx 启动时序竞争（瞬时 000 误判失败）；修复 = 网关自检 wall-clock 90s 硬上限有界退避（每 2s 一轮）。
- **R1 用户决策 = c)**：本次不使用 ollama、不 pin 版本、不升级驱动——本轮不含任何 ollama 改动。

## 合入记录
- 基线：origin/release-2026-10 = 3f1eafc（t61 第三轮收口态）
- 合入：origin/t63-gpu-timeout @ e26923b（含 efe4e12 R2 + e26923b R3）
- 新 HEAD：`07ab597`（Merge remote-tracking branch 'origin/t63-gpu-timeout'，仅 agent/cybercafe-deploy.py 43+/17-）
- 祖先六证：941c54b / 131511a / 2b190ea / 6c83ba0 / efe4e12 / e26923b 逐一 `is-ancestor` 通过

## 冲突解法
**零冲突**（ort 干净合并，队长预检确认；t63 分支基于 c384da2/t45、无 t51 镜像源修复，两侧改动位于不同函数区域——镜像源≈行 114-150 / R2 gpu_toolkit≈行 200-233 / R3 网关自检≈行 600+，并集合并无冲突）。无 -X 蒙混。

## 三套改动并集自证（最终 HEAD `git show HEAD:agent/cybercafe-deploy.py`）
1. **t51 镜像源修复（未被 R2 顶掉）**：`import threading`（L18）、`REGISTRY_MIRRORS = ["https://docker.m.daocloud.io"]`（L119）、`_probe_mirrors`（L189/219）✓
2. **R2**：`CURL = "curl -fsSL --connect-timeout 10 --max-time 30"`（L241）、`base = os.environ.get("NVIDIA_TOOLKIT_BASE", ...)`（L242）✓
3. **R3**：`total_cap = 90.0`（L642）+ 有界退避循环（L646）+ 超限如实 DeployError（L655）✓

## 验证结果（本轮全绿）
| 项 | 结果 |
|---|---|
| 祖先六证 | ANCESTRY-OK |
| 冲突标记（git grep 全树） | 0 |
| R2+R3 形态 grep | R2R3-FORM-OK |
| 语法门：node --check / py_compile×2 / bash -n 全部 .sh | SYNTAX-OK |
| H3 双份逐字节一致 + sha256 前16 `b2b8d725d2c0192f` | H3-COPIES-IDENTICAL |
| REGISTRY_MIRRORS daocloud-only + 探测未动；无 docker.1ms.run 字面量 | MIRROR-OK |
| index.js 四关切：hw_source=5 / INSTALL_EXTRA_ALLOW=2（5 项白名单完整）/ cybercafe-deploy.py=1 / RETIRE_AFTER_S=3 / fetchRepoFileRoot=4 | 完整保留 |
| origin/main 未动 | 15a89d1 |
| 依赖验证：t63 沙箱实测（源不可达 10.0s 如实 DeployError / 可达 3.0s / 已装 0.0s）+ t65 沙箱实测（延迟 5s→6.1s 成功 / 永不启动→93s 上限内如实 fail / 幂等 2.0s） | pass |

## 部署前对账（最终放行形态）
release-2026-10 = 07ab597，可部署批次：t33/t35/t37/t39/t41/t45/t48(H3)/t49/t42(OCR)/t28-F1-R2/t63-R2/t65-R3 全量合一；R1 决策 c) 已含（无 ollama 改动）。

---

# 第五轮（t73，2026-10-09）：功能上线轮——L1/L2 + 驱动版本 + 引擎徽标 + OCR/H3 页面选项合入 main

## 背景
本轮将四个页面功能上线合入 main（本轮 main 推进属预期功能上线；部署动作由队长复核后单独执行）：
- t69（24de542）：每台机器 L1/L2 分层脚本状态展示到云管页面（layers 心跳字段 + 三态通道 + 详情/一致性比对）
- t71（a13c794）：GPU 驱动版本采集 + Strata/ollama 引擎兼容徽标（动态比较）+ OCR 页面选项（一键装/卸）
- t74（483871b+84a827e）：H3 页面选项（组件区四态 + 安装/卸载/启停经云端下发）+ scripts/ 双份同步
- t76（5f8f7ca）：服务单元 sha 一致性对安装注入感知（注入件·不比对，消除真机恒 ⚠ 假警）

## 合入记录
- 基座：origin/main = d5a9ec8（release-2026-10 第四轮收口态，即放行批次全量）
- ① merge origin/t69-l1l2 @ 5f8f7ca（t69+t71+t76）——**fast-forward 快进**（该分支本就基于 release 链，0 冲突）
- ② merge origin/t74-h3-component @ 84a827e（t74 + scripts 同步）——ort 干净合并（0 冲突；index.html 的 H3 组件行与 layersDetail 服务单元行位于不同区域自动合并；minimax-h3/install.sh 与 scripts/install.sh 同步获得 76 行子命令增强后仍逐字节一致）
- 新 HEAD：见下（合并提交 t73-merge）

## 冲突解法
**零冲突**（快进 + ort 干净合并；两分支共同基点为 a13c794，各自增量区域不同；无 -X 蒙混）。

## 功能自证（逐一 grep 命中）
| 功能 | 位置与命中 |
|---|---|
| layers 心跳字段 | agent/cybercafe-agent.py ×10 |
| gpu_driver | agent/cybercafe-agent.py ×7 |
| 引擎要求表 | cloud/public/index.html L416-417 `const REQ = { strata: { min: 580...}, ollama: { min: 550...}}`（t72 已确认「徽标阈值 UI 硬编码」为设计；index.js 无此表系 t45 L3 拆分引擎定义移出所致，等价修正 grep 自证通过，援引 t57 先例）；`min_driver`（deploy.py ENGINES）×3 |
| ocr 路由与白名单 | index.js ×7（白名单 ocr/install.sh + ocr/uninstall.sh + ocr/ocr.py root 作用域） |
| h3 路由与白名单 | index.js ×2、agent.py run_h3 ×2（白名单 minimax-h3/install.sh + minimax-h3/uninstall.sh root 作用域） |
| components.ocr / components.h3 | agent.py 9/11 + index.js 2/2 |

## 验证结果（本轮全绿）
| 项 | 结果 |
|---|---|
| 祖先链：d5a9ec8 + t69(24de542) + t71(a13c794) + t74(483871b) + t76(5f8f7ca) | ANCESTRY-OK（逐一 is-ancestor） |
| 冲突标记（git grep 全树）/ 测试残留 | 0 / 无（wrangler.toml 为合法配置误报） |
| 白名单（扩展后 10 项：原 5 + ocr×3 + minimax-h3×2） | 完整 |
| 语法门：node --check / py_compile ×2 / bash -n 全部 .sh | SYNTAX-OK |
| H3 双份逐字节一致 + sha256 前8 `a10fc203`（t74 后新 sha，不再引用旧 b2b8d725d2c0192f） | H3-COPIES-IDENTICAL |
| GPU 放置语义 + 真机修复标记（offload-to-cpu×5 / LD_LIBRARY_PATH×2 / CUDA_ENV#PATH×1 / --recursive×3 / cc1plus×5） | 保留 |
| REGISTRY_MIRRORS daocloud-only + 探测未动；无 docker.1ms.run 字面量 | MIRROR-OK |
| 依赖验证：t69 自验（三态通道/一致性翻转红线）、t72 沙箱端到端 8/8、t75 沙箱 8 项、t76 双向实证 | 全过 |

## 部署前对账（main 最终形态）
main = 本轮新 HEAD（含 release-2026-10 全量 + L1/L2 + 驱动徽标 + OCR/H3 页面选项）。部署动作由队长复核后执行；未 sync aliyun / 未重建生产容器 / 未重启机器。
