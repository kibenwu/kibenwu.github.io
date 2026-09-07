---
layout: post
title: UE 5.8 Motion Matched Interaction：双角色交互的学习与最小验证
subtitle: 按概念、GASP 对照、引擎 API、MVI 与扩展建立学习路径
author: KivenWu
header-style: text
tags:
  - UE5
  - Animation
  - Motion Matching
  - Pose Search
  - Interaction
---

# 学习路径

本文按以下顺序学习 UE 5.8 Pose Search 体系中的 Motion Matched Interaction（下文简称 MMI）：

```text
概念
  ↓
GASP 对照
  ↓
引擎 API 概念映射
  ↓
最小可行交互验证（MVI）
  ↓
扩展：对齐、变体、调试、网络
```

这里的 **MVI** 指 *Minimal Viable Interaction*，即最小可行交互验证。目标不是立即完成生产级双角色系统，而是先证明：两个角色能为同一交互上下文取得兼容动画和时间点。

MMI 的资产名、节点名和 API 在 UE 小版本之间仍可能变化。本文中的类型名、字段名和图示用于建立模型；创建资产、接线和调用时，以本机 UE 5.8 编辑器、插件内容和 API 提示为准。

---

# 概念：Motion Matched Interaction 是什么

MMI 是基于 Pose Search 的多角色交互匹配思路。它要解决的不是“让两个角色各自找到一条看起来合适的动画”，而是：

> 让多个角色针对同一段交互、同一个时间点，得到彼此兼容的动画与空间关系。

例如握手、推挤、扶起、双人搬运。若 A 独立选到握手动画的 `0.3s`，B 独立选到另一变体的 `0.9s`，双方手部、根位置和朝向都可能不再对应。MMI 把“交互组合”视为搜索单位，避免这种失配。

## 普通 Motion Matching

普通 Motion Matching 的查询只描述一个角色：

```text
当前角色姿态 + 历史轨迹 + 预测轨迹
                ↓
        搜索单角色 Pose Search Database
                ↓
    输出：动画资产 + Selected Time + Search Cost
```

搜索候选不是“整条动画”，而是动画索引中的姿态样本。命中后从 `Selected Time` 开始播放；持续搜索时，当前动画的下一帧也可作为 continuing pose 参与竞争。

## Motion Matched Interaction

交互搜索同时考虑多个参与者：

```text
角色 A 姿态 ─┐
角色 B 姿态 ─┼─→ 交互 Database / 联合搜索 ─→ 同一交互资产的兼容时间点
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

这是心智模型，不是对引擎内部公式的逐项复述。重点在于：两边不是各自取最低分，而是搜索一组联合代价更低、时间关系兼容的交互帧。

---

# GASP 对照：从示例资产理解交互链路

GASP 5.8 中可找到 Pose Search 驱动的 Smart Object 交互链路，适合学习“交互数据如何进入动画层”：

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

这些资产可以确认 GASP 使用 Pose Search、Warping、IK、Smart Object 组合来组织交互。它们适合作为“输入如何进入动画层、如何选动画、如何落地对齐”的参考。

但不要仅依据名称就认定它们是完整双角色 `MotionMatchInteraction` 示例。学习时先检查：父类、输入输出、引用资产、调用图和运行时角色数量。

## 推荐阅读顺序

```text
1. PSS_SmartObject
   → 看 Schema 采样哪些姿态和相对特征

2. CHT_SmartObject_BenchAnim
   → 看 Chooser 如何按对象、距离或上下文筛选

3. STT_PlayAnimFromBestCost
   → 看 StateTree 如何消费 Pose Search 结果

4. BP_NotifyState_MMI_IK / BP_NotifyState_MMI_MotionWarping
   → 看接触与根对齐如何在动画时间段内启用
```

## 与 Contextual Animation 的区别

两者都能处理双角色动作，但思维模型不同：

| 维度 | Contextual Animation | Motion Matched Interaction |
|---|---|---|
| 核心模型 | 预定义场景、进入条件与对齐轨道 | 多角色交互动画的联合 Pose Search |
| 选择依据 | 触发区域、距离、朝向、手工规则 | 双方姿态、轨迹、相对关系、代价 |
| 进入连续性 | 常通过 Warp、Montage Blend 处理 | 通过匹配合适姿态与时间改善 |
| 可预测性 | 高 | 较低，需要观察候选和 Cost |
| 适用动作 | 处决、开门、上车、严格分段交互 | 推挤、周旋、并行移动、变体较多的持续关系 |

实际项目可混用：Gameplay 或 Contextual 系统决定“这是握手交互”；Chooser / MMI 决定“握手库中哪种变体、从哪个时间点进入更连续”；Warping 与 IK 完成最终对齐。

---

# 引擎 API 概念映射

以下是理解 Interaction API 时最重要的五层。具体类名和可用节点需以当前 UE 5.8 安装为准。

## MultiAnimAsset 与 Role

普通 `AnimSequence` 只描述一个角色。多角色交互需要一个容纳多个参与者动画、共享参考系和角色身份的容器；在 Pose Search Interaction API 中，`UMultiAnimAsset` 是与此概念对应的类型。

```text
Handshake_01
├── Role: Initiator  → AS_Handshake_Initiator
└── Role: Responder  → AS_Handshake_Responder
```

这不是“随便选两条动画放一起”。内容制作需要满足：

1. 两方动画在 DCC 中按同一世界参考系制作或对齐；
2. 同一个时间点代表同一交互阶段；
3. 根运动、相对位置和朝向可互相对应；
4. 动画长度、采样率、镜像约定明确。

以握手为例：

| 时间 | Initiator | Responder |
|---|---|---|
| `0.0s` | 走近、抬手 | 面向对方、准备抬手 |
| `0.4s` | 前伸 | 前伸 |
| `0.8s` | 接触 | 接触 |
| `1.5s` | 保持 / 摇手 | 保持 / 摇手 |
| `2.0s` | 收手 | 收手 |

MMI 可帮助系统选择进入这段同步关系的合理时间点，但不能把空间关系错误的两条独立动画自动修成高质量握手。

`Role` 表示交互语义位置，而不是 `Player_001` 或 `NPC_007`：

```text
Initiator / Responder
Attacker / Victim
Leader / Follower
Carrier / Carried
```

同一份交互资产可由不同 Actor 复用：

```text
Player → Initiator
NPC    → Responder
```

Role 用于关联当前 Actor 的动画、骨骼特征、交互结果和根对齐数据。

## Interaction Schema：每个 Role 如何匹配

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

交互 Schema 需要把 Role 纳入结构。概念示例：

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

握手、推拉等动作中，手部、上半身朝向和角色间根变换通常比 locomotion 更重要；“走近后握手”仍可能需要腿部和未来轨迹。

### 不要污染 locomotion Schema

将双手、交互约束直接塞进通用 locomotion Schema，常导致：

- 为了手部相似而选错脚相位；
- DB 维度上涨，搜索与调参更困难；
- 交互动画加入后影响原 locomotion 的归一化统计；
- locomotion 和 interaction 的 Bias、Branch In、Block Transition 规则互相干扰。

推荐分库：

```text
PSD_Locomotion
└── 脚、骨盆、移动轨迹

PSD_Interaction_Handshake
└── 双方手部、上半身、根相对关系、交互动画
```

## Availability：双方如何报名

交互系统需要知道谁愿意参与、能扮演什么 Role、可使用哪些交互库。`FPoseSearchInteractionAvailability` 是与这类声明对应的 API 名称。

概念结构：

```text
Availability
├── Database      = PSD_Interaction_Handshake
├── Role          = Initiator 或 Responder
└── TickPriority  = 交互求值顺序提示
```

运行时模型：

```text
Player AnimInstance
  └─ 发布：我可作为 Initiator 参与 Handshake DB

NPC AnimInstance
  └─ 发布：我可作为 Responder 参与 Handshake DB

PoseSearch Interaction Subsystem
  └─ 收集 Availability，寻找 Role 齐全且空间条件合理的组合
```

双方未声明可用性，就没有可匹配的交互组合。交互触发仍来自 Gameplay：输入、目标选择、距离、视线、战斗状态或任务状态。MMI 不决定“玩家现在是否应该握手”，而是在交互已允许时帮助选择更连续的动画时间点和空间结果。

## Interaction Subsystem：配对、搜索、分发

`UPoseSearchInteractionSubsystem` 可以理解为世界级协调器：

```text
1. 收集本帧 Availability
2. 按 Database、Role、距离、目标关系做粗筛
3. 找到 Role 齐全的候选 Actor 组合
4. 在交互资产的同步时间轴上做联合搜索
5. 给每个 Actor 分发自身 Role 对应的结果
```

结果通常以 Pose Search 结果的形式提供或扩展，可能包括：

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

应把这些字段看作理解结果的检查对象，而不是保证每个版本都以完全相同名称暴露。核心要求不变：双方应命中同一交互上下文的兼容时间点；`Selected Anim` 可不同，但两边结果需要相互对应。

## 播放与对齐：搜索只是其中一层

搜索成功后，每个 Actor 仍要在自己的 AnimGraph 中消费结果。以下是推荐的组织边界，不是引擎强制管线：

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

| 层 | 职责 |
|---|---|
| Gameplay | 是否发起、目标是谁、是否允许交互 |
| Availability / Subsystem | 寻找可配对参与者、联合匹配 |
| Pose Search | 选择交互资产和进入时间 |
| Blend Stack / Inertialization | 将新动画平滑混入当前姿态 |
| Offset Root Bone / Motion Warping | 处理根位置与朝向收敛 |
| IK / FBIK | 保证手、道具或接触点的最终精确性 |

MMI 不自动解决手指精确贴合、Gameplay 状态切换、碰撞、占位、路径规划或低质量交互内容。

---

# 最小可行交互验证（MVI）：双角色握手原型

MVI 的目标是验证最小闭环，而不是先接完整 locomotion：

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
```

Motion Warping、Offset Root Bone 和 FBIK 在 MVI 第一轮不是必需项；先验证搜索与同步，再逐步加入。

## 阶段 1：验证交互内容对齐

不接 MMI。让两角色以预设 Transform 同步播放两条握手动画。

验收：

- `t=0.0`、接触帧、结束帧的手部关系正确；
- 双方根位置没有明显错位；
- 动画不是各自独立导出后强行拼接。

这一步失败，后续 Pose Search 无法修复内容问题。

## 阶段 2：验证 Role 到动画的映射

用明确的 `Initiator` / `Responder` 常量，确保：

```text
Actor A → Initiator 动画
Actor B → Responder 动画
```

验收：两边角色不会拿反动画；双方从同一相对时间开始播放。

## 阶段 3：接入交互搜索

加入 Availability 和交互 Database。第一轮只放一套握手动作，减少变量。

验收：

- `Is Interaction = true`，或编辑器当前 API 提供等价成功状态；
- 两边都有有效 `Selected Anim`；
- `Selected Time` 合理；
- 两边结果属于同一交互上下文；
- `Search Cost` 不为 `FLT_MAX`。

MVI 到此完成。成功后再接完整的状态机、Chooser 或 Blend Stack locomotion 管线。

---

# 扩展：把 MVI 变成可用系统

## 对齐与混合

MVI 成功后，将结果写入 Blend Stack、Motion Matching 节点或 Montage。再按项目需求加入：

```text
Offset Root Bone
→ 吸收根骨骼的突变并平滑收敛

Motion Warping
→ 将根运动朝目标位置或朝向修正

FBIK / 手部 IK
→ 把最终接触点锁到对方手、肩膀或道具
```

验收标准：从 Idle / Locomotion 进入交互时，没有硬跳、穿插或明显滑步；接触帧没有显著悬空。

## 增加交互变体与调参

第二轮再加入左手、右手、不同朝向、不同距离的握手变体。此时才值得调：

- Schema 中 Pose / Trajectory / 手部特征权重；
- Cost Bias；
- Constraint；
- Branch In 与 Block Transition；
- Chooser 的前置筛选规则。

调参原则：先用 Schema 和候选范围解决“什么算像、哪些帧可进入”；最后再用 Bias 表达艺术偏好。

## 调试清单

### 先看是否进入候选池

若结果近似：

```text
Selected Anim = None
Selected Database = None
Search Cost = FLT_MAX
```

说明没有有效候选，不是“候选 Cost 太高”。优先检查：

1. Role 是否完整；
2. Database 是否正确；
3. MultiAnimAsset / 动画是否被索引；
4. Schema 与 Skeleton 是否兼容；
5. Branch In / Sampling Range 是否覆盖合法区间；
6. Availability 是否在双方有效更新路径中发布。

### 再看是否配错对象

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

多个 NPC 同时可交互时，必须记录配对目标；否则只能看到“搜索成功”，无法确认玩家究竟与谁建立了交互上下文。

### 再看空间对齐

搜索正确但视觉仍错位，检查：

- 内容制作时双方根是否在共享参考系；
- `ActorRootTransforms` 或等价结果是否被消费；
- Motion Warping target 是否正确；
- Offset Root Bone 是否在输出路径；
- IK 是否在正确时间段启用；
- Blend Profile 是否让根或脚过早硬切。

### 可用工具

- Rewind Debugger：查看 Pose Search、动画播放、Blend Weight、Notify、Root Offset；
- Pose Search Database 编辑器：确认索引样本、角色、Schema 与动画条目；
- Output Log：过滤 `LogPoseSearch`；
- 控制台：编辑器输入 `Help` 后，在生成帮助中搜索 `PoseSearch`、`Interaction`、`MotionMatching`。不同版本的 CVar 名可能变化，不要靠猜测硬输。

## 网络与系统设计原则

1. **Gameplay 决定是否交互；MMI 决定如何更连续地进入交互。**
2. **交互内容先正确，再谈匹配。** 空间关系错误，算法不能凭空修复。
3. **单角色 locomotion 与交互使用分离 Schema / DB。**
4. **先单一交互、单一 Role 组合，后扩展变体。**
5. **MMI 负责选帧；Warping 与 IK 负责最后几厘米。**
6. **网络项目不要假设客户端各自搜索会自然一致。** 必须明确权威端、交互上下文复制策略，以及 `Selected Anim` / `Selected Time` 的同步时机。

---

# 参考

- [Motion Matching in Unreal Engine](https://dev.epicgames.com/documentation/unreal-engine/motion-matching-in-unreal-engine)
- [PoseSearch Plugin API](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/PoseSearch)
- [Break Pose Search Blueprint Result](https://dev.epicgames.com/documentation/unreal-engine/BlueprintAPI/Utilities/Struct/BreakPoseSearchBlueprintResult)
- [Make Pose Search Interaction Availability](https://dev.epicgames.com/documentation/unreal-engine/BlueprintAPI/Utilities/Struct/MakePoseSearchInteractionAvailab-)
- [Game Animation Sample Project](https://dev.epicgames.com/documentation/unreal-engine/game-animation-sample-project-in-unreal-engine)

---

# 下一步

按 MVI 阶段 1 创建或确认一对严格同步的握手动画；再在 GASP 资产中按本文顺序阅读 Smart Object、Pose Search、Warping 与 IK 的组织方式。MVI 成功前，不要急着接入完整 locomotion、Chooser 或 Blend Stack 状态机。
