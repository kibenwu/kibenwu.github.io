---
layout: post
title: GASP 5.8 Motion Matching 全流程拆解：动画蓝图、Chooser Table 与 Database 切分
subtitle: 从资产地图到 AnimGraph 结构、代价权重与数据库分层的分步教程
author: KivenWu
header-style: text
tags:
  - UE5
  - Animation
  - Motion Matching
  - Pose Search
  - Chooser
  - GASP
---

# 这篇教程解决什么

Game Animation Sample（GASP）5.8 里 Motion Matching 部分资产数量很大，初学者常见的三个困惑：

1. 动画蓝图到底分成哪些模块，Motion Matching 处在哪一层；
2. Chooser Table 是怎么建、怎么配、和 Motion Matching 谁先谁后；
3. 那几十个 `PSD_*` 数据库为什么要这么切，凭什么切。

本文按「资产地图 → AnimBP 结构 → Chooser 构建 → 代价与权重 → Database 切分 → 从零搭建步骤 → 调试」的顺序拆解。

文中路径与资产名来自 GASP 5.8 工程扫描，属于可核对的事实。凡属推断或约定的部分都会标注。资产内部的逐列配置最终仍需在编辑器中打开确认。

---

# 第一部分：资产地图

## 1.1 GASP 里其实有两代方案

这是最容易踩的坑：GASP 5.8 同时保留了两套 locomotion 实现，资产混在一起。

```text
方案 A：Chooser + Motion Matching（主线）
    Chooser 选数据库 → Motion Matching 节点持续搜索 → 内建 Blend Stack 播放

方案 B：State Machine + Chooser + 单帧 MM + Blend Stack（实验性）
    逻辑状态机触发 → Chooser 选动画 → 单帧 MM 定入点 → 写 Blend Stack
```

对应的 AnimBP：

```text
Content/Blueprints/SandboxCharacter_CMC_ABP.uasset      ← CharacterMovementComponent 版
Content/Blueprints/SandboxCharacter_Mover_ABP.uasset    ← Mover 版
Content/Blueprints/RetargetedCharacters/ABP_GenericRetarget.uasset
Content/Blueprints/BPI_SandboxCharacter_ABP.uasset      ← 动画层接口
```

方案 B 的资产集中在：

```text
Content/Characters/UEFN_Mannequin/Animations/ExperimentalStateMachineData/
├── CHT_CMCCharacterAnimations
├── CHT_MoverCharacterAnimations
├── CHT_MoverCharacterAnimations_PoseMatch
├── PSS_SM_CMC_Idles / PSS_SM_CMC_LocoTransitions
├── PSS_SM_Mover_Loops / Spins / Stops / Transitions / TraversalTransitions
├── PSD_SM_CMC_Idles / Loops / Transitions
├── PSD_SM_Mover_Loops / Spins / Stops / Transitions / TraversalTransitions
└── StrafeOffsetCurveContainer
```

**学习建议：先只看方案 A。** 方案 A 是常规 Motion Matching 工作流，方案 B 是 Epic 的实验设定，理解成本高且接口会变。

## 1.2 Motion Matching 主资产目录

```text
Content/Characters/UEFN_Mannequin/Animations/MotionMatchingData/
├── Schemas/               24 个 PSS_*
├── Channels/              自定义特征通道（BP）
│   ├── PSC_Traversal_Head
│   ├── PSC_Traversal_Pos
│   └── PSC_DistanceToTraversalObject
├── Normalization_Sets/
│   ├── PSN_Dense_All
│   ├── PSN_Sparse_All
│   ├── PSN_Extreme_Sparse_All
│   └── PSN_Relaxed_All
├── Databases/
│   ├── Dense/             35 个
│   ├── Sparse/            约 16 个
│   ├── Extreme_Sparse/    约 16 个
│   ├── Relaxed/           约 100 个
│   ├── PSD_Traversal
│   ├── PSD_Ragdoll
│   └── PSD_Relaxed_Run_B / PSD_Relaxed_Run_F
├── CHT_PoseSearchDatabases
├── CHT_PoseSearchDatabases_Dense
├── CHT_PoseSearchDatabases_Sparse
├── CHT_PoseSearchDatabases_ExtremeSparse
├── CHT_PoseSearchDatabases_Relaxed
└── CHT_PoseSearchDatabases_Mover
```

注意最后那批 `CHT_PoseSearchDatabases_*`：**Chooser 在 GASP 里第一层职责不是选动画，而是选数据库。** 这一点后面详述。

## 1.3 动画素材组织

```text
Animations/
├── Idle/ Walk/ Run/ Sprint/ Crouch/ Jump/ Slide/
├── AimOffset/ LookAtPOI/ Poses/ Avoidance/
├── Ragdoll/
├── Interactions/
│   ├── Shoves/    PSD_Interaction_Shove
│   ├── Tackle/    PSD_Interaction_Tackle
│   └── Takedowns/ PSD_Interaction_takedown_stand / walk / Run
└── Traversal/
    ├── Catch/{Cliff, Hurdle, Mantle, Vault}
    ├── Climb/ Hurdle/ Mantle/ Vault/
    ├── CHT_TraversalMontages_CMC / _Mover
    └── CHT_TraversalAnims / _PoseMatch
```

命名规范（很重要，直接决定 Chooser 与 DB 能不能按规则批量组织）：

```text
M_Neutral_Stand_Run_Loop_F
M_Neutral_Stand_Run_Loop_LL
M_Neutral_Run_Pivot_...
M_Neutral_Stand_Turn_...
M_Relaxed_Run_Loop_F
```

```text
[风格] _ [姿态] _ [步态] _ [动作类型] _ [方向 / 起脚]
```

`M_Neutral_*` 供 Dense / Sparse / Extreme_Sparse 使用；`M_Relaxed_*` 供 Relaxed 层使用。**同一套动作有两种表演风格**，这也是数据库数量翻倍的原因之一。

---

# 第二部分：动画蓝图模块如何构建

## 2.1 整体分层

GASP 的 AnimBP 不是一张大图，而是分层职责：

```text
[1] 数据采集层
    BlueprintThreadSafeUpdateAnimation
    Movement Analysis
        ↓ 输出：Speed2D、Gait、Stance、MovementMode、RotationMode、
                MovementDirection、Trajectory、加速度等

[2] 查询构建层
    Trajectory / Motion Trajectory 节点
    Pose History 节点
        ↓ 提供 MM 查询所需的历史与未来信息

[3] 选择层
    Chooser（选数据库 / 选动画）
    Motion Matching 节点（选帧）
        ↓ 输出姿态与播放位置

[4] 播放层
    Blend Stack（MM 节点内建，或实验方案里显式使用）
    Dynamic Play Rate

[5] 后处理层
    Orientation Warping / Stride Warping
    Foot Placement
    Steering
    Offset Root Bone
    Aim Offset / Additive Lean
    Inertialization / Dead Blending
```

CMC ABP 中可见的函数与图（来自资产内可读名称）：

```text
AnimGraph
State Controller

Movement Analysis
Root Offset
Steering
Aim Offset
Additive Lean
Foot Placement
State Machine (Experimental)
Debug
BlueprintThreadSafeUpdateAnimation
```

实验方案相关函数：

```text
SetBlendStackAnimFromChooser
GetChooserStructOutput
GetCurrentBlendStackAnimAsset
GetCurrentBlendStackAnimAssetTime
GetDynamicPlayRate
EnableSteering
GetDesiredFacing
OnStateEntry_*
```

## 2.2 第 1 层：数据采集必须线程安全

Motion Matching 的输入全部在 `BlueprintThreadSafeUpdateAnimation` 里准备。原因：动画更新跑在工作线程，直接访问 Actor 或组件不安全。

做法是把外部数据一次性收集到结构体，再由动画逻辑读取：

```text
Character / Movement Component
        ↓ （每帧一次，安全采集）
S_CharacterPropertiesForAnimation
        ↓
Chooser 输入 / Warping 参数 / 状态判断
```

这一层是整套系统最值得照抄的设计：**AnimBP 不直接依赖 CMC 或 Mover，只依赖中间结构体。** 换移动方案时只重写采集函数。

关键派生量：

| 量 | 用途 |
|---|---|
| `Speed2D` | Gait 判定、Chooser 浮点列、Play Rate |
| 加速度 / 输入方向 | 起步、Pivot 判定 |
| `MovementDirection` | 方向分类（F / B / LL / LR / RL / RR） |
| `Gait` | Walk / Run / Sprint |
| `Stance` | Stand / Crouch |
| `RotationMode` | OrientToMovement / Strafe / Aim |
| `MovementMode` | OnGround / InAir / Sliding / Traversing / Flying / Ragdoll |
| Trajectory | MM 未来轨迹匹配 |

## 2.3 第 2 层：Trajectory 与 Pose History

Motion Matching 的查询向量分两半：

```text
姿态部分  ← Pose History 节点（骨骼位置、速度的历史记录）
轨迹部分  ← 过去轨迹（历史）+ 未来轨迹（预测）
```

两条硬性要求：

1. **Pose History 节点必须在被 Update 的路径上，且在 MM 求值之前更新。**
2. **MM 调用按名字绑定 Pose History。** 名字不匹配 → 查询构建失败。

未来轨迹来自移动模型预测（速度、输入、加速度、制动参数）。轨迹预测越准，MM 的响应越自然；轨迹抖动会直接表现为动画抖动。

## 2.4 第 3 层：Chooser 与 Motion Matching 的分工

这是整套系统最核心的一句话：

> **Chooser 负责「在哪些数据里找」，Motion Matching 负责「找哪一帧」。**

```text
角色状态
   ↓
Chooser：选出本帧应该搜索的 Database 集合
   ↓
Motion Matching 节点：在这些库里做代价搜索
   ↓
输出：动画 + 时间 + Search Cost
```

GASP 用 `CHT_PoseSearchDatabases_*` 系列实现第一层筛选。好处：

- 搜索范围变小，性能可控；
- 语义清晰，「蹲伏时不该搜奔跑库」是配置而非代价巧合；
- 数据库可分层替换（见第五部分的 LOD）。

## 2.5 第 4 层：Blend Stack 与 Dynamic Play Rate

Motion Matching 节点内部就是一个 Blend Stack：每次跳转 push 一个新样本，旧样本淡出。

Blend Stack 的 per-sample 图里，GASP 用 `GetDynamicPlayRate` 修正速度误差：

```text
PlayRate = 角色实际速度 / 当前动画在该帧的根运动速度
         并钳位到 [MinDynamicPlayRate, MaxDynamicPlayRate]
```

动画的根运动速度来自烘焙曲线 `MoveData_Speed`（由 Anim Modifier `AM_MoveData_Speed` 生成）。逐帧曲线保证起步、减速段也能对齐，平均速度做不到这一点。

三种消除脚滑的手段分工：

| 手段 | 改什么 | 上限 |
|---|---|---|
| 选对动画（Chooser + MM） | 换素材 | 取决于覆盖度 |
| Dynamic Play Rate | 时间轴（步频） | 过大变快进 |
| Stride Warping | 空间（步幅） | 过大腿部变形 |

## 2.6 第 5 层：后处理顺序

顺序不能随意调整：

```text
MM 输出姿态
    ↓
Orientation Warping（对齐朝向与移动方向差）
    ↓
Stride Warping（对齐步幅与实际位移）
    ↓
Steering（往根运动上叠额外旋转，朝向目标）
    ↓
Foot Placement（贴合地形、消除滑动与穿插）
    ↓
Offset Root Bone（吸收根的突变，平滑收敛）
    ↓
Aim Offset / Additive Lean（叠加表演）
```

`Offset Root Bone` 是允许使用「根瞬时混合」的前提。若把 Blend Profile 中 `root` 设为瞬时切换而没有 Offset Root Bone，角色会瞬移。

---

# 第三部分：Chooser Table 怎么建、怎么配

## 3.1 GASP 里的 Chooser 资产清单

按用途分组（均为工程内实际路径）：

**选数据库（Motion Matching 主线）**

```text
Animations/MotionMatchingData/
├── CHT_PoseSearchDatabases
├── CHT_PoseSearchDatabases_Dense
├── CHT_PoseSearchDatabases_Sparse
├── CHT_PoseSearchDatabases_ExtremeSparse
├── CHT_PoseSearchDatabases_Relaxed
└── CHT_PoseSearchDatabases_Mover
```

**选动画（实验性状态机方案）**

```text
Animations/ExperimentalStateMachineData/
├── CHT_CMCCharacterAnimations
├── CHT_MoverCharacterAnimations
└── CHT_MoverCharacterAnimations_PoseMatch
```

**Traversal**

```text
Animations/Traversal/
├── CHT_TraversalMontages_CMC
├── CHT_TraversalMontages_Mover
├── CHT_TraversalAnims
└── CHT_TraversalAnims_PoseMatch
```

**交互 / 其他**

```text
Animations/Interactions/CHT_CharacterInteractionPSDs   → 选 PSD_Interaction_*
Animations/Ragdoll/CHT_GetUpMontages                   → 选起身蒙太奇
Blueprints/SmartObjects/Bench/CHT_SmartObject_BenchAnim
Blueprints/SmartObjects/Bench/CHPT_SmartObject_Bench   → Proxy Table
Blueprints/SmartObjects/CHPA_SmartObject               → Proxy Asset
Blueprints/Cameras/CHT_CameraRig                       → 选相机 Rig
Blueprints/Data/CHT_RotationOffsetCurve                → 选旋转偏移曲线
```

从这份清单能看出一个重要事实：**Chooser 在 GASP 里不是「动画专用」，而是通用的数据驱动选择层**，相机、曲线、蒙太奇、数据库都用它选。

## 3.2 Chooser 的四种资产类型

| 类型 | 作用 |
|---|---|
| **Chooser Table** | 主体。若干输入列 + 若干行，每行给出结果与输出结构 |
| **Asset Chooser** | Chooser Table 的子类，结果解析到具体资产；GASP 用于 Pose Match 变体 |
| **Proxy Table** | 中间层，把上下文映射到实际选择表，便于按对象类型替换 |
| **Proxy Asset** | 代理入口，让调用方不直接依赖具体表 |

Smart Object 那条链就是完整用法：

```text
CHPA_SmartObject (Proxy Asset)
      ↓
CHPT_SmartObject_Bench (Proxy Table)
      ↓
CHT_SmartObject_BenchAnim (Asset Chooser)
      ↓
AnimMontage
```

好处：新增一种可交互物体，只加一张表并注册到 Proxy，调用方代码不变。

## 3.3 列类型与配置方式

GASP 的 Chooser 表使用到的列类型（资产内可见的列类实现）：

```text
Enum Column         枚举精确匹配（Gait / Stance / MovementMode / RotationMode）
Multi Enum Column   一行匹配多个枚举值（例如同时接受 Walk 和 Run）
Bool Column         布尔条件（是否刚翻越、是否在转向）
Float Range Column  浮点区间（Speed2D、旋转差、落地时间）
Object Column       对象匹配
Gameplay Tag Column 标签匹配
Randomize Column    多个合法结果随机化，避免重复感
Output Struct Column 该行输出的结构体数据
```

配置心智模型：

```text
列 = 提问        （现在的 Gait 是什么？Speed2D 在哪个区间？）
行 = 一条规则    （满足这些条件时，用这些结果）
输出结构 = 附带参数（StartTime / BlendTime / BlendProfile / Tags / UseMM / MMCostLimit）
```

求值顺序：**自上而下，第一批命中的行胜出。** 因此行顺序本身就是优先级，特例放上面，兜底放最后。

## 3.4 输入上下文：用结构体，不要散参数

GASP 的 Chooser 都绑定结构体作为上下文，例如：

```text
S_CharacterPropertiesForAnimation      通用动画属性
S_CharacterPropertiesForTraversal      翻越检测结果
S_CharacterPropertiesForCamera         相机相关
S_CHT_TraversalMontages_IN / _OUT      翻越表专用输入输出
S_CHT_CharacterInteractionPSDs_IN/_OUT 交互库选择
S_CHT_GetUpMontages_IN / _OUT          起身
S_RotationOffsetCurveChooser_Inputs    曲线选择
S_MoverCustomInputs                    Mover 输入
S_ChooserOutputs                       实验方案输出
```

这个约定带来两个直接收益：

1. 新增一个判定条件 = 结构体加字段 + 表加一列，不需要改调用点签名；
2. 同一份输入结构可被多张表复用（动画、相机、曲线各取所需）。

## 3.5 `CHT_CMCCharacterAnimations` 的构建方式

这是实验方案的核心表，绑定 `SandboxCharacter_CMC_ABP` 作为上下文，输出 `S_ChooserOutputs`。

可确认的绑定包括 `StateMachineState`、`Stance`、`Gait`，以及方向、上一帧状态、速度区间等列。行按状态语义分组，例如：

```text
Stand Idle Loops
Stand Idle Breaks
Stand Turn In Place
Stand Walks F / LL / LR / RL / RR / B
Stand Runs F / ...
Stand Runs F Just Traversed
Crouch Idle Loops
Crouch ...
Jumps F / B / LL / RL
Lands（轻 / 重）
Fall Loops
In Air
Slide 相关
Transition to ...
```

每组行引用对应命名族的动画，例如 `M_Neutral_Stand_Run_Loop_F`、`M_Neutral_Run_Pivot_*`、`M_Neutral_Crouch_*`、`M_Neutral_Jump_*`。

**设计要点：`StateMachineState` 是第一层筛选列。** 因此所有状态共用一张表，而不是每个状态一张。这直接避免了「状态 × 步态 × 姿态 × 方向」的资产爆炸。

一行的完整语义是：

```text
条件：State = Stand Runs F, Gait = Run, Stance = Stand, Speed2D ∈ [x, y]
结果：候选动画（可多条）
输出：StartTime / BlendTime / BlendProfile / Tags / UseMM / MMCostLimit
```

注意：**行可以输出多条动画。** 单条时直接使用第一条；多条时交给 Motion Matching 在候选中挑最连贯的资产与入点——这就是 `UseMM` 存在的意义。

> 表内确切的列数量、行数量与每行标签，需要在编辑器中打开该资产核对。二进制扫描只能确认绑定名与列类型。

---

# 第四部分：动画权重到底由什么决定

这是提问频率最高、也最容易误解的部分。

## 4.1 Chooser 不产生权重

Chooser 输出的是**候选集合与元数据**，不是权重。它做的是布尔与区间筛选：命中或不命中。

真正决定「选中哪一条、哪一帧」的是 Motion Matching 的代价：

```text
Cost = Σ_i  w_i × (query_i − pose_i)² / σ_i²
     + BaseCostBias
     + ContinuingPoseCostBias      （仅当候选是当前动画的下一帧）
     + MirrorMismatchCostBias      （镜像状态不一致）
```

因此「配置动画权重」实际是配置三处：

```text
1. Schema 的通道与骨骼权重     ← 决定“什么算像”
2. 归一化设置                  ← 决定各维度如何公平比较
3. Cost Bias（库级 / Notify 级）← 决定“我偏爱谁、何时别打断”
```

## 4.2 权重第一处：Schema

GASP `PSS_Default` 中可确认的配置：

```text
Skeleton:          SK_UEFN_Mannequin
Channels:          Group / Heading / Position / Trajectory / Velocity
Pose 采样骨骼:      pelvis / foot_l / foot_r
OriginBone:        pelvis
HeadingAxis:       Y
ComponentStripping: StripZ
DataPreprocessor:  NormalizeWithCommonSchema
MirrorDataTable:   已配置（约定指向 MDT_UEFN_Mannequin）
```

几点值得直接借用：

- **只采三根骨骼。** 双脚决定相位，骨盆决定整体姿态。加太多骨骼会污染匹配并抬高成本。
- **`StripZ`** 去掉竖直分量，地面移动匹配更稳定。
- **`NormalizeWithCommonSchema`** 让多个数据库能在同一尺度下比较，这是分库策略成立的前提。
- **Heading 通道**单独存在，朝向不再只靠位置隐含表达，Strafe 表现更可控。

调权重的方向性结论：

| 目标 | 调整 |
|---|---|
| 更跟手、响应更快 | 提高 Trajectory 权重、增加未来采样点 |
| 更连贯、更少抖动 | 提高 Pose 权重 |
| 减少错脚 | 提高 `foot_l` / `foot_r` 的**速度**权重 |
| 转向更准 | 提高 Heading 权重 |

**先调 Trajectory 与 Pose 的比例，这是响应与流畅之间的总开关。**

## 4.3 权重第二处：Normalization Set

GASP 为每个数据库层准备了一套归一化集合：

```text
PSN_Dense_All
PSN_Sparse_All
PSN_Extreme_Sparse_All
PSN_Relaxed_All
```

作用：把该层所有库的特征放在同一个统计基准上归一化。它带来一个必须记住的副作用：

> **增删数据库内容会改变标准差，所有 Cost 数值随之整体漂移，之前调好的 Bias 可能失准。**

所以数据集大改之后要复核 Bias，而不是继续沿用旧数值。

## 4.4 权重第三处：Cost Bias 与 Notify

Bias 是加法偏置，不是倍数。负值更容易被选中，正值更难。

数据库与条目级：

```text
BaseCostBias              固有偏好
ContinuingPoseCostBias    继续播当前动画的折扣
MirrorOption              例如 UnmirroredOnly
SamplingRange             该条目参与索引的时间范围
```

Notify 级（写在动画时间轴上，逐区间生效）：

```text
Motion Matched Branch In              这段可被搜索 / 切入，需指定 Database
Sampling Range                        限库的范围
Exclude From Database                 该区间不建索引
Block Transition In                   已建索引但禁止被跳入（可继续播过去）
Override Base Cost Bias               覆盖该区间的固有偏置
Override Continuing Pose Cost Bias    覆盖该区间的“继续播”折扣
Sampling Attribute / Sampling Event   注入自定义特征 / 事件标签
Constraint                            搜索约束
Override Continuing Context / Interaction   多角色交互相关
```

官方动画的典型配方（GASP 中可见的实际用法量级）：

```text
Branch In:                            全长（循环）或仅开头（一次性动作）
Block Transition In:                  开头之后至结尾，防止中途被跳入
Override Continuing Pose Cost Bias:   开头约 10 帧，值 -0.1
```

`-0.1` 的意义：给刚开播的动画一个约 10% 量级的折扣，避免 MM 每帧反悔造成抖动；十帧后恢复正常竞争。

**这个量级来自实测，不是通用常数。** 正确做法是先看 Rewind Debugger 里典型 Cost 的量级，取其 5%～20% 作为 Bias。

## 4.5 一条铁律

```text
结构问题 → 用 Notify 解决（哪些帧可进入）
手感问题 → 用 Schema 权重解决（什么算像）
偏好问题 → 才用 Bias 解决（我喜欢哪条）
```

顺序搞反，会陷入无限调参。

---

# 第五部分：Database 如何切分

GASP 的分库不是随手拆的，是一个**二维网格加特殊状态**的结构。

## 5.1 轴一：密度层（质量与内存的取舍）

```text
Dense/            35 个   完整矩阵
Relaxed/          约 100 个 另一套表演风格，方向与起脚拆得更细
Sparse/           约 16 个  仅保留骨架
Extreme_Sparse/   约 16 个  进一步合并
```

Dense 层保留完整拆分：

```text
PSD_Dense_Stand_Idles
PSD_Dense_Stand_TurnInPlace
PSD_Dense_Stand_{Walk|Run|Sprint}_{Loops|Pivots|Starts|Stops|SpinTransition|FromTraversal}
PSD_Dense_Stand_Idle_Lands_Heavy / _Light
PSD_Dense_Crouch_Idles / _Crouch_TurnInPlace
PSD_Dense_Jumps / _Jumps_Far / _Jumps_FromTraversal
```

Sparse 与 Extreme_Sparse 只保留 loops、starts、stops、pivots，丢掉独立的 idle、turn、land 细分。Extreme_Sparse 进一步把落地变体合并成单一代表。

**这是 LOD 思路：远处或低配平台换用精简层，运行时按 `MMDatabaseLOD` 切换。** 每层配套自己的 Normalization Set，保证层内比较有效。

## 5.2 轴二：运动族（语义分库）

命名即结构：

```text
PSD_{Tier}_{Stance}_{Gait}_{Phase}

Stance ∈ Stand | Crouch
Gait   ∈ Idle | Walk | Run | Sprint
Phase  ∈ Loops | Pivots | Starts | Stops | SpinTransition | Turns |
         Lands | FromTraversal | GaitTransitions
```

例如 `PSD_Dense_Stand_Run_Loops` 的条目全部是 `M_Neutral_Run_Loop_*` 系列（八方向 + 起脚变体）加上少量 `Shuffle_*` 与 `Transition_*_to_Run_*`，每条带自己的 `SamplingRange`，`MirrorOption` 为 `UnmirroredOnly`。

`UnmirroredOnly` 说明 GASP 不依赖运行时镜像来生成反向动作，而是把左右变体作为独立资产入库。代价是资产更多，收益是可控性与表演质量。

Relaxed 层把方向拆得更细，出现独立的 `PSD_Relaxed_Stand_Run_LL_Loops`、`..._RR_Loops` 以及按起脚拆分的库；还包含滑行退出链：

```text
PSD_Relaxed_Slide_FeetOut
PSD_Relaxed_Slide_KneesOut
PSD_Relaxed_Slide_FeetOut_ExitTo{StandIdle|CrouchIdle|Walk|Run|Sprint|CrouchWalk}
```

**「退出到某状态」单独成库**，让状态衔接可精确控制，而不是靠一次大范围搜索赌运气。

## 5.3 特殊状态：独立库 + 独立 Schema

```text
PSD_Traversal                     Schema: PSS_Traversal
PSD_Ragdoll                       Schema: PSS_Ragdoll
PSD_Interaction_Shove             Schema: PSS_Interaction_Shove
PSD_Interaction_Tackle            Schema: PSS_Interaction_Tackle
PSD_Interaction_takedown_*        Schema: PSS_Interaction_Takedown
（Smart Object 侧）               Schema: PSS_SmartObject
```

`PSD_Traversal` 的结构和 locomotion 库明显不同：

```text
PoseSearchMode:  BruteForce
条目类型:        AnimMontage（不是 AnimSequence）
每条目附带:      BlendParamX / BlendParamY
                 bUseGridForSampling
                 bUseSingleSample
                 NumberOfHorizontalSamples
                 NumberOfVerticalSamples
条目内容:        AM_M_Neutral_* 的 Catch / Climb / Hurdle / Mantle / Vault 系列，约 29 条
```

要点：

- 翻越动作用蒙太奇，因为需要分段控制与事件；
- 用网格采样表达高度与深度这类连续参数；
- `BruteForce` 说明库小、精度优先。

## 5.4 特殊 Schema 的差异

| Schema | 关键差异 |
|---|---|
| `PSS_Default` | Group / Heading / Position / Trajectory / Velocity，pelvis + 双脚 |
| `PSS_Default_Mover` | Trajectory + Curve 通道（含 Phase、SampleTimeOffset），不采常规姿态骨骼 |
| `PSS_Traversal` | 使用自定义 BP 通道 `PSC_Traversal_Pos` / `PSC_Traversal_Head`，原点为 `attach`，`StripXY` |
| `PSS_CharacterInteraction` | 只用 Position 通道，含角色角色位 `Attacker` / `Victim`、`OriginRole` / `SampleRole` |
| `PSS_SmartObject` | 含自定义通道 `DistanceToSmartObject`，把「到目标的距离」变成匹配维度 |

最后两行值得注意：**Pose Search 的通道是可扩展的。** 当匹配需要环境或对象信息时，做法不是硬编码规则，而是新增一个特征通道，把该信息纳入代价计算。

## 5.5 分库决策清单

给自己项目分库时，按这四问决定：

```text
1. 语义是否互斥？
   蹲伏与站立、地面与空中 → 必须分库

2. 是否需要独立的进入规则？
   Pivot、Stop、Slide Exit → 分库便于配 Branch In / Block Transition

3. 特征是否不同？
   翻越、交互、Ragdoll 需要不同 Schema → 必须分库

4. 是否需要 LOD 替换？
   需要 → 建立密度层，并为每层配 Normalization Set
```

反过来，**不要**因为下面这些理由分库：

- 只是文件太多想整理（用文件夹即可）；
- 只是想让某条动画更容易被选中（这是 Bias 的职责）；
- 只是方向不同（同一族里加条目就行，除非要独立进入规则）。

---

# 第六部分：从零搭建的完整步骤

以下步骤适用于在自己工程中复刻 GASP 式 Motion Matching 主线。

## 步骤 1：准备动画与命名规范

```text
1. 确定风格族前缀（例如 M_Neutral_）
2. 确定命名结构：[风格]_[姿态]_[步态]_[动作]_[方向/起脚]
3. 至少覆盖：Idle、Walk/Run 八方向 Loop、Starts、Stops、Pivots、TurnInPlace
```

命名规范先定好，后面所有批量操作都依赖它。

## 步骤 2：烘焙必要曲线

```text
运行 Anim Modifier 烘焙根运动速度曲线（GASP 中为 MoveData_Speed）
```

没有这条曲线，Dynamic Play Rate 只能退化为 `1.0`。

## 步骤 3：建 Mirror Data Table（如需镜像）

```text
右键 → Animation → Mirror Data Table
配置左右骨骼命名规则
```

若像 GASP 一样采用 `UnmirroredOnly` + 独立左右资产，这一步可延后。

## 步骤 4：建 Schema

```text
右键 → Animation → Motion Matching → Pose Search Schema

Skeleton:            你的骨架
Sample Rate:         30
Pose Channel:        pelvis / foot_l / foot_r（Position + Velocity）
Trajectory Channel:  过去约 -0.3s，未来约 +0.4 ~ +0.7s
Heading:             按需启用
Component Stripping: StripZ（地面移动）
Data Preprocessor:   NormalizeWithCommonSchema
Mirror Data Table:   如有则指定
```

## 步骤 5：建 Normalization Set

```text
右键 → Animation → Motion Matching → Pose Search Normalization Set
把同一层的所有数据库加入同一个集合
```

跳过这一步，跨库比较的公平性无法保证。

## 步骤 6：按运动族建 Database

```text
右键 → Animation → Motion Matching → Pose Search Database

Schema:            步骤 4 的资产
Normalization Set: 步骤 5 的资产
加入动画条目，逐条设置 SamplingRange / MirrorOption
```

先建最小集合：`Stand_Idle`、`Stand_Run_Loops`、`Stand_Run_Starts`、`Stand_Run_Stops`、`Stand_Run_Pivots`。跑通再扩展。

## 步骤 7：给动画打 Pose Search Notify

```text
循环动画：      Branch In 全长
一次性动作：    Branch In 仅开头 0.15 ~ 0.25s
                Block Transition In 覆盖其余部分
起步 / 转身：   Override Continuing Pose Cost Bias 覆盖开头若干帧，负值
尾部废帧：      Exclude From Database
```

**每条 Branch In 都必须指定 Database，否则运行时报错且搜索直接失败。**

## 步骤 8：搭 AnimBP 数据采集层

```text
1. 定义中间结构体（角色属性）
2. 在 BlueprintThreadSafeUpdateAnimation 中填充
3. 派生 Speed2D / Gait / Stance / MovementDirection / MovementMode / RotationMode
```

## 步骤 9：加 Trajectory 与 Pose History

```text
1. 放置 Pose History 节点，命名固定（例如 PoseHistory）
2. 生成轨迹（历史 + 预测）
3. 确认它们在 MM 求值之前更新
```

## 步骤 10：建 Chooser Table 选数据库

```text
右键 → Miscellaneous → Chooser Table

上下文:  步骤 8 的结构体
列:      Stance（Enum）
         MovementMode（Enum）
         Gait（Enum 或 Multi Enum）
         Speed2D（Float Range，按需）
行:      每行输出一组 Database
顺序:    特例在上，兜底在下
```

## 步骤 11：接 Motion Matching 节点

```text
Chooser 输出的 Database 集合 → Motion Matching 节点
配置 Pose History 名称
按需设置 PoseJumpThresholdTime / PoseReselectHistory
```

跑起来，先只验证一件事：**站立奔跑时能不能选到正确的方向 Loop。**

## 步骤 12：加后处理

```text
Orientation Warping → Stride Warping → Steering
→ Foot Placement → Offset Root Bone → Aim Offset / Additive Lean
```

## 步骤 13：接 Dynamic Play Rate

```text
在 Blend Stack per-sample 图中：
PlayRate = Clamp(Speed2D / GetCurveValue(根运动速度曲线), Min, Max)
```

## 步骤 14：加 LOD 分层（可选）

```text
1. 复制一份精简数据库层
2. 为该层建独立 Normalization Set
3. 增加一张 Chooser 表或一列，按距离 / 平台切换
```

---

# 第七部分：调试

## 7.1 搜索完全失败

结果形如：

```text
Selected Anim = None
Selected Time = 0
Search Cost   = 3.4028235e38   （FLT_MAX）
```

这表示**没有任何候选进入比较**，不是「候选太贵」。按顺序检查：

1. 动画是否有 `Motion Matched Branch In`；
2. 该 Notify 是否为区间而非零长度；
3. Notify 的 **Database 是否为空**（GASP 之外最常见的错误，日志会报 `improperly setup ... with null Database`）；
4. 动画是否真的在该 Database 中被索引；
5. Schema 的 Skeleton 是否与动画一致；
6. Pose History 名称是否匹配、是否在更新路径上；
7. Schema 的采样窗口是否超出 Pose History 能提供的范围。

先看 Output Log，过滤 `LogPoseSearch`，多数情况直接给出原因。

## 7.2 选中了但表现错

优先用 Rewind Debugger，而不是猜：

```text
Rewind Debugger
├── Pose Search 轨道      候选列表、各自 Cost、Cost Breakdown
├── Blend Weights 轨道    当前栈里有哪些动画、权重变化
├── Chooser Evaluation    本帧求值了几次、命中哪些表
├── Notifies              Branch In、Block Transition、事件触发点
├── Inertializations      是否发生惯性化混合
└── Object Properties     变量历史值
```

判读要点：

- **同一帧多次 Chooser 求值** → 状态或触发逻辑重复进入；
- **Blend Weight 连续但画面跳** → 很可能是同一动画内相位跳变，而非切换动画；
- **Cost Breakdown 中 Trajectory 占比过高** → 会为追轨迹牺牲姿态连续性，表现为错脚、抖动；
- **Pose 占比过高** → 顺但不跟手。

## 7.3 常见症状对照

| 症状 | 首选处理 |
|---|---|
| 每帧换动画、抽搐 | 提高 Pose 权重；`ContinuingPoseCostBias` 更负 |
| 该切不切、迟钝 | 提高 Trajectory 权重；减弱 continuing 折扣 |
| 同一动画内相位瞬移 | 用 `Block Transition In` 封住中后段 |
| 错脚、脚滑 | 提高双脚速度权重；检查 Play Rate 曲线是否存在 |
| 转身方向错 | 提高 Heading 权重；增加未来轨迹采样 |
| 某条动画永不被选 | 先确认已索引，再考虑 `BaseCostBias` |
| 某条动画霸屏 | 把过量负 Bias 调回，而不是给别的加正值 |

## 7.4 成本认知

Motion Matching 的搜索本身很便宜：几千个候选、几十维特征，是连续内存上的加权平方距离，可 SIMD 化，且工作线程执行。典型量级远低于骨骼解压与多层混合。

真正推高开销的是：

- 候选池无限制（Branch In 全库全长铺满）；
- Schema 维度膨胀（采太多骨骼、太多采样时刻）；
- 大量角色同时全速搜索（需要 LOD、节流、URO）。

GASP 的分库与密度层，本质就是在控制第一项与第三项。

---

# 第八部分：复刻时的取舍建议

1. **先做主线，不要先做实验性状态机方案。** 主线 Chooser + MM 才是通用工作流。
2. **Chooser 第一层用来选数据库，不是选动画。** 这一层想清楚，后面表就不会膨胀。
3. **Schema 尽量小。** 三根骨骼 + 轨迹能覆盖绝大多数 locomotion 需求。
4. **一开始就建 Normalization Set。** 后补会让已调好的数值失效。
5. **Notify 是结构工具，Bias 是偏好工具。** 不要互相替代。
6. **动画层与移动层解耦。** 全部输入走中间结构体，将来换 CMC 或 Mover 只重写采集函数。
7. **每次只加一个变量。** 分库、加列、调权重、加 Bias 分开做，否则无法归因。

---

# 参考

- [Motion Matching in Unreal Engine](https://dev.epicgames.com/documentation/unreal-engine/motion-matching-in-unreal-engine)
- [Motion Matching Debugging](https://dev.epicgames.com/documentation/unreal-engine/motion-matching-debugging-in-unreal-engine)
- [Pose Warping in Unreal Engine](https://dev.epicgames.com/documentation/unreal-engine/pose-warping-in-unreal-engine)
- [PoseSearch Plugin API](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/PoseSearch)
- [Game Animation Sample Project](https://dev.epicgames.com/documentation/unreal-engine/game-animation-sample-project-in-unreal-engine)
- [Download the latest Game Animation Sample Project（UE 5.8）](https://www.unrealengine.com/tech-blog/download-the-latest-game-animation-sample-project-now-updated-for-ue-5-8)
