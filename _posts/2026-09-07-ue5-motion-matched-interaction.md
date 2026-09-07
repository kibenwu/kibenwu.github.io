---
layout: post
title: UE 5.8 Motion Matched Interaction：双角色交互的学习与最小验证
subtitle: 从 Role、MultiAnimAsset 到联合 Pose Search、对齐与测试路线
author: KivenWu
header-style: text
tags:
  - UE5
  - Animation
  - Motion Matching
  - Pose Search
  - Interaction
---

# Motion Matched Interaction 是什么

Motion Matched Interaction（下文简称 MMI）是基于 Pose Search 的多角色交互匹配思路。它解决的问题不是“让两个角色各自找到一条看起来合适的动画”，而是：

> 让多个角色针对同一段交互、同一个时间点，得到彼此兼容的动画与空间关系。

例如握手、推挤、扶起、双人搬运。若 A 独立选到握手动画的 `0.3s`，B 独立选到另一变体的 `0.9s`，双方手部、根位置与朝向都可能不再对应。MMI 把“交互组合”视为搜索单位，避免这种失配。

本文以 UE 5.8 的 Pose Search 体系为背景，先建立模型，再给出可执行的最小验证路线。功能和资产命名仍处于快速演进阶段；创建资产或接线时，以本机 UE 5.8 编辑器与 API 提示为准。

---

# 先区分：普通 MM 与交互 MM

## 普通 Motion Matching

普通 Motion Matching 的查询只描述一个角色：

```text
当前角色姿态 + 历史轨迹 + 预测轨迹
                ↓
        搜索单角色 Pose Search Database
                ↓
    输出：动画资产 + Selected Time + Search Cost
```

搜索候选不是“整条动画”，而是动画索引中的姿态样本。命中后从 `Selected Time` 开始播放；随后持续搜索时，当前动画的下一帧也会作为 continuing pose 参与竞争。

## Motion Matched Interaction

交互搜索同时考虑多个参与者：

```text
角色 A 姿态 ─┐
角色 B 姿态 ─┼─→ 交互 Database / 联合搜索 ─→ 同一交互资产的同一时间点
双方相对变换 ┘                                  ├─ A 的动画与根对齐数据
                                                  └─ B 的动画与根对齐数据
```

概念上，总代价可理解为：

```text
Total Cost =
    A 的姿态与轨迹差异
  + B 的姿态与轨迹差异
  + 双方相对位置与朝向差异
  + Bias / Continuing Context / Constraint
```

它不是让两边各自取最低分，而是找一组使联合代价最低的交互帧。

---

# 核心资产：MultiAnimAsset 与 Role

## MultiAnimAsset：一条多角色交互记录

普通 `AnimSequence` 只描述一个角色。多角色交互需要一个能容纳多个参与者动画、共享参考系和角色身份的容器；在 Pose Search Interaction API 中，这个概念对应 `UMultiAnimAsset`。

```text
Handshake_01
├── Role: Initiator  → AS_Handshake_Initiator
└── Role: Responder  → AS_Handshake_Responder
```

这不是“随便选两条动画放一起”。内容制作必须满足：

1. 两方动画在 DCC 中按同一世界参考系制作或对齐。
2. 同一个时间点代表同一交互阶段。
3. 根运动、相对位置与朝向可互相对应。
4. 动画长度、采样率、镜像约定应明确。

以握手为例：

| 时间 | Initiator | Responder |
|---|---|---|
| `0.0s` | 走近、抬手 | 面向对方、准备抬手 |
| `0.4s` | 前伸 | 前伸 |
| `0.8s` | 接触 | 接触 |
| `1.5s` | 保持 / 摇手 | 保持 / 摇手 |
| `2.0s` | 收手 | 收手 |

MMI 可以让系统选择进入这段同步关系的合理时间点，但不能把两条空间关系不一致的独立动画自动修成高质量握手。

## Role：交互身份，不是 Actor 名称

`Role` 表示交互语义位置，例如：

```text
Initiator / Responder
Attacker / Victim
Leader / Follower
Carrier / Carried
```

它不是 `Player_001` 或 `NPC_007`。同一份交互资产可由任意 Actor 复用：

```text
Player → Initiator
NPC    → Responder
```

Role 至少决定：

- 当前 Actor 从多角色动画中取得哪一条动画；
- 当前 Actor 使用哪套骨骼与特征定义；
- 结果中的动画上下文、根变换和对齐数据属于谁；
- 交互双方是否构成一个有效的角色组合。

---

# Interaction Schema：为每个 Role 描述“什么算匹配”

单角色 Pose Search Schema 常包含：

```text
Pose Channel
├── pelvis
├── foot_l
└── foot_r

Trajectory Channel
├── 过去轨迹
└── 未来轨迹
```

交互 Schema 则需要把 Role 纳入结构。概念示例：

```text
Role: Initiator
├── Skeleton: SK_Mannequin
├── Pose: pelvis / hand_r / foot_l / foot_r
└── Trajectory: Initiator trajectory

Role: Responder
├── Skeleton: SK_Mannequin
├── Pose: pelvis / hand_l / hand_r
└── Trajectory: Responder trajectory
```

对于握手、推拉等动作，手部、上半身朝向和角色间根变换通常比 locomotion 更重要。对于“走近后握手”，腿部与未来轨迹仍然有价值。

## 不要污染 locomotion Schema

将双手、交互约束直接塞进通用 locomotion Schema，常导致：

- 为了手部相似而选错脚相位；
- DB 维度上涨，搜索与调参更困难；
- 交互动画加入后影响原本 locomotion 的归一化统计；
- locomotion 和 interaction 的 Bias、Branch In、Block Transition 规则互相干扰。

推荐分库：

```text
PSD_Locomotion
└── 脚、骨盆、移动轨迹

PSD_Interaction_Handshake
└── 双方手部、上半身、根相对关系、交互动画
```

---

# Availability：双方如何“报名”

交互系统需要先知道：谁愿意参与、能扮演什么 Role、可使用哪些交互库。该声明对应 `FPoseSearchInteractionAvailability` 一类数据。

概念结构：

```text
Availability
├── Database      = PSD_Interaction_Handshake
├── Role          = Initiator 或 Responder
└── TickPriority  = 交互求值顺序提示
```

运行时流程：

```text
Player AnimInstance
  └─ 发布：我可作为 Initiator 参与 Handshake DB

NPC AnimInstance
  └─ 发布：我可作为 Responder 参与 Handshake DB

PoseSearch Interaction Subsystem
  └─ 收集 Availability，寻找 Role 齐全且空间条件合理的组合
```

双方都没有注册 Availability，就没有可匹配的交互组合。交互触发通常仍来自 Gameplay：输入、目标选择、距离、视线、战斗状态、任务状态等。MMI 不负责决定“玩家现在是否应该握手”，它负责在允许交互后，为双方选择合适动画时间点与空间结果。

---

# Interaction Subsystem：配对、联合搜索、结果分发

在概念上，`UPoseSearchInteractionSubsystem` 是世界级协调器。它不应被理解为“再做一次单角色搜索”，而是多方协同：

```text
1. 收集本帧 Availability
2. 按 Database、Role、距离、目标关系做粗筛
3. 找到 Role 齐全的候选 Actor 组合
4. 在交互资产的同步时间轴上做联合搜索
5. 给每个 Actor 分发自身 Role 对应的结果
```

返回结果沿用或扩展 Pose Search 结果概念，常见信息包括：

```text
Selected Anim
Selected Time
Search Cost
Is Interaction
Role / Role Index
Actor Root Transforms
Actor Root Bone Transforms
Anim Contexts
```

其中最重要的是：**双方需要命中同一个交互资产的兼容时间点。** `Selected Anim` 对双方不同，但两边的结果属于同一交互上下文。

---

# 播放与对齐：MMI 不替代 Blend、Warping 和 IK

搜索成功后，各 Actor 仍需在自己的 AnimGraph 中播放结果：

```text
Interaction Result
    ↓
对应 Role 的 Anim + Selected Time
    ↓
Blend Stack / Motion Matching Node / Montage
    ↓
Offset Root Bone 或 Motion Warping
    ↓
Full Body IK / 手部 IK
```

职责边界：

| 层 | 职责 |
|---|---|
| Gameplay | 是否发起、目标是谁、是否允许交互 |
| Availability / Subsystem | 寻找可配对参与者、联合匹配 |
| Pose Search | 选择交互资产和进入时间 |
| Blend Stack / Inertialization | 将新动画平滑混入当前姿态 |
| Offset Root Bone / Motion Warping | 处理角色根位置与朝向收敛 |
| IK / FBIK | 保证手、道具或接触点的最终精确性 |

MMI 不会自动解决：

- 手指精确贴合；
- 两个网络客户端独立搜索后的结果一致性；
- Gameplay 状态切换；
- 碰撞、占位、路径规划；
- 低质量或空间未对齐的交互动画。

---

# 与 Contextual Animation 的区别

两者都能处理双角色动作，但思维模型不同：

| 维度 | Contextual Animation | Motion Matched Interaction |
|---|---|---|
| 核心模型 | 预定义场景、进入条件与对齐轨道 | 多角色交互动画的联合 Pose Search |
| 选择依据 | 触发区域、距离、朝向、手工规则 | 双方姿态、轨迹、相对关系、代价 |
| 进入连续性 | 常通过 Warp、Montage Blend 处理 | 通过匹配合适姿态与时间改善 |
| 可预测性 | 高 | 较低，需要观察候选和 Cost |
| 适用动作 | 处决、开门、上车、严格分段交互 | 推挤、周旋、并行移动、变体较多的持续关系 |

现实项目中常混用：Gameplay 或 Contextual 系统决定“这是握手交互”；Chooser / MMI 决定“握手库中哪种变体、从哪个时间点最连续”；Warping 与 IK 保证落地。

---

# GASP 5.8 中可参考的资产

Game Animation Sample 5.8 的项目中可找到 Pose Search 驱动的 Smart Object 交互链路，适合学习“交互数据如何进入动画层”：

```text
Content/Blueprints/SmartObjects/
├── PSS_SmartObject
├── CHPA_SmartObject
├── SmartObjectAnimationPayload
├── Bench/
│   ├── BP_SmartBench
│   ├── SO_BenchDefinition
│   ├── CHT_SmartObject_BenchAnim
│   └── ST_SmartObject_Bench
└── TasksAndConditions/
    └── STT_PlayAnimFromBestCost
```

另有两个名称带 `MMI` 的动画 Notify：

```text
Content/Blueprints/AnimNotifies/
├── BP_NotifyState_MMI_IK
└── BP_NotifyState_MMI_MotionWarping
```

这些资产证明 GASP 使用了 Pose Search、Warping、IK 和 Smart Object 组合来做交互；但不要直接假设它们就是完整的双角色 `MotionMatchInteraction` 示例。学习时应先检查它们的父类、输入输出与实际调用图。

---

# 最小双角色验证：握手原型

目标不是先做完整生产系统，而是验证这条最小链路：

```text
双方进入范围
→ 双方声明可用 Role
→ 成功找到同一交互上下文
→ 两边从兼容时间播放对应动画
→ 根位置和手部接触可接受
```

## 内容清单

```text
2 个同骨架角色
2 条严格同步的握手动画
1 个双角色交互资产 / MultiAnimAsset
1 个 Interaction Schema
1 个 Interaction Database
2 个 AnimBP（可共享逻辑，Role 不同）
1 个简单目标选择与触发逻辑
可选：Motion Warping、Offset Root Bone、FBIK
```

## 推荐测试阶段

### 阶段 1：先验证内容对齐

不接 MMI，直接让两角色以预设 Transform 同步播放两条握手动画。

验收：

- `t=0.0`、接触帧、结束帧的手部关系正确；
- 双方根位置没有明显错位；
- 动画不是各自独立导出后强行拼接。

这一步失败，后续 Pose Search 无法修复内容问题。

### 阶段 2：验证 Role 到动画的映射

用明确的 `Initiator` / `Responder` 常量，确保：

```text
Actor A → Initiator 动画
Actor B → Responder 动画
```

验收：两边角色不会拿反动画；双方从同一相对时间开始播放。

### 阶段 3：接入交互搜索

加入 Availability 和交互 Database。首先只放一套握手动作，减少变量。

验收：

- `Is Interaction = true`；
- 两边都有有效 `Selected Anim`；
- `Selected Time` 合理；
- 两边结果属于同一交互上下文；
- `Search Cost` 不为 `FLT_MAX`。

### 阶段 4：接入对齐与混合

将结果写入 Blend Stack 或对应播放节点；用 Offset Root Bone 或 Motion Warping 平滑收敛根差；最后加手部 IK。

验收：从 Idle / Locomotion 进入交互时，没有硬跳、穿插或明显滑步。

### 阶段 5：增加变体

再加入左手、右手、不同朝向、不同距离的握手变体。此时才值得调 Schema 权重、Cost Bias、Constraint 和 Branch In。

---

# 调试清单

## 先看是否进入候选池

如果结果是：

```text
Selected Anim = None
Selected Database = None
Search Cost = FLT_MAX
```

说明没有有效候选，而不是“候选 Cost 太高”。优先检查：

1. Role 是否完整；
2. Database 是否正确；
3. MultiAnimAsset / 动画是否被索引；
4. Schema 与 Skeleton 是否兼容；
5. Branch In / Sampling Range 是否覆盖合法区间；
6. Availability 是否在双方有效更新路径中发布。

## 再看是否配错对象

记录每次搜索：

```text
Frame
Self Actor
Other Actor
Database
Role
Selected Anim
Selected Time
Search Cost
Is Interaction
```

若有多个 NPC，必须额外记录配对目标。否则只能看到“搜索成功”，却无法知道玩家与谁建立了交互上下文。

## 再看空间对齐

搜索正确但视觉仍错位，分别看：

- 内容制作时双方根是否在共享参考系；
- `ActorRootTransforms` 是否被消费；
- Motion Warping target 是否正确；
- Offset Root Bone 是否在输出路径；
- IK 是否在正确时间段启用；
- Blend Profile 是否让根或脚过早硬切。

## 可用工具

- Rewind Debugger：查看 Pose Search、动画播放、Blend Weight、Notify、Root Offset。
- Pose Search Database 编辑器：确认索引样本、角色、Schema 与动画条目。
- Output Log：过滤 `LogPoseSearch`。
- 控制台：编辑器输入 `Help` 后在生成的帮助中搜索 `PoseSearch`、`Interaction`、`MotionMatching`。不同小版本的 CVar 名可能变化，不要靠猜测硬输。

---

# 设计原则

1. **Gameplay 决定是否交互；MMI 决定如何连续地进入交互。**
2. **交互内容先正确，再谈匹配。** 动画空间关系错误，算法不能凭空修复。
3. **单角色 locomotion 与交互使用分离 Schema / DB。**
4. **先单一交互、单一 Role 组合，后扩展变体。**
5. **MMI 负责选帧；Warping 与 IK 负责最后几厘米。**
6. **网络项目不要假设客户端各自搜索会自然一致。** 需要明确谁权威、如何复制交互上下文、何时同步 Selected Anim / Time。

---

# 参考

- [Motion Matching in Unreal Engine](https://dev.epicgames.com/documentation/unreal-engine/motion-matching-in-unreal-engine)
- [PoseSearch Plugin API](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/PoseSearch)
- [Break Pose Search Blueprint Result](https://dev.epicgames.com/documentation/unreal-engine/BlueprintAPI/Utilities/Struct/BreakPoseSearchBlueprintResult)
- [Make Pose Search Interaction Availability](https://dev.epicgames.com/documentation/unreal-engine/BlueprintAPI/Utilities/Struct/MakePoseSearchInteractionAvailab-)
- [Game Animation Sample Project](https://dev.epicgames.com/documentation/unreal-engine/game-animation-sample-project-in-unreal-engine)

---

# 下一步

推荐先在 GASP 5.8 中读 `PSS_SmartObject`、`STT_PlayAnimFromBestCost`、`BP_NotifyState_MMI_IK` 与 `BP_NotifyState_MMI_MotionWarping`，确认现有 Smart Object 交互如何组织 Pose Search、Warping、IK。

之后创建“仅一套握手动画、两个 Role、一个 Database”的原型。原型通过前，不应急着把 MMI 接入完整 locomotion、Chooser 或 Blend Stack 状态机。
