---
layout: post
title: UE5 Mover 详解
subtitle: 从官方示例到自定义移动模式与联机预测
author: KivenWu
header-style: text
tags:
  - UE5
  - Mover
  - Movement
  - Networking
  - Gameplay
  - C++
---

> 编写与核验日期：2026-09-09  
> 主基线：本机安装的 **Unreal Engine 5.8.1**；附 **5.5.4** 差异说明。  
> 面向读者：了解 UE 编辑器、Pawn、蓝图和基础输入；C++ 章节需要了解 Unreal 类与模块。  
> 教程性质：官方资料研究 + 本地引擎源码核对 + 教学实现方案。**没有启动编辑器执行 PIE，也没有编译本文 C++ 示例。**

**先说结论：Mover 是可组合的移动模拟框架，不是“给 Character 换个组件就自动解决联机”的开关。**

学习它最重要的变化是：从“输入事件立即修改角色”，转向“收集输入命令，在模拟步中计算和执行移动，再把模拟状态用于显示与同步”。

本机 `Mover.uplugin` 在 5.8.1 中仍设置 `IsExperimentalVersion: true`。因此，本文不把 Mover 描述为已稳定替代 CharacterMovementComponent 的产品，也不把“本机安装版本”当作“当前全球最新版本”。[^L01][^L02]

---

## 目录

1. [阅读方式与版本边界](#s01)
2. [Mover 解决什么问题](#s02)
3. [架构：输入、模式、叠加移动与状态](#s03)
4. [实验一：跑通官方示例](#s04)
5. [实验二：建立自己的 Mover 角色](#s05)
6. [输入系统：从 Enhanced Input 到 InputCmd](#s06)
7. [调出可控的基础移动手感](#s07)
8. [实验三：短距离冲刺](#s08)
9. [瞬时效果、姿态与模式转换](#s09)
10. [实验四：C++ 自定义限速飞行模式](#s10)
11. [进阶设计：攀爬、滑行、滑索与体力](#s11)
12. [联机预测、回滚与同步边界](#s12)
13. [动画、根运动与 Motion Matching](#s13)
14. [AI、寻路与移动平台](#s14)
15. [Chaos Mover：物理驱动路线](#s15)
16. [调试工具与故障排查](#s16)
17. [UE 5.5.4 与 5.8.1 差异](#s17)
18. [项目落地、学习路线与验收清单](#s18)
19. [源码阅读顺序与术语速查](#s19)
20. [参考资料与核验记录](#s20)

---

<a id="s01"></a>
## 1. 阅读方式与版本边界

### 1.1 建议阅读顺序

- **想先看到效果**：第 4、5、7 章。
- **想知道为什么这样设计**：第 2、3、6 章。
- **想做冲刺或技能位移**：第 8、9、12 章。
- **想写 C++ 扩展**：第 10、11、19 章。
- **想接动画或 AI**：第 13、14 章。
- **想做真实物理交互**：先完成普通 Mover，再读第 15 章。
- **从旧教程迁移**：先读第 17 章，再复制任何代码。

### 1.2 本文实际核验了什么

通过本机安装记录和文件读取，确认：

| 项目 | 本机结果 |
|---|---|
| 主引擎 | `C:\Program Files\Epic Games\UE_5.8` |
| 主引擎实际版本 | `5.8.1`，Changelist `56057345` |
| 对照引擎 | `D:\UE_5.5` |
| 对照引擎实际版本 | `5.5.4`，Changelist `40574608` |
| Mover 插件目录 | `Engine\Plugins\Experimental\Mover` |
| 示例插件目录 | `Engine\Plugins\Experimental\MoverExamples` |
| 5.8 的物理路线插件 | `Engine\Plugins\Experimental\ChaosMover` |

正文中的类名、关键函数签名、示例资源名和版本差异优先按这些安装文件核验。网页文档用于说明框架概念和学习入口；**当网页、README、实际资源冲突时，以目标版本文件和编辑器实际内容为准**。[^L01][^L02][^L03]

### 1.3 三种内容标签

- **源码已核对**：函数、字段、资源或声明在本机目标版本中确实存在。
- **教学示例**：本文编写的代码或操作方案；接口经过核对，但不代表已经编译、运行或完成联机验收。
- **设计伪代码**：描述控制流和数据责任，不是可直接粘贴编译的 Unreal API。

本文不提供“未经实测却宣称生产可用”的完整联网角色工程。它提供的是可逐步复现的学习路径、实际入口、扩展范例以及验证方法。

- **配图说明**：文中“教学示意”图为本文自绘，用于解释结构关系，不是编辑器截图；标注“图源：Epic 官方文档”的截图来自 Epic 在线文档（UE 5.8 文档页），与本机 5.8.1 的界面可能存在细节差异。

---

<a id="s02"></a>
## 2. Mover 解决什么问题

### 2.1 先建立正确定位

传统角色项目常见组合是：

```text
ACharacter
  + Capsule
  + SkeletalMesh
  + CharacterMovementComponent
```

Mover 把重点放在“移动模拟如何组织”上：

```text
Actor / Pawn
  + 被移动的 SceneComponent
  + MoverComponent 或 CharacterMoverComponent
  + Movement Modes
  + 输入生产者
  + 驱动模拟的 Backend Liaison
```

Mover 核心不要求宿主继承 `ACharacter`，也不强制必须有骨骼网格或竖直胶囊；但它提供的默认角色运动集合仍有自己的碰撞和组件组合假设。**框架支持灵活组合，不等于每个默认模式都能无修改适配任意物体。**[^O01][^L02]

### 2.2 与 CharacterMovementComponent 的比较

| 维度 | CharacterMovementComponent，简称 CMC | Mover |
|---|---|---|
| 常见宿主 | `ACharacter` | `Actor` 或 `Pawn`，不要求 `ACharacter` |
| 模式扩展 | 常在组件子类与 Custom Movement 逻辑中扩展 | 使用独立 Movement Mode 对象组合 |
| 短期位移能力 | 常使用 Root Motion Sources 等机制 | 使用 Layered Moves 等机制 |
| 瞬间改动移动状态 | 有 Launch、Teleport 等既有流程 | 可通过 Instant Movement Effects 进入模拟 |
| 附加输入与状态 | 通常需要定制组件与网络移动数据 | 可组合输入和同步状态数据块 |
| 联机组织 | 有自己成熟的角色移动复制流程 | 根据 backend 接入 Network Prediction 或 Chaos 网络物理 |
| 使用风险 | 既有项目迁移成本通常较低 | 实验性 API、数据和工作流仍会变化 |

这是架构对照，不是“CMC 已经过时”的结论。Epic 的文档把 Mover 定位为潜在后继者，同时保留实验性警告。[^O02][^L02]

### 2.3 什么时候值得投入

以下是基于框架结构的工程建议，不是 Epic 的兼容性保证：

- 有多种可组合移动能力，需要避免一个巨大的移动组件子类。
- 需要把移动输入与可回滚状态明确分层。
- 角色之外的平台、特殊 Pawn 也需要复用移动框架。
- 愿意锁定引擎版本，并维护实验性插件升级测试。
- 可以先做小范围原型，再决定是否迁移整个项目。

不建议仅因为“新”就重写已经稳定运行的 CMC 系统。先验证你真正需要的功能，例如复杂平台、技能位移、GAS 配合、服务器规模和目标平台性能。

### 2.4 五个常见误解

1. **Mover 不等于 Motion Matching。** 前者负责移动模拟，后者属于动画选择与呈现。
2. **Mover 不等于刚体角色。** 普通运动学路线与 Chaos 物理路线要分别配置。
3. **启用插件不等于迁移完成。** Pawn 组成、输入、动画、AI 与复制流程都需要适配。
4. **可预测不等于任意逻辑都可回滚。** 外部状态、随机数、计时器和副作用仍需要设计。
5. **本地 Queue 一次不等于整个能力已经正确联网。** 谁提交、何时模拟、怎样重放，都必须明确。

---

<a id="s03"></a>
## 3. 架构：输入、模式、叠加移动与状态

### 3.1 一张总图

```text
玩家输入 / AI 决策
        |
        v
缓存输入意图与按钮边沿
        |
        v
Input Producer
        |
        v
FMoverInputCmdContext
        |
        v
Backend 驱动模拟步
        |
        +--> 读取起始同步状态
        |
        +--> 当前 Movement Mode 生成 Proposed Move
        |
        +--> Layered Moves 生成附加 Proposed Move
        |
        +--> Movement Mixer 组合提案
        |
        +--> 当前 Movement Mode 执行碰撞与实际移动
        |
        v
输出 FMoverSyncState
        |
        +--> 后端同步 / 必要时校正与重模拟
        |
        +--> 视觉平滑、动画和表现层读取
```

[![图 1：Mover 模拟步的四个阶段](/img/in-post/ue5-mover/schematic-simulation-step.png)](/img/in-post/ue5-mover/schematic-simulation-step.png)

*图 1：模拟步“提案 → 合并 → 执行”的四个阶段；输入与起始状态共同供给两条提案分支（教学示意图，与上方文字图互为补充）。*

这是概念图，**不是逐函数的完整调用顺序**。实际模拟还会处理转换、Instant Effects、Modifiers 和子步；落地等事件可能让一个模拟步在多个模式之间分段消耗时间。[^O01][^L02][^L05]

### 3.2 必须掌握的七个概念

| 概念 | 典型类型 | 责任 | 使用场景 |
|---|---|---|---|
| Movement Mode | `UBaseMovementMode` | 生成移动意图并执行移动 | Walking、Falling、Flying、Climbing |
| Layered Move | `FLayeredMoveBase`；新版还提供 `ULayeredMoveLogic` | 生成临时附加移动，不单独代替活动模式执行碰撞 | 冲刺、击退、根运动 |
| Instant Movement Effect | `FInstantMovementEffect` | 在模拟允许的窗口直接改变移动状态 | 传送、瞬时速度改变 |
| Movement Modifier | `FMovementModifierBase` | 改变影响移动的条件，不负责提议或执行位移 | 蹲伏、姿态变化 |
| Transition | `UBaseMovementModeTransition` | 根据状态判断并触发模式切换 | 离地、落地、进入攀爬 |
| Backend Liaison | 如 `UMoverNetworkPredictionLiaisonComponent` | 将 Mover 接入驱动与同步系统 | 单机或联机模拟 |
| Sync State | `FMoverSyncState` 与其中的数据集合 | 记录某一模拟时间点的状态 | 位置、速度、自定义移动状态 |

**一个时刻只激活一个基础 Movement Mode，但可以同时存在多个 Layered Moves。** Layered Move 的混合策略与优先级决定最终提案，不应把它们当成随意相加的位移列表。[^O01][^L02][^L08]

### 3.3 Generate Move 与 Simulation Tick 的分工

以 Flying 为例：

- `GenerateMove_Implementation`：读取输入、起始速度和设置，计算期望线速度与角速度。
- `SimulationTick_Implementation`：使用提案尝试实际移动，处理阻挡，将结果写入输出状态。

因此：

- 想调整期望速度或转向逻辑，优先看 Generate Move。
- 想改变与地面、墙体或约束的交互，通常要看 Simulation Tick。
- 只生成 `FProposedMove`，并不代表角色已经移动。
- 不能在 Generate Move 中直接 `SetActorLocation`，再让 Simulation Tick 重复处理一次。

5.8.1 的 `UFlyingMode` 就按这个结构实现：先计算受控自由移动，再执行安全移动与碰撞处理。[^L07]

### 3.4 状态应该放在哪里

| 数据 | 推荐位置 | 说明 |
|---|---|---|
| 当前摇杆方向、按钮是否按住 | 输入命令 | 表示本次模拟要尝试的操作 |
| 本次刚按下冲刺 | 输入命令中的边沿或请求序号 | 不能完全依赖普通 Pawn 的临时布尔值 |
| 冲刺剩余冷却、体力、已接受请求序号 | 需要参与移动预测的同步状态 | 回滚后应恢复到对应模拟时间 |
| 永久不变的最大速度、加速度参数 | 模式配置或 Shared Settings | 各端应采用一致配置 |
| 地面检测缓存、可重算结果 | Blackboard 等缓存 | 要考虑回滚失效或恢复规则 |
| 镜头晃动、粒子是否已播 | 表现层及去重记录 | 不应成为移动模拟的唯一依据 |

这里是工程分层建议；并不是说所有业务数据都必须塞进 Mover。库存、任务等不参与移动预测的状态，可以留在各自系统。

### 3.5 时间单位必须区分

本机 5.8.1 的 `FMoverTimeStep` 包含：

- `ServerFrame`：模拟帧索引。
- `BaseSimTimeMs`：`double`，模拟起始时间，单位毫秒。
- `StepMs`：`float`，本次模拟的时间长度，单位毫秒。

速度通常使用厘米/秒，所以模拟中积分应转换：

```cpp
const float DeltaSeconds = TimeStep.StepMs * 0.001f;
const FVector MoveDelta = ProposedVelocity * DeltaSeconds;
```

这是时间单位示例，`ProposedVelocity` 代表你已取得的速度，不是全局 API。

不要把 `BaseSimTimeMs` 当增量，也不要用渲染帧的 `DeltaSeconds` 替代模拟步长。输入生产示例中的参数命名也不值得据此推断时间语义：**以调用链和 `FMoverTimeStep` 为准**。[^L06][^L07]

---

<a id="s04"></a>
## 4. 实验一：跑通官方示例

目标：在不写移动代码的前提下，确认插件、输入、角色和 backend 能正常运行。

### 4.1 建立隔离练习项目

1. 使用 UE 5.8.1 新建 Blank 项目，命名例如 `MoverLab`。
2. 蓝图项目足以完成前几个实验；要做第 10 章，可创建 C++ 项目或之后添加 C++ 类。
3. 不要先在正在开发的主项目里替换现有角色。
4. 打开 **Edit → Plugins**，搜索并启用：
   - `Mover`
   - `Mover Examples`
5. 接受编辑器提示的依赖插件，重启编辑器。

本机 5.8.1 的 `MoverExamples.uplugin` 依赖 Mover、ChaosMover、EnhancedInput 和 CableComponent。看到额外插件被启用不代表你已经切换到物理 backend；具体角色采用哪条路线还要看组件配置。[^L03]

### 4.2 找到插件内容

在 Content Browser / Content Drawer 的 Settings 中开启 **Show Plugin Content**。不同编辑器布局的入口位置可能不同，优先搜索英文选项名称。

在内容浏览器搜索：

```text
L_CharacterMovementBasics
```

其本机文件位置为：

```text
C:\Program Files\Epic Games\UE_5.8\Engine\Plugins\Experimental\MoverExamples\Content\Maps\L_CharacterMovementBasics.umap
```

如果完全搜不到：

1. 确认 `Mover Examples` 已启用，而不只是 `Mover`。
2. 确认显示插件内容。
3. 清除内容浏览器当前目录和资产类型过滤。
4. 确认使用的是 UE 5.8.1，而不是其他关联引擎。

### 4.3 普通 Network Prediction 路线的起始配置

按照插件 README 的建议，在 Project Settings 中搜索 Network Prediction：

| 设置 | 起始值 | 目的 |
|---|---|---|
| Preferred Ticking Policy | `Fixed` | 采用固定频率模拟 |
| Simulated Proxy Network LOD | `Interpolated` | 让非本地控制角色采用插值显示 |
| Enable Fixed Tick Smoothing | 开启 | 缓解固定模拟与可变渲染频率之间的视觉不连续 |

角色 Mover 组件中的 `Smoothing Mode` 使用 `Visual Component Offset`，并确认 Primary Visual Component 指向正确的视觉组件。[^O03][^L02][^L05]

**注意：这是本文普通运动学路线的起点，不是 Chaos 物理路线的通用配置。**

[![图 2：跑通官方示例的设置流程](/img/in-post/ue5-mover/schematic-project-setup.png)](/img/in-post/ue5-mover/schematic-project-setup.png)

*图 2：启用插件、显示插件内容、打开示例地图的流程，以及普通 Network Prediction 路线的起始配置（教学示意图）。*

### 4.4 第一次 PIE 应验证什么

打开 `L_CharacterMovementBasics` 后执行 Play：

- 能控制地图默认提供的角色。
- 沿地面移动正常。
- 遇到墙壁不会直接穿过。
- 能体验台阶、斜坡、离地和落地。
- 按键以地图内说明及 `IMC_MoverMappingContext` 为准，不依赖网络教程中的截图。

不要第一步就换模型、换动画、改复制开关或加技能。先保留一个能运行的官方基线。

### 4.5 建议依次查看的地图

以下名称来自本机 5.8.1 的真实 `.umap` 文件列表：

| 地图 | 学习目标 |
|---|---|
| `L_CharacterMovementBasics` | 基础角色移动 |
| `L_LayeredMoves` | 各类临时叠加移动 |
| `L_InstantMovementEffects` | 瞬时移动状态改变 |
| `L_BasedMovement` | 站在移动对象上 |
| `L_PathfindingMovement` | 寻路与导航移动 |
| `L_PathedMovement` | 路径移动示例 |
| `L_DetourCrowdMovement` | 群体导航相关示例 |
| `L_ScalingNPCs` | NPC 扩展示例 |
| `L_PhysicsSimulatedCharacter` | 物理驱动角色 |
| `L_TechValidation` | 技术验证场景 |

地图名称说明其学习方向，不代表本文已经在 PIE 中验证过各地图全部功能。

[![图 3：官方示例地图 L_CharacterMovementBasics](/img/in-post/ue5-mover/official-mover-example-level.png)](/img/in-post/ue5-mover/official-mover-example-level.png)

*图 3：官方示例地图 `L_CharacterMovementBasics`（图源：Epic 官方文档《Mover Examples》，UE 5.8 文档页；实际场景以本机安装为准）。*

**重要避坑：**本机 README 中仍能看到 `L_PhysicallyBasedCharacter`，但实际地图文件叫 **`L_PhysicsSimulatedCharacter`**。5.5.4 本机安装也有同样的 README / 文件名差异。搜不到前者时，不要立即判断安装损坏。[^L02][^L03][^L12]

### 4.6 本实验完成标准

- [ ] 原版地图在自己的环境中能够启动。
- [ ] 能正确控制示例角色。
- [ ] 已记录实际引擎版本。
- [ ] 已记录三个 Network Prediction 设置。
- [ ] 没有修改引擎插件中的原始资产。

---

<a id="s05"></a>
## 5. 实验二：建立自己的 Mover 角色

### 5.1 学习阶段优先使用子蓝图

本机提供这些 Pawn 资产：

```text
/MoverExamples/Pawns/AnimatedMannyPawn
/MoverExamples/Pawns/AnimatedMannyPawnExtended
/MoverExamples/Pawns/BaseAnimatedMannyPawn
/MoverExamples/Pawns/PathFollowingMannyPawn
/MoverExamples/Pawns/ChaosMannyPawn
/MoverExamples/Pawns/ChaosMannyPawnExtended
```

这些是资源定位名，不是需要在系统终端运行的命令。

建议：

1. 找到 `AnimatedMannyPawn`。
2. 创建它的 Child Blueprint，保存为项目中的 `BP_MoverPlayer`。
3. 建立项目自己的测试地图和 GameMode。
4. 在 GameMode 中把 Default Pawn Class 设置为 `BP_MoverPlayer`。
5. 在地图 World Settings 中确认实际使用此 GameMode。
6. 添加 PlayerStart，保证生成点没有埋入地面。

**不要同时启用“GameMode 自动生成 Pawn”和“关卡里另一个 Pawn Auto Possess Player 0”，否则可能调试的是错误角色。**

`Mover Examples` 的插件描述明确表示这些示例不面向直接作为出货产品内容。因此子蓝图路线适合学习与原型；正式项目应把必要类、资产和依赖整理进自己的模块，而不是不加审查地长期绑定示例插件。[^L03]

### 5.2 认识角色组件结构

普通角色的教学结构可理解为：

```text
BP_MoverPlayer : Pawn
  Capsule / 可碰撞根组件
    SkeletalMesh
    SpringArm
      Camera
  CharacterMoverComponent
  可选：NavMoverComponent
```

这不是要求你把示例蓝图强行改成这棵树，而是逐项检查：

- 谁是实际被移动的 `UpdatedComponent`？
- 谁是用于平滑显示的 `PrimaryVisualComponent`？
- 谁生产输入？
- 哪个 backend 驱动模拟？
- 哪些模式已注册？
- 初始模式名称是否能在模式表里找到？

组件排列不只是视觉层级问题。移动根组件与被平滑的网格混淆时，可能出现胶囊正确、模型或相机抖动的现象。[^L05]

[![图 4：Mover 角色组件职责分工](/img/in-post/ue5-mover/schematic-component-roles.png)](/img/in-post/ue5-mover/schematic-component-roles.png)

*图 4：Mover 组件与输入生产者、backend、移动根、视觉根、模式注册表的分工；backend 与输入生产者指向 Mover，Mover 再移动移动根（教学示意图）。*

### 5.3 必查配置

| 项目 | 检查内容 |
|---|---|
| `MovementModes` | 所需模式名映射到有效模式对象 |
| `StartingMovementMode` | 名称与模式表中的键一致 |
| `BackendClass` | 本教程先使用 Network Prediction Liaison |
| `InputProducer` | 有对象实现输入生产接口；示例会使用其宿主 Pawn |
| Updated Component | 指向预期移动的根组件 |
| Primary Visual Component | 指向角色视觉组件 |
| 碰撞 | 根碰撞对测试地面和墙体产生正确阻挡 |
| 控制权 | PlayerController 实际 Possess 此 Pawn |

本机 5.8.1 `UMoverComponent` 构造代码默认采用 Network Prediction Liaison；实际 Blueprint 或子类仍可覆盖它。[^L05]

[![图 5：在蓝图编辑器中查看 Mover 组件的 Movement Modes 与 Shared Settings](/img/in-post/ue5-mover/official-mover-mode-details.png)](/img/in-post/ue5-mover/official-mover-mode-details.png)

*图 5：在 Pawn 蓝图中选中 Mover 组件后，Details 面板的 Movement Modes 与 Shared Settings 区域（图源：Epic 官方文档《Mover Examples》，UE 5.8 文档页）。*

### 5.4 复制设置不要照搬 CMC

官方 `AMoverExamplesCharacter` 构造中关闭的是 Actor 级别的 **Replicate Movement**，因为移动交给 Mover 处理。

这**不等于关闭 Actor 的 Replicates**。联网 Actor 是否复制、组件和 backend 是否正确参与复制，是另一组检查事项。

正确理解：

```text
Replicates
    决定 Actor 是否参与相应网络复制

Replicate Movement
    Actor 自带的通用 Transform/移动复制路径

Mover backend
    负责本方案中的移动模拟与对应同步
```

不要把 “Replicate Movement 关闭” 简化成 “所有复制都关闭”，也不要保留两套移动权威路径，让它们竞争修正 Transform。[^L04]

### 5.5 输入映射

本机示例包括：

- `IMC_MoverMappingContext`
- `IMC_AdvancedMoverMappingContext`
- `IA_Move`
- `IA_Jump`
- `IA_Dash`

继承示例时先保留其既有映射设置。如果自己实现输入：

1. 仅在有效的本地玩家输入环境里获取 Enhanced Input Local Player Subsystem。
2. 添加所需 Mapping Context。
3. 避免重复添加相同上下文。
4. 核对 Input Action 的 Value Type 与读取方式一致。
5. 不要要求 Dedicated Server 去创建 Local Player 输入子系统。

例如，本机 `AMoverExamplesCharacter::OnMoveTriggered` 读取的是 `FVector`。如果你另建 `Axis2D` 输入，不应不经转换就照抄这个读取方式。[^L04]

### 5.6 本实验完成标准

- [ ] 项目拥有自己的 Pawn 子蓝图、GameMode 和测试地图。
- [ ] 能确认当前控制的就是自己的 Pawn。
- [ ] 继承角色能完成与原版相同的基础移动。
- [ ] 能指出输入生产者、backend 和活动模式。
- [ ] 不直接编辑引擎目录下的蓝图或 C++。

---

<a id="s06"></a>
## 6. 输入系统：从 Enhanced Input 到 InputCmd

### 6.1 不要把 Input Action 当移动模拟回调

Mover 不直接绑定 Enhanced Input。官方角色示例负责把输入事件转成可提交的 `FMoverInputCmdContext`。[^O01][^L04]

典型过程：

```text
IA_Move Triggered
    保存当前移动向量

IA_Move Completed / Canceled
    清除持续移动向量

IA_Jump Started
    记录一次按下边沿
    更新按住状态

Produce Input
    把缓存打包成输入命令
    消费本次已提交的一次性边沿
    保留应持续生效的按住状态
```

为什么要缓存？

- 一个渲染帧可能包含多个模拟步。
- 多个渲染帧也可能只有一个模拟步。
- 只依赖“本帧按过一次”的普通变量，可能丢失或重复消费动作。
- 服务器和重模拟应消费相应输入命令，而不是读取当前玩家设备。

[![图 6：从 Enhanced Input 事件到 InputCmd](/img/in-post/ue5-mover/schematic-input-command.png)](/img/in-post/ue5-mover/schematic-input-command.png)

*图 6：输入事件先入本地缓存，再由 ProduceInput 打包成可重放的 InputCmd，交给各端模拟消费（教学示意图）。*

### 6.2 核心结构

在本机 5.8.1 中：

- `IMoverInputProducerInterface`：输入生产接口。
- `FMoverInputCmdContext`：输入命令上下文。
- `InputCollection`：可附加多个类型的数据集合。
- `FCharacterDefaultInputs`：默认角色输入数据。

默认输入包括移动意图、朝向意图、控制旋转、跳跃状态、建议模式和基座相关数据。[^L04][^L06]

### 6.3 一个最小 C++ 输入片段

**教学示例：**以下代码应放在你实际实现的输入生产函数里，不是完整 Pawn 类，也不能单独编译。`InputCmdResult`、`WorldMoveIntent`、`PendingJumpPressed`、`JumpHeld` 由宿主实现提供。

```cpp
FCharacterDefaultInputs& CharacterInputs =
    InputCmdResult.InputCollection.FindOrAddMutableDataByType<FCharacterDefaultInputs>();

CharacterInputs.SetMoveInput(
    EMoveInputType::DirectionalIntent,
    WorldMoveIntent.GetClampedToMaxSize(1.0f));

CharacterInputs.OrientationIntent = WorldMoveIntent.GetSafeNormal();
CharacterInputs.bIsJumpJustPressed = PendingJumpPressed;
CharacterInputs.bIsJumpPressed = JumpHeld;

PendingJumpPressed = false;
```

相关头文件：

```cpp
#include "MoverDataModelTypes.h"
#include "MoverSimulationTypes.h"
```

接口实现的 5.8.1 签名是：

```cpp
virtual void ProduceInput_Implementation(
    int32 SimTimeMs,
    FMoverInputCmdContext& InputCmdResult) override;
```

如果继承的是 `AMoverExamplesCharacter`，其头文件明确建议 C++ 扩展 `OnProduceInput`，蓝图扩展 **On Produce Input**，而不是覆写它负责桥接的 `ProduceInput_Implementation`。[^L04][^L06]

### 6.4 蓝图中的输入扩展

在 `AnimatedMannyPawnExtended` 中查看 **On Produce Input**，重点追踪：

1. 原有输入命令从哪里进来。
2. 自定义能力输入如何写入数据集合。
3. 修改后的 InputCmd 如何返回。
4. 一次性输入什么时候被清除。

如果父蓝图已经实现该函数，扩展时保留父级结果，避免把走路和跳跃等已有输入覆盖成一个空集合。不同版本的结构体辅助节点可能改名，因此本文不编造一个跨版本通用的 “Add Input” 节点名称。

### 6.5 方向输入与速度输入不是一回事

- `DirectionalIntent`：表达“想朝哪里移动、力度多大”，通常由模式和加速度参数决定速度变化。
- `Velocity`：表达期望速度；是否通过加速度逐渐达到它，还受模式与设置影响。

本机 `CommonLegacyMovementSettings` 中存在 `bUseAccelerationForVelocityMove`。因此，不能仅凭输入类型叫 Velocity，就断言下一模拟步一定无条件瞬间达到该速度。[^L04][^L07][^L14]

### 6.6 相机相对移动

常规地面角色建议：

1. 取得控制朝向。
2. 提取水平朝向，避免镜头俯仰把前进向量指向地下或天空。
3. 将局部输入转换到世界方向。
4. 限制输入长度，避免斜向移动意图超出设计范围。
5. 根据需求决定角色朝移动方向还是瞄准方向旋转。

这是普通地面角色的设计建议，不适用于所有飞行或任意重力角色。任意重力情况下，应按角色的重力参考系投影，而不是固定使用世界 XY 平面。

### 6.7 按钮边沿的细节

以冲刺为例：

- `bDashHeld`：按住期间持续为真。
- `bDashJustPressed`：一次新的按下事件。
- `DashRequestId`：可选的请求序号，便于明确消费和去重。

教学实现中，可以在输入生产时消费 `JustPressed`。复杂网络输入合并、插值或重采样时，还需要为自定义数据实现相应策略。

本机 5.8.1 的 `FMoverExampleAbilityInputs` 对一次性按钮和持续按钮使用不同的插值处理，并实现 `Merge`。这说明“随便加一个 bool 就会自动覆盖所有输入重采样场景”并不成立。[^L04]

另一个实际陷阱是：极短按下后立即松开，如果松开事件清除了尚未被提交的边沿，可能丢失一次点击。自定义实现应专门测试这一情况，而不是只测长按。

---

<a id="s07"></a>
## 7. 调出可控的基础移动手感

### 7.1 Shared Settings 的用途

多个模式可能需要共享最大速度、加速度、地面摩擦等参数。Mover 通过 Shared Settings 让它们引用相应设置对象，避免每个模式都存一份不一致的数据。

默认角色模式常使用：

```text
UCommonLegacyMovementSettings
```

在角色蓝图中选择 Character Mover 组件，检查它的 Shared Settings。某个设置对象是否出现，取决于注册模式对设置类的需求，不是手动填一个任意名称。[^L02][^L05][^L14]

### 7.2 先调整哪些参数

以下“练习值”是本文建议的调试起点，**不是引擎默认值或官方推荐值**。

| 参数 | 含义 | 练习值或方法 |
|---|---|---|
| `MaxSpeed` | 最大移动速度 | 先试 `600 cm/s` |
| `Acceleration` | 加速能力 | 先试 `2400 cm/s²` |
| `Deceleration` | 无输入时减速能力 | 先试 `3000 cm/s²` |
| `GroundFriction` | 地面方向控制/摩擦相关设置 | 先保留默认，再单独调整 |
| `TurningRate` | 最大转向速率 | 先试 `540°/s` |
| `TurningBoost` | 转向时对速度方向变化的强化 | 与转向速率分开测试 |
| `MaxStepHeight` | 可跨越台阶高度 | 用 20、40、60 cm 台阶比较 |
| `MaxWalkSlopeCosine` | 可行走斜坡阈值的余弦表达 | 不要填角度数值 |
| `JumpUpwardsSpeed` | 默认跳跃向上速度 | 根据目标高度与重力测试 |

这些字段和 `UCharacterMoverComponent` 使用 `JumpUpwardsSpeed` 的路径已核对。[^L14]

### 7.3 斜坡参数尤其容易填错

`MaxWalkSlopeCosine` 保存的是角度余弦，而不是角度。

例如，希望约 45° 的坡面可走：

```text
cos(45°) ≈ 0.7071
```

不要直接写 `45`。

在实际项目中还要结合地面法线、角色 Up 方向以及模式实现检查行为，不能只测一块倾斜平面就宣称所有坡面情况都通过。

### 7.4 跳跃的粗略估算

在“恒定向下重力、忽略其他修正”的简化模型中：

```text
最大上升高度 ≈ 初始向上速度² / (2 × 重力大小)
```

例如使用 `420 cm/s` 的向上速度与 `980 cm/s²` 的重力大小，理论上升高度约 `90 cm`。

这只是物理估算，**不是本文确认的 Mover 默认跳跃高度**。模式切换、碰撞、跳跃设计和时间步都会影响实际结果。

### 7.5 别用改 Shared Settings 代替所有技能状态

单机实验中，在按钮事件里改变 `MaxSpeed` 很容易看到效果。但联机项目里，如果这个改变影响预测：

- 回滚时参数能否恢复？
- 服务器是否知道这一改变发生在哪一模拟帧？
- 下一次重模拟是否仍读取同样的设置？

若答案不明确，应把“正在疾跑”的请求或状态放进模拟数据，再让模式根据它选择速度，而不是只在本地 Pawn 上改一个共享对象属性。

### 7.6 测试场地

建议搭建：

- 20 米直线跑道。
- 90° 和 180° 转向标记。
- 不同高度台阶。
- 30°、45°、60° 斜坡。
- 一堵可连续贴着滑行的墙。
- 高低平台与边缘。

每次只改一组参数，记录加速时间、停止距离、转向感觉、上台阶与离地表现。先关闭复杂动画影响，避免把脚滑误认为移动逻辑错误。

---

<a id="s08"></a>
## 8. 实验三：短距离冲刺

本章分成两层：

1. 先用单机最小实验理解 Layered Move。
2. 再明确联网版本必须补充的数据与验证。

**不要把第一层的可见效果当成完整联网能力。**

### 8.1 为什么先选择 Layered Move

普通“持续约 0.2 秒、提供额外速度”的冲刺，适合先用 Layered Move：

- 本身是短时移动能力。
- 可以由当前模式继续执行碰撞。
- 不一定需要全套独立地面检测规则。

如果冲刺还改变碰撞体、强制锁定运动规则、进入无重力阶段，或需要复杂的结束条件，独立 Movement Mode 可能更合适。

### 8.2 选择一条 API 路线

5.8.1 同时存在：

| 路线 | 代表类型 |
|---|---|
| 结构体式 Layered Move | `FLayeredMove_LinearVelocity` |
| 逻辑与数据拆分的新版机制 | `ULinearVelocityMoveLogic`、`FLinearVelocityMoveActivationParams` 等 |

为了让第一个例子短小，本文采用第一条。它在本机 5.8.1 仍然存在，不表示新版机制没有价值。不要把两套类型和 Queue 接口随意混接。[^L08]

### 8.3 单机蓝图实验

在自己的测试 Pawn 中：

1. 新建 Boolean 类型的冲刺 Input Action，或参考示例的 `IA_Dash`。
2. 在 Mapping Context 中绑定一个按键。
3. 使用 `Started` 测试单次触发，避免 `Triggered` 每帧不断创建新冲刺。
4. 从 Mover 组件拖出 **Queue Layered Move**。
5. 为其结构体输入连接 `FLayeredMove_LinearVelocity` 对应的 Make Struct 节点；在蓝图里搜索 `Layered Move` 和 `Linear Velocity`，必要时显示全部结构体引脚。
6. 配置：
   - `Velocity`：角色前向单位向量 × `1200`。
   - `DurationMs`：`200`，注意是毫秒。
   - `MixMode`：先用 `OverrideVelocity`。
   - `MagnitudeOverTime`：留空。
   - `SettingsFlags`：`0`，本实验使用世界方向。
7. 仅在单机基线中观察效果。

蓝图结构体的显示空格可能随版本变化，但底层类型和 **Queue Layered Move** 节点已在本机头文件核对。此处未声称打开过该蓝图验证接线。

理想无阻挡情况下，位移量级约为：

```text
1200 cm/s × 0.2 s = 240 cm
```

实际距离受碰撞、活动模式、混合策略和时间步影响，不保证正好 240 cm。

### 8.4 等价的 C++ 排队片段

**教学示例：**这是一个普通辅助函数，不是完整能力类。可放在你项目的 `.cpp` 中；传入有效 Mover 和方向后排队一次。它不包含输入绑定、冷却、权限校验或联网请求协议。

```cpp
#include "MoverComponent.h"
#include "DefaultMovementSet/LayeredMoves/BasicLayeredMoves.h"

static void QueueTrainingDash(
    UMoverComponent* MoverComponent,
    const FVector& WorldDirection)
{
    if (!IsValid(MoverComponent))
    {
        return;
    }

    const FVector DashDirection = WorldDirection.GetSafeNormal();
    if (DashDirection.IsNearlyZero())
    {
        return;
    }

    TSharedPtr<FLayeredMove_LinearVelocity> DashMove =
        MakeShared<FLayeredMove_LinearVelocity>();

    DashMove->Velocity = DashDirection * 1200.0f;
    DashMove->DurationMs = 200.0f;
    DashMove->MixMode = EMoveMixMode::OverrideVelocity;
    DashMove->SettingsFlags = 0;

    MoverComponent->QueueLayeredMove(DashMove);
}
```

使用方式：

```text
单机测试按钮
    → 获取角色 Mover
    → 获取期望世界方向
    → 调用 QueueTrainingDash
```

网络路线不能止步于这条调用链，见 8.7。

### 8.5 覆盖与叠加的差别

本机枚举包含：

- `AdditiveVelocity`
- `OverrideVelocity`
- `OverrideAll`
- `OverrideAllExceptVerticalVelocity`

这里特别要注意：

- `OverrideVelocity` 不只是“水平速度覆盖”，线速度和角速度均受其混合语义影响。
- `AdditiveVelocity` 会与其他来源叠加，速度可能超过你最初预期。
- 想保留空中上下运动，不能直接假设 `OverrideVelocity` 会保留重力结果。
- 可评估 `OverrideAllExceptVerticalVelocity`，但其“垂直”应按实际移动参考系与混合器实现理解，不应在任意重力项目里硬编码世界 Z。

通过 `L_LayeredMoves` 比较混合结果，比只看枚举名称可靠。[^L08]

### 8.6 冲刺结束并不自动等于立刻回到走路速度

Layered Move 到期后不再继续提出同样的速度。角色之后怎样减速，取决于活动模式、当前速度及其参数。

你需要明确：

- 冲刺能不能被墙打断？
- 碰墙后剩余持续时间是否保留？
- 空中冲刺是否保留上下速度？
- 冲刺结束是否保留惯性？
- 冲刺期间能不能转向？
- 连续按键是覆盖、忽略还是排队？

别在冲刺结束时用一次 `SetActorLocation` 或外部速度赋值“修正感觉”，这会绕开设计好的模拟路径。

[![图 7：一次冲刺 Layered Move 的生命周期](/img/in-post/ue5-mover/schematic-dash-lifecycle.png)](/img/in-post/ue5-mover/schematic-dash-lifecycle.png)

*图 7：从排队、混合到到期停止贡献的生命周期；有效期内活动模式始终负责移动与碰撞（教学示意图，图中数值仅为教学示例）。*

### 8.7 联网版本的正确数据流

下面是**设计伪代码，不是现成 API**：

```text
本地 IA_Dash Started
    PendingDashRequest = 新请求

ProduceInput
    写入 DashPressed / DashRequestId / 必需的方向数据
    消费已经提交的本地按钮边沿

模拟内输入处理
    读取本模拟帧的 Dash 输入
    读取起始同步状态中的冷却 / 体力 / 已处理请求
    校验是否允许冲刺
    接受后排队 Layered Move
    把新的冷却 / 体力 / 已处理请求写入输出同步状态

回滚后重模拟
    恢复相应起始状态
    使用历史输入重新执行相同规则
```

关键原则：

1. 触发源是输入命令，而不只是当前 Pawn 上的临时变量。
2. 冷却和体力如果影响预测结果，应能恢复到历史模拟状态。
3. 去重记录也要具有相应回滚语义，不能用一个永不回滚的集合把合法重模拟误判成重复。
4. 每个模拟步只由一个明确的消费入口创建冲刺，不要蓝图回调和 C++ 回调各排队一次。
5. 不要同时发送一个普通 Dash RPC 又消费同一次 Mover 输入，造成两条相互竞争的触发路径。

`OnPreSimulationTick` 是本机提供的模拟回调之一，默认角色跳跃处理就使用这一路径；复杂冲刺状态管理也可以放入专门的模拟扩展或模式。无论选择哪里，都必须确认状态写入和重模拟行为。[^L05][^L14]

### 8.8 关于“自动联网”的重要限制

本机 5.8.1 `MoverComponent.h` 在调度 Layered Moves 和 Instant Effects 的说明中，仍明确区分普通 Mover 与 Chaos Mover 的默认网络支持情况。

因此本文不承诺：

```text
客户端随意 QueueLayeredMove 一次
    = 服务器必然知道该能力
    = 所有端必然在同一帧执行
```

普通 Network Prediction 路线，应明确使用输入、模拟状态与后端支持的流程建立可重放行为。需要服务器发起或跨 Actor 同步的技能时，还要单独设计时间与权限模型。[^L05]

### 8.9 验收清单

- [ ] 单次按下只触发一次。
- [ ] 静止、奔跑、空中三种情况下结果符合设计。
- [ ] 撞墙不穿透，结果不是靠外部 Transform 修正。
- [ ] 测试连续点击及按下后立刻松开。
- [ ] 测试不同渲染帧率。
- [ ] 联网版中服务端和客户端使用同一能力规则。
- [ ] 延迟与校正发生后，冷却、体力和表现不会重复扣减或播放。

---

<a id="s09"></a>
## 9. 瞬时效果、姿态与模式转换

[![图 8：扩展机制选择](/img/in-post/ue5-mover/schematic-extension-choice.png)](/img/in-post/ue5-mover/schematic-extension-choice.png)

*图 8：按“这项能力改变什么”选择 Mode / Layered Move / Instant Effect / Modifier / Transition（教学示意图；同一能力可以组合多种机制）。*

### 9.1 Instant Movement Effects

瞬时效果在模拟窗口内改变移动状态，本身不消耗模拟时间。多个效果可以排队，按顺序在允许的窗口执行。[^O01][^L02]

本机包含：

| 类型 | 典型用途 |
|---|---|
| `FTeleportEffect` | 传送至目标位置，可带旋转 |
| `FJumpImpulseEffect` | 向上跳跃速度 |
| `FApplyVelocityEffect` | 应用速度，可指定叠加或覆盖及模式 |

一般性教学调用：

```text
构造并填写具体 Effect 数据
    → Queue Instant Movement Effect
    → 等待模拟处理
    → 根据实际结果更新表现
```

注意：

- 排队不等于立即执行。
- 不应只凭按钮被按下就认定传送成功。
- 传送目的地合法性、碰撞、权限与网络同步仍要设计。
- 不应把普通运动学 Effect 原样当作 Chaos 角色通用方案。[^L09][^L02]

### 9.2 默认跳跃的源码思路

5.8.1 的 `UCharacterMoverComponent` 在模拟前检查默认角色输入：

```text
本次跳跃边沿为真
    且 CanActorJump 成立
        → 创建 FJumpImpulseEffect
        → 使用 Shared Settings 中的 JumpUpwardsSpeed
        → 排队瞬时效果
```

这解释了为什么推荐提交跳跃输入，而不是在普通输入回调中绕过模拟任意更改位置。[^L14]

### 9.3 Movement Modifier 与蹲伏

Modifier 改的是移动条件或姿态，不负责给出一个新的位移向量。

蹲伏至少涉及：

- 胶囊尺寸。
- 站起空间检测。
- 速度规则。
- Mesh 和相机相对位置。
- 当前姿态的同步。
- 表现层切换。

不要只把胶囊缩小就宣布蹲伏完成。可以从 `StanceModifier.h`、`StanceSettings.h` 和默认 `CharacterMoverComponent` 的姿态处理入手。[^L09][^L14]

### 9.4 切换模式的两种思路

**显式请求**：

- `SuggestedMovementMode` 表达输入中的建议。
- `QueueNextMode` / 蓝图 **Queue Next Movement Mode** 排队模式切换。

**Transition 判断**：

- 在某个模式或全局转换对象中，根据当前模拟条件判断是否切换。
- 更适合可复用的“满足条件就转换”的规则。

这些接口存在，不代表任意来自客户端的模式名称都应被业务无条件接受。飞行、攀爬等能力在项目中仍应有资格判断。

### 9.5 模式名必须与注册表一致

例如你注册的是：

```text
TrainingFlying → TrainingFlyingMode 实例
```

就应请求 `TrainingFlying`，不是 C++ 类名 `UTrainingFlyingMode`，也不是蓝图资产显示名。

模式选择的是 `MovementModes` 的键。常见拼写错误会造成“函数调用了，但角色没按预期切换”。[^L05]

---

<a id="s10"></a>
## 10. 实验四：C++ 自定义限速飞行模式

### 10.1 为什么选择这个例子

从零编写地面碰撞、台阶、落地和状态收尾，不适合作为第一个 Mover C++ 练习。

本例：

- 继承 5.8.1 已有的 `UFlyingMode`。
- 复用它的移动生成和碰撞执行。
- 只在提案阶段限制飞行速度。
- 不重写 Simulation Tick。
- 不在模式对象里保存需回滚的计时器。

**源码已核对的部分**：父类、函数签名、`FProposedMove::LinearVelocity`。  
**未执行的部分**：项目生成、UHT、C++ 编译、蓝图配置和 PIE 验收。

### 10.2 项目依赖

假设项目的游戏模块名为 `MoverLab`。在现有 `MoverLab.Build.cs` 的公共依赖列表中加入 `Mover`；下面列出本例使用的基础依赖，不要为了照抄而删除项目原有依赖。

```csharp
PublicDependencyModuleNames.AddRange(
    new string[]
    {
        "Core",
        "CoreUObject",
        "Engine",
        "GameplayTags",
        "Mover"
    });
```

这段放在模块构造函数内，不是完整 Build.cs。

若实现自己的 Enhanced Input 绑定，再添加相应 `EnhancedInput` 依赖；若直接继承示例 C++ 角色，还需考虑 `MoverExamples` 依赖及其不面向直接出货的限制。

### 10.3 头文件

创建：

```text
Source/MoverLab/TrainingFlyingMode.h
```

```cpp
#pragma once

#include "CoreMinimal.h"
#include "DefaultMovementSet/Modes/FlyingMode.h"
#include "TrainingFlyingMode.generated.h"

UCLASS(Blueprintable, EditInlineNew, DefaultToInstanced)
class MOVERLAB_API UTrainingFlyingMode : public UFlyingMode
{
    GENERATED_BODY()

public:
    UTrainingFlyingMode(const FObjectInitializer& ObjectInitializer);

    UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Training")
    float TrainingSpeedLimit = 450.0f;

    virtual void GenerateMove_Implementation(
        const FMoverSimContext& SimContext,
        const FMoverTickStartData& StartState,
        const FMoverTimeStep& TimeStep,
        FProposedMove& OutProposedMove) const override;
};
```

如果模块不叫 `MoverLab`，修改目录与 `MOVERLAB_API` 为自己模块的导出宏。`TrainingFlyingMode.generated.h` 应保持为头文件中的最后一个 include。

### 10.4 源文件

创建：

```text
Source/MoverLab/TrainingFlyingMode.cpp
```

```cpp
#include "TrainingFlyingMode.h"
#include "MoveLibrary/MovementUtilsTypes.h"

UTrainingFlyingMode::UTrainingFlyingMode(
    const FObjectInitializer& ObjectInitializer)
    : Super(ObjectInitializer)
{
}

void UTrainingFlyingMode::GenerateMove_Implementation(
    const FMoverSimContext& SimContext,
    const FMoverTickStartData& StartState,
    const FMoverTimeStep& TimeStep,
    FProposedMove& OutProposedMove) const
{
    Super::GenerateMove_Implementation(
        SimContext,
        StartState,
        TimeStep,
        OutProposedMove);

    const float SafeSpeedLimit = FMath::Max(TrainingSpeedLimit, 0.0f);
    OutProposedMove.LinearVelocity =
        OutProposedMove.LinearVelocity.GetClampedToMaxSize(SafeSpeedLimit);
}
```

### 10.5 这个例子的能力边界

它限制的是**当前模式产生的速度提案**：

- 不会把低于上限的速度强制提高到上限。
- 不会代替父模式的加速度计算。
- 不保证后续 Layered Move 混合后的最终速度仍低于该值。
- 不对其他模式施加限制。
- 不代表任意物理角色都能使用。
- 没有把它标记成 Async 安全模式。

这是一个有明确边界的模式扩展，而不是项目级“全局速度限制器”。

### 10.6 编译与注册

1. 保存文件并确认 Mover 插件启用。
2. 用目标项目的 UE 5.8.1 工具链编译 Editor 配置。
3. 首次添加反射类型时，若编辑器没有正确发现类型，关闭编辑器后执行正常项目构建，不要只依赖 Live Coding。
4. 打开自己的 Pawn 蓝图。
5. 在 Mover 组件的 `MovementModes` 中增加：

```text
Key: TrainingFlying
Value: TrainingFlyingMode 的实例
```

6. 保留 Walking、Falling 等已有项。
7. 首次测试时把 `StartingMovementMode` 设置为 `TrainingFlying`。
8. 将 Shared Settings 的 `MaxSpeed` 设成明显高于 `450` 的值，例如 `800`，以便观察上限效果。
9. 暂时禁用冲刺和其他会覆盖速度的 Layered Moves。

请优先在类默认值里配置模式表。README 提示，在关卡实例上删除或替换实例化模式对象可能遇到问题。[^L02]

[![图 9：自定义飞行模式的限速位置与注册路径](/img/in-post/ue5-mover/schematic-custom-mode.png)](/img/in-post/ue5-mover/schematic-custom-mode.png)

*图 9：限速发生在基础提案阶段（Super 之后、Mixer 之前），以及注册键与进入模式的关系（教学示意图；图中数值为教学建议，未执行编译与 PIE）。*

### 10.7 验证结果

通过蓝图读取 Mover 的 `GetVelocity`，计算向量长度并显示：

- 平稳输入后，模式产生的自由飞行速度应受 `450 cm/s` 限制。
- 设成 `250` 后，应能看见更低上限。
- 遇墙仍应使用父类碰撞处理，而不是穿墙。
- 将初始模式恢复 Walking，确认原有步行不受此类参数影响。

这里描述的是**预期验收结果**，不是本文已执行并通过的测试结果。

### 10.8 从按键进入或退出

先做单机调试，可以使用 **Queue Next Movement Mode**：

```text
测试按键
    → Queue Next Movement Mode("TrainingFlying")

退出测试按键
    → Queue Next Movement Mode("Falling")
```

正式联网版本则应把切换意图纳入输入命令，在模拟中校验并执行；不要把本地按键调用成功视为模式切换已经正确同步。

### 10.9 为什么旧代码不能直接粘贴

5.5.4 常见：

```cpp
OnGenerateMove(...)
OnSimulationTick(...)
```

本文 5.8.1 使用：

```cpp
GenerateMove_Implementation(
    const FMoverSimContext& SimContext,
    ...);

SimulationTick_Implementation(...);
```

**不只是改函数名字**，参数也要按目标版本重新对照。详见第 17 章。[^L07][^L12]

---

<a id="s11"></a>
## 11. 进阶设计：攀爬、滑行、滑索与体力

本章提供设计方法，不声称给出了可直接运行的完整功能代码。

### 11.1 先选正确的扩展点

| 需求 | 优先评估 |
|---|---|
| 短时冲刺速度 | Layered Move |
| 瞬时击飞初速度 | Instant Movement Effect，配合模式切换 |
| 蹲伏和姿态条件 | Modifier 与姿态处理 |
| 长时间依附墙体、使用不同运动规则 | 独立 Climbing Mode |
| 沿滑索或轨迹约束移动 | 独立 Mode |
| 地面快速滑行，具有不同摩擦与结束规则 | 独立 Mode 或明确状态驱动的扩展 |
| 动画提供主要位移 | Mover 根运动集成路径 |

不要把每个动作都做成模式，也不要把每个动作都硬塞进 Layered Move。核心判断是：**改变的是短期速度来源，还是整套执行移动的规则？**

### 11.2 攀爬状态的最小建模

输入可以包含：

```text
ClimbPressed
ClimbReleased
ClimbDirectionalIntent
```

需要参与预测的状态可能包含：

```text
当前是否处于攀爬
攀爬表面标识或可重建引用
局部附着点 / 参考坐标
表面法线或等效约束信息
体力
允许脱离或冷却的模拟时间
```

世界查询并不会因为进入 Mover 就自动变得确定。移动墙体、网络对象时序和碰撞场景差异都可能造成客户端与服务器获得不同结果。

### 11.3 一个攀爬模式的流程

**设计伪代码：**

```text
进入条件
    输入请求攀爬
    表面可攀爬
    距离、朝向、体力满足要求
    请求经模拟规则接受

Generate Move
    获取起始攀爬状态
    计算表面切平面上的移动意图
    根据体力、速度上限生成 Proposed Move

Simulation Tick
    尝试沿表面移动
    维护与表面的距离约束
    处理边缘、障碍和基座变化
    更新输出状态
    在失去表面或主动松手时进入 Falling
```

如果要攀爬动态对象，存储世界坐标可能不足以表达附着关系，应考虑基座相对坐标和其历史状态。

### 11.4 不要在模式 UObject 里随手存运行状态

例如：

```text
Mode UObject 中的 ElapsedTime += WorldDeltaSeconds
```

如果这个时间决定技能结束，而回滚不恢复它，客户端重模拟可能走出不同结果。

模式对象更适合承载规则和配置。动态数据若决定移动结果，要通过可恢复的模拟状态或对应机制管理。

[![图 10：状态归属与回滚](/img/in-post/ue5-mover/schematic-state-ownership.png)](/img/in-post/ue5-mover/schematic-state-ownership.png)

*图 10：输入、配置、起始状态与输出状态的分工，以及回滚时“恢复历史状态 + 重放历史输入”的关系（教学示意图）。*

### 11.5 自定义数据块应检查什么

原生自定义数据通常从 `FMoverDataStructBase` 的体系入手。不同用途需要检查：

- `GetScriptStruct`
- `Clone`
- `NetSerialize`
- `ShouldReconcile`
- `Interpolate`
- `Merge`
- `ToString`
- 存储 UObject 引用时的引用收集与网络表达

并不是把这些函数空着就完成了。应按数据的实际语义实现：

- 持续按键与一次性动作如何合并？
- 浮点状态需要怎样的容差？
- 回滚后冷却怎样恢复？
- UObject 引用是否在所有端都能正确解析？
- 缺失数据时采用怎样的安全默认值？

本机 `FMoverExampleAbilityInputs` 是输入数据块阅读入口；同步状态则还应对照 `FMoverDefaultSyncState` 等实现。[^L04][^L06]

### 11.6 Persistent Sync State

需要跨模拟步保留的状态类型，应检查 Mover 的 **Persistent Sync State Data Types** 配置。没有加入相应持续策略的数据，可能需要每步由代码显式补入。

这不是“勾上后所有业务状态自动正确回滚”的按钮。你仍需确保状态在输入、起始状态、输出状态及网络序列化间保持一致。[^L02][^L05]

### 11.7 体力示例

假设攀爬每秒消耗体力，应该使用模拟步时间：

```text
DeltaSeconds = StepMs × 0.001
OutputStamina = max(0, StartStamina - ConsumeRate × DeltaSeconds)
```

并在同一模拟规则中处理“体力归零退出攀爬”。

不要只在 UI Tick 中减少体力，再让移动模式每次读取 UI 当前数值。

---

<a id="s12"></a>
## 12. 联机预测、回滚与同步边界

### 12.1 Network Prediction 路线的心智模型

简化理解：

1. 控制角色的客户端生成带有模拟时间语义的输入。
2. 客户端提前模拟，提供即时操作响应。
3. 服务器在自己的时间线上消费输入并生成权威结果。
4. 客户端收到权威状态后比较。
5. 必要时回到历史状态，再用后续历史输入重模拟。

非本地控制角色的呈现方式取决于网络 LOD 等配置，不能把所有客户端角色都视为用同一种方式前推。[^O02][^L02]

[![图 11：预测、权威比较与回滚重模拟的心智模型](/img/in-post/ue5-mover/schematic-prediction-rollback.png)](/img/in-post/ue5-mover/schematic-prediction-rollback.png)

*图 11：输入命令分别供本地与服务器消费，客户端在对应历史步比较，必要时恢复历史状态并重放历史输入（教学示意图）。*

### 12.2 固定模拟不等于绝对确定性

固定时间步能帮助组织共同时间线，但不会自动解决：

- 不同端读取不同的外部 UObject 状态。
- 动态碰撞对象不在同一时间线上。
- 使用全局随机数。
- 使用现实世界时间或普通 Timer 决定移动。
- 不一致的数据量化与容差。
- 同一输入触发不可回滚副作用。

更准确的目标是：**给定相应的输入、起始状态及可用环境信息，模拟逻辑尽可能可重复；不一致由后端检测和校正。**

### 12.3 重模拟中的副作用

如果在某个模拟步骤里直接：

```text
播放音效
生成粒子
扣库存
给予伤害
写一次性业务日志
```

该步骤重跑时可能重复执行。

建议分开：

- **模拟结果**：决定移动状态如何变化。
- **权威游戏结果**：例如伤害、资源消耗的最终结算。
- **表现事件**：通过帧、事件标识或可撤销状态管理去重。

`OnPreSimulationTick`、`OnPostSimulationTick` 等名字含 Simulation 的回调，要特别确认是否会在重模拟时执行。不要把它们当普通“每屏幕帧只调用一次”的事件。[^L05][^L06]

### 12.4 GAS 不是自动同步完成

Mover 的 README 明确提醒：GAS 有独立复制方法，使用 Mover 并不会自动解决两者的同步问题。[^L02]

例如一个 GAS Dash Ability：

- Ability 的激活和预测键属于哪条时间线？
- 移动冲刺输入在哪一帧被接受？
- 消耗体力由谁预测、谁确认？
- 回滚后的位移与 Ability 状态怎样对应？
- 被拒绝时表现怎样取消？

这些都应是显式设计，而不是“有 GAS + 有 Mover，所以无需处理”。

### 12.5 双端 PIE 测试流程

建议依次验证：

1. 单机、无技能的基础移动。
2. 两个玩家窗口，Listen Server。
3. 分别控制服务端玩家和远端客户端玩家。
4. 使用编辑器 Network Emulation 设置延迟和丢包。
5. 条件允许时，再做 Dedicated Server。
6. 最后用打包后的独立进程复核。

以下测试档位是本文自定测试输入，不是官方推荐：

| 档位 | 测试目的 |
|---|---|
| 无模拟延迟与丢包 | 先排除基础逻辑问题 |
| 中等延迟，例如工具参数 50–100 ms | 观察预测与校正 |
| 更高延迟，例如工具参数 150 ms | 暴露时间线假设 |
| 少量丢包，例如 1%–3% | 检查输入、动作和恢复行为 |
| 渲染帧率不同，例如 30 / 60 / 120 FPS | 检查模拟与渲染解耦 |

网络工具的延迟字段可能区分收发方向，不能把输入的数字直接当 RTT。记录你实际使用的配置及测得的表现。

[![图 12：联机测试阶梯](/img/in-post/ue5-mover/schematic-network-test.png)](/img/in-post/ue5-mover/schematic-network-test.png)

*图 12：从单机基线到打包复核的测试阶梯，以及每一档应记录的观察项（教学示意图）。*

### 12.6 对每个能力记录这些信息

```text
角色标识与本地控制状态
模拟帧 / 模拟时间
输入请求标识
本步起始模式
本步结束模式
关键自定义状态
是否正在重模拟
是否发生权威校正
```

如果只打印“Dash Called”，很难分辨重复调用是合法重模拟，还是同一输入被两个入口重复消费。

### 12.7 不要拿平滑掩盖逻辑错误

视觉平滑处理的是显示连续性，不会修复：

- 错误速度。
- 不一致的冷却。
- 丢失的输入。
- 同一个根组件被两个系统移动。
- 服务端和客户端不同的碰撞结果。

先让状态正确，再调整视觉平滑与相机。

---

<a id="s13"></a>
## 13. 动画、根运动与 Motion Matching

### 13.1 普通移动动画先读取真实状态

建议建立一层适配数据：

```text
Mover 当前速度
Mover 当前模式 / 标签
角色朝向与移动意图
是否着地 / 下落
当前姿态
        |
        v
项目动画数据接口
        |
        v
Animation Blueprint
```

动画蓝图不要只依赖 `Try Get Pawn Owner → Cast To Character → CharacterMovement` 这一条传统访问链。

对于 Mover Pawn，可先读取 `UCharacterMoverComponent` 提供的 `IsFalling`、`IsOnGround`、`IsFlying`、`IsCrouching` 等接口以及 Mover 速度，再整理成自己的动画输入。[^L14]

### 13.2 区分控制、模拟和显示

至少要区分：

- 玩家希望移动的方向。
- 模拟得到的实际速度。
- 网格平滑后的视觉位置。

例如角色按着前进但被墙挡住，输入意图不为零，实际速度可能接近零。此时用输入值直接驱动跑步速度容易出现“顶墙跑步”。

相反，冲刺或击退期间玩家没有方向输入，也可能有实际速度。

[![图 13：动画读取应区分控制意图、模拟状态与显示](/img/in-post/ue5-mover/schematic-animation-state.png)](/img/in-post/ue5-mover/schematic-animation-state.png)

*图 13：动画输入应从 Mover 真实状态经适配层进入 AnimBP，而不是直接用输入意图驱动（教学示意图）。*

### 13.3 根运动不是只播放一个 Montage

本机存在 `UPlayMoverMontageCallbackProxy`。其职责是在播放 Montage 的同时创建相应 Layered Move 来处理根运动。[^L10]

因此，做根运动位移时建议：

1. 确认动画资源是否真的包含根运动。
2. 确认 AnimBP 与 Montage 的根运动设置。
3. 查看示例和当前版本的 Mover Montage 播放入口。
4. 确认根运动通过 Mover 的移动流程执行。
5. 测试阻挡、打断、落地、结束以及网络校正。

不要一边让动画路径提供根运动，一边用 Tick 手动移动同一个角色，造成双重位移。

“能调用 Mover Montage 节点”也不等于整个技能的网络触发、授权和回滚已经正确。

### 13.4 Motion Warping 的边界

Motion Warping 可以调整根运动以趋近目标，但目标的来源、合法性和同步仍要设计。

例如翻越：

- 障碍目标点何时检测？
- 客户端与服务器是否使用相同目标？
- 目标物体在动画期间移动怎么办？
- 翻越被打断后返回哪个移动模式？
- 碰撞失败时动画如何收尾？

不能把“动画看上去到了目标”当成移动状态正确的唯一证据。

### 13.5 Motion Matching 与轨迹预测

Mover 提供轨迹预测相关能力，README 提到 `GetPredictedTrajectory`；本机也有 `MoverPoseSearchTrajectoryPredictor` 等源文件。[^L02][^L10]

其关系可理解为：

```text
当前输入与移动状态
    → 预测未来轨迹
    → 动画系统选择匹配的动作
    → 动画展示与实际移动保持配合
```

预测轨迹不是权威未来，输入突变、碰撞和网络校正都会改变结果。

若追求完整动画质量，可以进一步研究 Game Animation Sample；不要一开始就把其全部系统搬进第一个 Mover 原型。

---

<a id="s14"></a>
## 14. AI、寻路与移动平台

### 14.1 有 NavMesh 不等于 Mover Pawn 自动支持 MoveTo

AI 移动需要连接：

```text
AIController / Path Following
    → 导航移动请求
    → NavMoverComponent 等适配
    → Mover 输入
    → 当前移动模式
```

本机 README 提供：

- `PathFollowingMannyPawn`
- `L_PathfindingMovement`
- 可选的 `NavMoverComponent`

官方 C++ 角色示例会消费导航移动数据，再写入默认角色输入。这比假设所有普通 Pawn 都能直接接受 CMC 方式的寻路更可靠。[^L02][^L04]

### 14.2 建议的 AI 练习

1. 先运行官方寻路地图。
2. 创建 `PathFollowingMannyPawn` 的项目子蓝图。
3. 保留其导航适配组件与配置。
4. 在简单平地放置导航区域和一个目标。
5. 验证路径请求、输入生产、实际移动各环节。
6. 再测试转弯、台阶、动态障碍和多人环境。

调试顺序：

- 导航网格是否存在？
- AI 是否控制正确 Pawn？
- 路径请求是否成功？
- 导航请求有没有转成 Mover 输入？
- 对应模式与导航参数是否有效？

不要只在最后一层不断提高速度。

### 14.3 Walking 与 NavWalking

它们是不同的运动模式和执行策略。不要因为名字含 Walking 就视为完全可互换。

是否适合采用 NavWalking，要结合项目的导航场景、地面约束、动态障碍及精度要求测试；本机已有对应模式和示例入口。[^L02][^L03]

### 14.4 移动平台最容易暴露时间线问题

站在平台上时，角色移动还受到：

- 平台位置与旋转。
- 基座相对坐标。
- 平台更新时序。
- 平台网络同步方式。
- 角色对基座移动的解释。

官方输入示例支持把输入方向转换为基座相对方向；不应简单理解为“角色每帧加上平台的位移差就结束”。[^L04]

学习顺序：

1. `L_BasedMovement`。
2. 路径或样条驱动的平台示例。
3. 静态直线移动平台。
4. 旋转平台。
5. 有延迟的网络测试。
6. 最后再尝试与其他物理或非物理系统混合驱动。

对于需要多人一致交互的平台，建议让平台自身的时间表达和同步方式也明确，而不是只复制当前 Transform 后要求角色预测天然准确。

---

<a id="s15"></a>
## 15. Chaos Mover：物理驱动路线

### 15.1 它不是给普通角色勾选 Simulate Physics

普通运动学路线主要通过查询环境并执行受控移动。

物理路线将角色运动接入 Chaos 物理模拟，通过相应的约束与力学交互执行运动，使用的 backend 和网络物理流程不同。它不是在同一个普通 Pawn 上打开 Simulate Physics 就自然完成迁移。[^L02]

### 15.2 本机实际入口

UE 5.8.1：

```text
插件：ChaosMover
地图：L_PhysicsSimulatedCharacter
角色：ChaosMannyPawn / ChaosMannyPawnExtended
```

建议先原样打开地图，按照地图内文字设置项目，然后再检查：

- Chaos Mover 的组件与 liaison。
- 物理模拟时间设置。
- 网络物理相关配置。
- 与角色交互对象的物理和复制设置。

本文没有进入地图读取其 5.8.1 具体提示，因此不把旧版本教程里某组 Chaos 开关和值当成当前确定配置。

### 15.3 不要混淆三个概念

| 概念 | 含义 |
|---|---|
| Network Prediction 的固定步长 | 一种模拟时间组织与网络路线配置 |
| Mover 的 Async 模式 | 将兼容的移动工作用于异步执行 |
| Chaos 物理驱动角色 | 用物理系统执行角色运动的路线 |

三者不等价。5.8.1 中存在 `AsyncWalking`、`AsyncFalling` 等模式，不表示使用它们就自动变成 Chaos 刚体角色。[^L02][^L07]

[![图 14：普通运动学 Mover 与 Chaos Mover 路线对照](/img/in-post/ue5-mover/schematic-backend-comparison.png)](/img/in-post/ue5-mover/schematic-backend-comparison.png)

*图 14：两条路线在移动执行者、backend 与示例资产上的差别，以及三个不可等同的概念（教学示意图；不猜测具体 Chaos 开关值）。*

### 15.4 物理路线的重点风险

README 提醒：

- 异步物理与游戏线程之间可能产生额外延迟。
- 与未正确复制的物理对象交互，可能导致不同端结果不一致。
- 与由普通游戏逻辑移动的非物理对象交互，可能存在时序问题。
- 某些普通 Mover 机制不能直接用于物理角色。
- 某些事件和行为仍需项目验证。

因此，普通 Mover 的传送、冲刺和根运动教程不能不加验证地整套照搬到 Chaos 路线。[^L02]

### 15.5 选择建议

- **目标主要是可控角色操作**：先用普通运动学路线建立基线。
- **目标主要是角色与物体之间真实的双向物理交互**：建立独立 Chaos 原型并验证。
- **两者混用**：先定义每类 Actor 的驱动者、时间线和网络权威，避免让多个系统争夺同一 Transform。

这属于工程建议，而不是“哪条路线一定更先进”的判断。

---

<a id="s16"></a>
## 16. 调试工具与故障排查

### 16.1 Gameplay Debugger

官方文档与 README 提供 Gameplay Debugger 的 Mover 分类。常见启动键为英文单引号 `'`，再用对应分类快捷键启用 Mover；具体键位可受项目设置和键盘布局影响。[^O04][^L02]

[![图 15：Gameplay Debugger 运行界面](/img/in-post/ue5-mover/official-gameplay-debugger.png)](/img/in-post/ue5-mover/official-gameplay-debugger.png)

*图 15：Gameplay Debugger 的运行界面（图源：Epic 官方文档《Using the Gameplay Debugger》；实际分类与键位以本机为准）。*

重点观察：

- 当前选中角色是否正确。
- 活动模式。
- 输入方向。
- 速度。
- 预测轨迹。
- 历史轨迹和校正。

### 16.2 本机已核对的控制台命令

用于本地玩家：

```text
Mover.LocalPlayer.ShowTrail 1
Mover.LocalPlayer.ShowTrajectory 1
Mover.LocalPlayer.ShowCorrections 1
```

用于 Gameplay Debugger 选中角色的相应显示：

```text
mover.debug.ShowTrail 1
mover.debug.ShowTrajectory 1
mover.debug.ShowCorrections 1
mover.debug.ShowStateArrows 1
mover.debug.ShowInputArrows 1
```

本机源码对 `mover.debug.ShowTrail`、`ShowTrajectory` 和 `ShowCorrections` 提醒：这一组主要用于服务器控制的被选角色；观察本地玩家时使用 `Mover.LocalPlayer.*`。

关闭时将开关值设回 `0`。这些是调试工具，不应把开发版中可用等同于 Shipping 包中的保证。[^L11]

### 16.3 日志

Mover 日志分类：

```text
LogMover
```

可以先在 Output Log 中过滤该分类。需要更细节时，可尝试开发环境的日志级别命令：

```text
Log LogMover Verbose
```

再把你自己的日志与模拟帧、角色标识关联，而不是只有没有上下文的字符串。日志过滤分类已由 README 核对；实际构建保留哪些级别受构建与日志配置影响。[^L02]

### 16.4 故障速查表

| 症状 | 优先排查 | 不要先做什么 |
|---|---|---|
| 完全不动 | Possess、Input Mapping、InputProducer、backend、初始模式、UpdatedComponent | 不要先疯狂提高速度 |
| 能看见输入但不动 | 模式是否执行、碰撞是否卡住、被移动组件是否正确 | 不要改成 SetActorLocation 绕过问题 |
| 初始就下落或穿地 | 生成点、根碰撞、地面响应、模式与地面检测 | 不要先改动画 |
| 模型抖、胶囊较稳 | Fixed Tick Smoothing、Primary Visual Component、Smoothing Mode、相机挂点 | 不要只增加网络带宽 |
| 移动后不断被拉回 | 客户端独自改状态、双重移动路径、输入与状态不同步 | 不要关闭所有校正掩盖错误 |
| 冲刺触发多次 | Triggered 每帧触发、多个消费入口、一次性输入与重模拟处理 | 不要用不可回滚的全局 bool 硬挡 |
| 冲刺按钮偶尔无效 | 短按边沿是否丢失、松开时是否过早清除、输入合并 | 不要只延长动画 |
| 模式请求无效果 | 注册键、对象有效性、资格判断、调用时间 | 不要只检查 C++ 类名 |
| AI MoveTo 不走 | NavMesh、AI 控制权、NavMover 适配、输入消费 | 不要假设 Pawn 天生等同 Character |
| 平台上抖动 | 基座坐标、平台更新与复制时序、backend 混用 | 不要给角色逐帧硬加平台位移 |
| 动画脚滑 | 速度单位、实际速度与输入意图区别、资源匹配 | 不要直接认定碰撞错误 |
| 根运动位移翻倍 | 普通移动、动画根运动和手动位移是否重复驱动 | 不要再补一个位置修正 |
| 5.5 代码编译报 override 错误 | 核对目标版本函数签名 | 不要仅改名字不看新增参数 |
| PIE 好、打包失败 | Cook 资产、示例依赖、组件数据、目标配置 | 不要把 PIE 通过当出货证明 |

### 16.5 推荐排错顺序

```text
先确认操作的是正确 Pawn
    → 再确认输入
    → 再确认模拟在运行
    → 再看模式与起始状态
    → 再看生成的提案
    → 再看碰撞和输出状态
    → 最后看网络与显示
```

每一步只改变一个变量。保留原版示例地图作为对照，是最省时间的诊断方法之一。

---

<a id="s17"></a>
## 17. UE 5.5.4 与 5.8.1 差异

下面只列本机实际检查到的差异，不假装覆盖所有中间版本。

### 17.1 核心对照

| 项目 | 本机 5.5.4 | 本机 5.8.1 | 迁移含义 |
|---|---|---|---|
| 插件状态 | Experimental | Experimental | 仍要锁定版本并验证 |
| 生成移动扩展 | `OnGenerateMove` | `GenerateMove_Implementation`，带 `FMoverSimContext` | 不能直接复制旧 override |
| 执行移动扩展 | `OnSimulationTick` | `SimulationTick_Implementation` | 更新函数声明与父类调用 |
| 激活/停用接口 | 存在 `OnActivate` / `OnDeactivate` | 有 `Activate` / `Deactivate` 及 External 路径 | 不只是简单改名字 |
| Layered Move 机制 | 常见结构体式体系 | 结构体式与逻辑/数据拆分体系并存 | 选定路线，不混用接口 |
| Blackboard 文档 | Sim Blackboard 不具备完整回滚友好语义 | 文档说明向 Rollback Blackboard 迁移 | 不把普通缓存当权威状态 |
| 物理示例实际地图 | `L_PhysicsSimulatedCharacter` | 同名文件 | README 的旧名需警惕 |
| 示例地图数量与类型 | 较少 | 新增若干路径、群体与 NPC 相关地图 | 不假设所有资产跨版本都有 |

以上分别来自目标版本的头文件、README 和目录读取。[^L02][^L07][^L08][^L12]

### 17.2 5.6 弃用标记的含义

5.8.1 的 `MovementMode.h` 中保留了以 5.6 标注的旧接口弃用说明，包括：

- `OnGenerateMove` → `GenerateMove` BlueprintNativeEvent 路线。
- C++ 覆写改成 `GenerateMove_Implementation`。
- `OnSimulationTick` → `SimulationTick_Implementation`。

这可以解释为什么老教程在新引擎里出现 override 错误，但不能据此推导所有 5.6、5.7、5.8 签名完全相同。**以你安装版本的头文件为准。**[^L07]

### 17.3 时间精度陷阱

5.8.1 README 提醒：早期一些绝对时间戳使用单精度，后来改为双精度；涉及 5.7 之前的数据用法时要警惕。

例如 Blackboard 中：

```text
用 double 写入某个时间
    却用 float 类型读取
```

可能导致错误结果。不要只看变量名相同就认为类型完全兼容。[^L02]

### 17.4 5.5 的打包相关已知问题

本机 5.5.4 README 记录了一个问题：Cooked Data Optimization 可能造成 MoverComponent 数据缺失，并给出检查 Actor 的 **Generate Optimized Blueprint Component Data** 设置的建议。

这是**5.5.4 文档记录的定向排查项**，不是本文要求所有 5.8 项目无条件关闭优化。先复现问题，再按目标版本说明定位。[^L12]

### 17.5 升级前的最小操作

1. 固定当前可运行版本并保留备份或版本控制记录。
2. 为自己的移动模式、输入结构、动画接口建立清单。
3. 对照新引擎中的同名头文件。
4. 先编译，再测单机，再测网络。
5. 重点重测输入边沿、状态保留、姿态、移动平台、根运动。
6. 最后检查打包、目标平台和规模性能。

不要在没有基线测试的情况下同时升级引擎、改动画系统、换角色模型和重写移动。

---

<a id="s18"></a>
## 18. 项目落地、学习路线与验收清单

### 18.1 建议的工程目录

以下是建议结构，不是引擎强制规范：

```text
Content/
  MoverLab/
    Blueprints/
      BP_MoverPlayer
      BP_MoverGameMode
    Input/
    Animation/
    Maps/
      L_MoverBaseline
      L_MoverAbilities
      L_MoverNetwork

Source/
  YourGame/
    Movement/
      Modes/
      Inputs/
      State/
      Abilities/
      Animation/
```

保留三个独立测试场景：

- **Baseline**：只测基础移动。
- **Abilities**：测冲刺、攀爬等能力。
- **Network**：测多人和时序问题。

### 18.2 五阶段学习路线

#### 阶段一：认识框架

- 跑官方基础地图。
- 找到 Pawn、Mover、输入和 backend。
- 能解释模式与 Layered Move 的区别。

#### 阶段二：项目化

- 建立自己的子蓝图和 GameMode。
- 完成速度、转向、跳跃调参。
- 把动画读取从 CharacterMovement 假设中分离出来。

#### 阶段三：做一个小能力

- 完成单机冲刺实验。
- 明确覆盖速度、持续时间和结束规则。
- 不使用 Tick 直接移动根组件。

#### 阶段四：自定义与联机

- 完成限速飞行模式。
- 为一个能力设计输入和同步状态。
- 在延迟环境中观察重模拟和校正。

#### 阶段五：项目需求验证

- 根据需求验证 AI、平台、根运动或 Chaos。
- 做打包验证。
- 测角色数量、网络带宽和目标平台性能。
- 决定继续采用、限制使用范围，还是保留 CMC。

### 18.3 性能评估不要只测一个角色

以下是建议测量项目，不是已有性能结论：

- 活跃角色数量。
- 每秒模拟步数与重模拟次数。
- 碰撞查询数量。
- 自定义状态大小与序列化成本。
- 每 Actor Layered Moves / Modifiers 数量。
- 动画和移动分别消耗的 CPU。
- 远端角色插值配置的成本。
- 服务器下的 AI、导航与移动平台开销。

不要因为本地单角色很顺滑，就断言支持某个特定规模的多人项目。

### 18.4 从 CMC 迁移时的依赖清单

- [ ] 输入绑定不再假设 `AddMovementInput` 自动进入原 CMC 路径。
- [ ] 动画不再硬编码获取 CharacterMovement。
- [ ] 跳跃、蹲伏、冲刺和击退都有新的明确入口。
- [ ] AI 与导航请求有适配。
- [ ] 相机和平滑层级经过验证。
- [ ] 移动平台与基座行为经过验证。
- [ ] GAS / 其他能力系统的时间线与移动同步有设计。
- [ ] 保存读档、传送、复活与重生流程经过验证。
- [ ] 服务器权限、校正与表现去重经过验证。
- [ ] 打包资产和插件依赖已经整理。

### 18.5 最小“可以继续投入”的标准

- [ ] 能稳定完成基础移动。
- [ ] 至少一个自定义能力在延迟下表现合理。
- [ ] 能解释一次校正的原因，而不是仅把它隐藏。
- [ ] 不依赖外部 Tick 修改移动根组件。
- [ ] 能从日志追踪输入到输出状态。
- [ ] 打包版完成基本冒烟测试。
- [ ] 清楚哪些需求尚未验证，尤其是 Physics、GAS 与规模性能。

### 18.6 本教程交付的验证状态

| 项目 | 本次状态 |
|---|---|
| Epic 官方资料检索 | 已执行 |
| 本机引擎实际版本核对 | 已执行 |
| 关键公开头文件与示例源码读取 | 已执行 |
| 示例资产文件名核对 | 已执行 |
| 5.5.4 / 5.8.1 重点差异核对 | 已执行 |
| 启动编辑器与 PIE | 未执行 |
| C++ 编译与 UHT | 未执行 |
| 联网延迟、丢包与 Dedicated Server 测试 | 未执行 |
| 实际项目改动 | 未执行，仅生成教程 |

---

<a id="s19"></a>
## 19. 源码阅读顺序与术语速查

### 19.1 源码根目录缩写

后文参考资料使用这些前缀：

```text
E58 = C:\Program Files\Epic Games\UE_5.8\Engine
E55 = D:\UE_5.5\Engine

M58 = E58\Plugins\Experimental\Mover
X58 = E58\Plugins\Experimental\MoverExamples
C58 = E58\Plugins\Experimental\ChaosMover

P58 = M58\Source\Mover\Public
R58 = M58\Source\Mover\Private

M55 = E55\Plugins\Experimental\Mover
X55 = E55\Plugins\Experimental\MoverExamples
```

这些缩写仅为缩短文档中的源码定位，不是已设置好的环境变量。

### 19.2 推荐阅读顺序

1. `M58\README.md`：概念、后端、限制。
2. `X58\Source\MoverExamples\Public\MoverExamplesCharacter.h`：角色与输入扩展点。
3. `X58\Source\MoverExamples\Private\MoverExamplesCharacter.cpp`：输入缓存、转换与提交。
4. `P58\MoverComponent.h`：模式表、后端、队列、事件、状态设置。
5. `P58\MoverSimulationTypes.h`：输入与模拟上下文。
6. `P58\MoverDataModelTypes.h`：默认输入和同步状态。
7. `P58\MovementMode.h`：模式接口。
8. `P58\DefaultMovementSet\Modes\FlyingMode.h` 与对应 `.cpp`：最容易理解的完整模式。
9. `P58\DefaultMovementSet\Modes\WalkingMode.h` 与对应 `.cpp`：地面执行细节。
10. `P58\DefaultMovementSet\LayeredMoves\BasicLayeredMoves.h`：临时移动。
11. `P58\DefaultMovementSet\InstantMovementEffects\BasicInstantMovementEffects.h`：瞬时效果。
12. `X58\Source\MoverExamples\Public\CharacterVariants\AbilityInputs.h`：自定义输入。
13. `X58\Source\MoverExamples\Private\CharacterVariants\Ziplining\ZipliningMode.cpp`：特殊模式实例。
14. `P58\Backends`：在理解模拟之后研究后端，不必第一天就从网络底层开始。

### 19.3 遇到问题时搜什么

| 问题 | 源码搜索关键词 |
|---|---|
| 输入为什么没生效 | `ProduceInput`、`InputProducer`、`InputCollection` |
| 模式为什么没切换 | `MovementModes`、`StartingMovementMode`、`QueueNextMode` |
| 速度在哪里决定 | `GenerateMove_Implementation`、`FProposedMove` |
| 为什么碰撞后结果不对 | `SimulationTick_Implementation`、`MovementRecord` |
| 冲刺在哪里创建 | `QueueLayeredMove`、`FLayeredMove_LinearVelocity` |
| 瞬时速度/传送 | `QueueInstantMovementEffect` |
| 数据为什么下一步丢失 | `PersistentSyncStateDataTypes`、`SyncStateCollection` |
| 回滚后状态不一致 | `ShouldReconcile`、`NetSerialize`、`Rollback` |
| 模型平滑不对 | `PrimaryVisualComponent`、`SmoothingMode` |

### 19.4 一页术语表

| 英文 | 中文理解 |
|---|---|
| Input Producer | 输入生产者 |
| Input Command / InputCmd | 某次模拟使用的输入命令 |
| Sync State | 指定模拟时间的同步状态 |
| Proposed Move | 尚未执行的移动提案 |
| Movement Mode | 当前执行移动规则的模式 |
| Layered Move | 临时附加移动来源 |
| Movement Mixer | 移动提案混合器 |
| Instant Movement Effect | 模拟内的瞬时状态效果 |
| Movement Modifier | 影响移动条件的修改器 |
| Transition | 模式转换条件与动作 |
| Liaison | Mover 与驱动后端的适配层 |
| Rollback | 恢复历史状态 |
| Resimulation / Resim | 根据历史输入重新模拟 |
| Reconcile | 比较预测和权威状态并决定校正 |
| Simulated Proxy | 非本地自主控制的网络代理角色 |
| Movement Base | 角色所依附或站立的移动基座 |
| Blackboard | 共享信息或缓存机制；需要核对具体回滚语义 |

---

<a id="s20"></a>
## 20. 参考资料与核验记录

### 20.1 资料优先级

1. **目标引擎版本的源码与实际资产**：判断函数签名、类名、字段和文件是否存在。
2. **该插件随引擎附带的 README**：了解概念和已知限制，但仍可能有过期资源名。
3. **Epic 官方在线文档**：学习框架并查找相关入口，注意页面版本选择。
4. **项目实际测试**：最终确认功能、联机和性能是否满足你的需求。

本文没有使用社区教程作为关键 API 的权威来源。数值调参、实验组织与进阶方案属于本文的教学建议，已与引擎事实区分。

### 20.2 Epic 官方在线资料

下列地址用代码格式保留，便于在 Markdown 查看器或浏览器中复制打开；在线文档可能随版本变化。

[^O01]: Epic Games，**Mover Features and Concepts**。`https://dev.epicgames.com/documentation/en-us/unreal-engine/mover-features-and-concepts-in-unreal-engine`。用于框架概念：模式、叠加移动、瞬时效果、输入与状态等。

[^O02]: Epic Games，**Comparing Mover and Character Movement Component**。`https://dev.epicgames.com/documentation/en-us/unreal-engine/comparing-mover-and-character-movement-component-in-unreal-engine`。用于架构和网络模型对照。

[^O03]: Epic Games，**Mover Examples**。`https://dev.epicgames.com/documentation/en-us/unreal-engine/mover-examples-in-unreal-engine`。用于示例入门与 Network Prediction 起始设置。地图名称同时按本地实际文件复核。

[^O04]: Epic Games，**Mover Debugging and Reference**。`https://dev.epicgames.com/documentation/en-us/unreal-engine/mover-debugging-and-reference-in-unreal-engine`。用于 Gameplay Debugger、日志与调试工具入口。

### 20.3 本机 Epic 源码与资产

以下路径使用第 19 章定义的缩写；文件读取日期均为 2026-09-09。引用表示已查看相关内容，不表示编译或运行通过。

[^L01]: `E58\Build\Build.version` 与 `E55\Build\Build.version`。确认 5.8.1 / 5.5.4 的实际安装版本及 Changelist。`M58\Mover.uplugin` 和 `M55\Mover.uplugin` 确认插件实验性标志。

[^L02]: `M58\README.md`。已读取全文，核对概念、默认模式、backend、Network Prediction 建议、Chaos 路线、GAS 边界、状态持久化、平滑与已知问题。

[^L03]: `X58\MoverExamples.uplugin`、`X58\Content\Maps`、`X58\Content\Pawns`、`X58\Content\Input`、`X58\Content\Gameplay`。核对示例用途声明、依赖和实际资源文件名。未解析二进制蓝图接线。

[^L04]: `X58\Source\MoverExamples\Public\MoverExamplesCharacter.h`、`X58\Source\MoverExamples\Private\MoverExamplesCharacter.cpp`、`X58\Source\MoverExamples\Public\CharacterVariants\AbilityInputs.h`。核对输入缓存、生产、导航输入、基座变换、Actor 移动复制以及自定义输入序列化与合并。

[^L05]: `P58\MoverComponent.h` 和 `R58\MoverComponent.cpp` 的相关声明与实现。核对 backend 默认值、InputProducer、模式注册表、队列接口、模拟回调、组件设置、平滑与网络调度说明。

[^L06]: `P58\MoverTypes.h`、`P58\MoverSimulationTypes.h`、`P58\MoverDataModelTypes.h`。核对时间步、输入接口、默认输入字段和同步状态相关结构。

[^L07]: `P58\MovementMode.h`、`P58\DefaultMovementSet\Modes\FlyingMode.h`、`R58\DefaultMovementSet\Modes\FlyingMode.cpp`。核对 5.8.1 模式接口、弃用声明、自由移动提案生成与实际碰撞执行。

[^L08]: `P58\LayeredMove.h`、`P58\LayeredMoveBase.h`、`P58\DefaultMovementSet\LayeredMoves\BasicLayeredMoves.h`、`P58\MoveLibrary\MovementUtilsTypes.h`。核对两套 Layered Move 机制、持续时间、速度类型与混合枚举。

[^L09]: `P58\DefaultMovementSet\InstantMovementEffects\BasicInstantMovementEffects.h`。核对传送、跳跃和应用速度效果类型；姿态相关路径位于 `P58\DefaultMovementSet\MovementModifiers\StanceModifier.h` 与 `P58\DefaultMovementSet\Settings\StanceSettings.h`。

[^L10]: `P58\MoveLibrary\PlayMoverMontageCallbackProxy.h`、`P58\MoverPoseSearchTrajectoryPredictor.h`，以及 `M58\README.md` 中轨迹预测说明。核对 Mover Montage 根运动入口与相关轨迹源文件。

[^L11]: `R58\MoverModule.cpp` 与 Mover 源码中的 `GameplayDebuggerCategory_Mover.cpp`。核对本地玩家和 Gameplay Debugger 控制台显示命令及其适用说明。

[^L12]: `M55\README.md`、`M55\Source\Mover\Public\MovementMode.h`、`X55\Content\Maps`。核对 5.5.4 接口、Blackboard、Cook 优化相关记录及真实地图文件。

[^L14]: `P58\DefaultMovementSet\Settings\CommonLegacyMovementSettings.h`、`P58\DefaultMovementSet\CharacterMoverComponent.h`、`R58\DefaultMovementSet\CharacterMoverComponent.cpp`。核对手感参数、跳跃输入处理、姿态和常用角色状态查询。

---

## 最后记住这六句话

1. **先跑原版示例，再做自己的角色。**
2. **输入是命令，状态是结果，不要混在一起。**
3. **模式负责移动规则，Layered Move 负责临时移动来源。**
4. **回滚会重新模拟，外部状态和副作用必须设计。**
5. **普通 Mover、Async 模式与 Chaos Mover 不是同一个开关。**
6. **以目标版本源码和实际测试为准，不以旧教程能否复制粘贴为准。**
