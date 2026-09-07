---
layout: post
title: GASP 5.8 Motion Matching 全流程拆解（二）
subtitle: 动画蓝图的变量、函数与节点绑定
author: KivenWu
header-style: text
tags:
  - UE5
  - Animation
  - Motion Matching
  - Pose Search
  - AnimBP
  - GASP
---

# 这篇讲什么

[上一篇](/2026/09/07/gasp-motion-matching-animbp-chooser-database/)讲的是**结构**：资产怎么分层、Chooser 怎么选库、Database 怎么切。

这一篇讲**实现**：打开 `ABP_MasterMM`，里面那几十个变量和函数各自是干什么的、谁调谁、绑到哪个节点上。

全部截图来自 `ABP_MasterMM` 及其父级/子图。文中给出的数值都是资产里的实际值，不是推荐值。

---

# 第一部分：先建立心智模型

## 1.1 三条链

动画蓝图里的东西看起来很散，其实只有三条链，任何一个函数都属于其中之一：

```text
① 数据链（Event Graph，每帧一次，线程安全）
   角色 ──接口──► CharacterProperties ──► 派生变量（Velocity / Speed2D / Gait / ...）

② 求值链（Motion Matching 节点的回调）
   OnUpdate ──► Chooser ──► SetDatabasesToSearch
   OnStateUpdated ──► 读回搜索结果 ──► CurrentDatabaseTags

③ 姿态链（AnimGraph，逐节点）
   PoseHistory ─► MM/BlendStack ─► Warping ─► Steering ─► OffsetRootBone
   ─► FootPlacement ─► LegIK ─► Lean ─► AimOffset ─► Output
```

**三条链之间只通过变量通信。** 数据链写变量，姿态链上的节点通过 Property Access 读变量。没有任何一个 AnimGraph 节点直接去访问角色。

## 1.2 命名规律

看懂前缀就省一半力气：

| 前缀 | 含义 | 何时执行 | 例子 |
|---|---|---|---|
| `Update_` / `Update` | 有副作用，写变量 | Event Graph 每帧 / MM 回调 | `UpdateEssentialValues`、`Update_PoseSearch` |
| `Get_` | 纯函数，供节点 Property Access 绑定 | 节点求值时 | `Get_LeanAmount`、`Get_OffsetRootTranslationMode` |
| `Is` / `Has` / `Enable` | 纯布尔判定 | 被上面两类调用 | `IsMoving`、`HasVelocity`、`Enable_AO` |
| `xxxLastFrame` | 变量，上一帧快照 | — | `VelocityLastFrame` |

**`Get_` 开头且标了 `Thread Safe` 的函数，全都是被 AnimGraph 节点的引脚绑定调用的**，不出现在任何执行流里。这是 GASP 里最容易看漏的一点：你在 Event Graph 里搜不到它们的调用者。

---

# 第二部分：数据入口

## 2.1 唯一的入口函数

[![](/img/in-post/gasp-abp/01-update-properties-from-character.png)](/img/in-post/gasp-abp/01-update-properties-from-character.png)
<small class="img-hint">UpdatePropertiesFromCharacter：整个 AnimBP 与外部世界的唯一接触面</small>

```text
UpdatePropertiesFromCharacter
  GetOwningActor  ──►  GetPropertiesForAnimation（BPI_PlayerData 接口）
                       └──► SET CharacterProperties
```

三个设计决策叠在这一个小函数里：

**① 走接口，不走 Cast。** `BPI_PlayerData` 是蓝图接口。AnimBP 不需要知道对方是 CMC 角色、Mover 角色还是一个 NPC —— 只要实现了接口就能驱动同一套动画。这就是同一个 `ABP_MasterMM` 能同时服务 CMC 和 Mover 两套移动方案的原因。

**② 一次性拉整个结构体。** 不是拉 15 次单个属性，是一次拿走全部。这样只需要一次跨对象访问，而且拿到的 15 个字段**天然是同一帧的快照**，不会出现速度是这一帧、加速度是上一帧的撕裂。

**③ 之后所有读取都在自己家里。** 后续函数读的都是 `CharacterProperties.xxx`，是本 AnimInstance 的成员变量，因此可以标 `Thread Safe`，可以放进 Worker Thread。

## 2.2 CharacterProperties 里有什么

[![](/img/in-post/gasp-abp/19-character-properties-struct.png)](/img/in-post/gasp-abp/19-character-properties-struct.png)
<small class="img-hint">Break 出来的完整字段列表</small>

```text
CharacterProperties
├── InputState                 输入状态
├── ActorTransform             角色世界变换
├── Velocity                   当前速度
├── InputAcceleration          输入加速度（不是物理加速度）
├── CurrentMaxAcceleration     当前最大加速度
├── CurrentMaxDeceleration     当前最大减速度
├── OrientationIntent          朝向意图
├── AimingRotation             瞄准旋转
├── GroundLocation             地面点
├── BasedMovementDelta         基座移动增量（站在移动平台上）
├── MovementMode               EMovementMode
├── Stance                     EStance
├── RotationMode               ERotationMode
├── Gait                       EGait
└── MovementDirection          EMovementDirection
```

分成三类看：

| 类别 | 字段 | 用途 |
|---|---|---|
| **连续量** | Velocity / InputAcceleration / ActorTransform / GroundLocation / AimingRotation / BasedMovementDelta | 喂 Trajectory、算派生量、驱动 Warping 和 AO |
| **上限量** | CurrentMaxAcceleration / CurrentMaxDeceleration | 做**归一化**用 —— 把绝对加速度变成 0~1 |
| **离散枚举** | MovementMode / Stance / RotationMode / Gait / MovementDirection | 喂 Chooser 选库 |

**上限量的存在是关键。** 有了 `CurrentMaxAcceleration`，`AccelerationAmount` 才能是 0~1 的归一化值 —— 换个移动参数不同的角色，动画表现不会跟着变。这是「让动画层与移动参数解耦」的标准做法。

---

# 第三部分：每帧主干

## 3.1 三步走

[![](/img/in-post/gasp-abp/02-update-chain.png)](/img/in-post/gasp-abp/02-update-chain.png)
<small class="img-hint">BlueprintThreadSafeUpdateAnimation 里的主链：顺序不能换</small>

```text
UpdateTrajectory ──► UpdateEssentialValues ──► UpdateState
```

顺序有依赖，不是随便排的：

- `UpdateTrajectory` 要用到上一帧算好的 `Speed2D` 来选生成参数
- `UpdateEssentialValues` 算出的 `Speed2D`、`Acceleration` 被 `UpdateState` 的 `IsMoving()` 用
- `UpdateState` 产出的枚举被本帧稍后的 Chooser 用

## 3.2 UpdateTrajectory

[![](/img/in-post/gasp-abp/03-update-trajectory.png)](/img/in-post/gasp-abp/03-update-trajectory.png)
<small class="img-hint">Idle / Moving 两套生成参数 + Pose Search Generate Trajectory</small>

```text
Select（Index = Speed2D > 0.0）
  False ──► TrajectoryGenerationData_Idle
  True  ──► TrajectoryGenerationData_Moving
                    │
                    ▼
Pose Search Generate Trajectory (for Character)
  In Anim Instance                     GetOwningComponent.GetAnimInstance（Pre-Event Graph）
  In Trajectory Data                   ← Select 结果
  In Delta Time                        GetDeltaSeconds（Thread Safe）
  In Out Trajectory                    ← Trajectory（读写同一个变量）
  In Out Desired Controller Yaw Last Update ← PreviousDesiredControllerYawLastUpdate
  In History Sampling Interval         -1.0
  In Trajectory History Count          30
  In Prediction Sampling Interval      0.1
  In Trajectory Prediction Count       15
```

**四个数值参数是整套 MM 精度的地基，逐个说：**

`History Sampling Interval = -1.0`
负值表示「用每帧的实际间隔」，不做重采样。历史轨迹就是逐帧记录，最忠实。

`Trajectory History Count = 30`
保留 30 帧历史。60fps 下约 0.5 秒。这个长度必须 **≥ Schema 里历史采样点的最远时间**，否则查询时取不到数据。上一篇提到的 `PSS_Default` 采样窗口就是被这个数框住的。

`Prediction Sampling Interval = 0.1`
未来轨迹每 0.1 秒一个点。

`Trajectory Prediction Count = 15`
15 个点 × 0.1 秒 = **未来 1.5 秒**。同理，必须 ≥ Schema 里最远的未来采样时间。

> **一条实用规则**：Schema 采样时间的取值范围必须完全落在 `[-HistoryCount×帧时长, PredictionCount×PredictionInterval]` 之内。超出去不会报错，只会静默拿到边界值 —— 表现为「明明配了 1.0 秒预测点，但 0.8 秒之后的匹配全是一个样」。

**`In Out Trajectory` 是读写同引脚。** 轨迹是**增量维护**的：每帧把新的一帧推进历史、重算未来，而不是从头生成。所以这个变量不能在别处随意覆盖。

**`PreviousDesiredControllerYawLastUpdate`** 同理，是给轨迹生成器算「玩家这一帧转了多少视角」用的状态载体，读写同一个变量。

## 3.3 三段速度采样

[![](/img/in-post/gasp-abp/04-trajectory-velocities.png)](/img/in-post/gasp-abp/04-trajectory-velocities.png)
<small class="img-hint">从同一条轨迹上取过去 / 现在 / 未来三个速度</small>

```text
SET Trajectory                                        ← 生成结果
SET TrjPastVelocity    = GetTrajectoryVelocity(Trajectory, -0.3, -0.2)
SET TrjCurrentVelocity = GetTrajectoryVelocity(Trajectory,  0.0,  0.2)
SET TrjFutureVelocity  = GetTrajectoryVelocity(Trajectory,  0.4,  0.5)
                                                      Extrapolate = false
```

每个都是**区间平均**而不是单点采样，`(-0.3, -0.2)` 是取这 0.1 秒窗口内的平均速度。区间平均自带低通滤波，避免单帧抖动被放大成状态跳变。

三段的语义：

| 变量 | 窗口 | 回答什么问题 |
|---|---|---|
| `TrjPastVelocity` | −0.3 ~ −0.2 s | 我刚才在干什么 |
| `TrjCurrentVelocity` | 0.0 ~ 0.2 s | 我现在在干什么 |
| `TrjFutureVelocity` | 0.4 ~ 0.5 s | 我马上要干什么 |

**`TrjFutureVelocity` 是整套系统的「预判器」。** 判断起步、判断 Pivot、判断急停，靠的都是它和当前速度的差 —— 玩家松手的那一帧，`Velocity` 还很大，但 `TrjFutureVelocity` 已经掉下去了。

**这就是 MM 能提前起播停止动画的原理**，不是玄学预测，是轨迹生成器已经按当前输入外推出了未来。

注意 `Extrapolate = false`：不允许外推到轨迹范围之外。0.5 秒在 1.5 秒预测范围内，安全。

## 3.4 UpdateEssentialValues

这个函数用 Sequence 分成几组并行的赋值，逐组看。

### 组一：变换与根变换

[![](/img/in-post/gasp-abp/05-character-transform.png)](/img/in-post/gasp-abp/05-character-transform.png)
<small class="img-hint">先存旧值，再写新值 —— 贯穿整个 AnimBP 的固定套路</small>

```text
SET CharacterTransformLastFrame = CharacterTransform    ← 先存旧
SET CharacterTransform          = CharacterProperties.ActorTransform   ← 再写新
```

[![](/img/in-post/gasp-abp/06-root-transform.png)](/img/in-post/gasp-abp/06-root-transform.png)
<small class="img-hint">RootTransform：从 Offset Root Bone 节点回读，并补偿 +90° Yaw</small>

```text
GetOffsetRootTransform(OffsetRoot 节点引用)
  → Location / Roll / Pitch / Yaw
  → MakeTransform(Location, Roll, Pitch, Yaw + 90.0, Scale=1)
  → SET RootTransform
```

两个要点：

**① 这是一次「从 AnimGraph 回读到 Event Graph」。** `OffsetRoot` 是一个 Anim Node Reference，指向 AnimGraph 里的 Offset Root Bone 节点。姿态链的运行结果被读回来，供数据链下一步使用。这打破了「数据链 → 姿态链」的单向流，是全图为数不多的反向依赖之一。

**② `+90.0` 是网格体朝向补偿。** UE 的骨骼网格默认朝 −Y，Actor 朝 +X，两者差 90°。所有涉及「把世界空间量转到角色本地空间」的地方都要处理这个偏移。后面 `Get_DesiredFacing` 里的 `-90.0` 是同一件事的反向。

> 复刻时这是最常见的错误来源：**转身动画方向反了、Warping 把人拧了 90°，九成是这个偏移漏了或者符号反了。**

### 组二：加速度

[![](/img/in-post/gasp-abp/07-acceleration.png)](/img/in-post/gasp-abp/07-acceleration.png)
<small class="img-hint">归一化加速度：Amount 是 0~1，与角色移动参数无关</small>

```text
SET AccelerationLastFrame = Acceleration
SET Acceleration          = CharacterProperties.InputAcceleration
SET AccelerationAmount    = SafeDivide( VectorLength(Acceleration),
                                        CharacterProperties.CurrentMaxAcceleration )
SET HasAcceleration       = AccelerationAmount > 0.0
```

`SafeDivide` 而不是 `/`：`CurrentMaxAcceleration` 在某些移动模式下可能是 0，直接除会产生 NaN，而 NaN 一旦进入 pose search 的代价计算就会污染整个搜索结果（表现为随机选中错误动画，且没有任何报错）。

### 组三：速度

[![](/img/in-post/gasp-abp/08-velocity.png)](/img/in-post/gasp-abp/08-velocity.png)
<small class="img-hint">Speed2D 只取 XY —— 竖直速度不参与移动判定</small>

```text
SET VelocityLastFrame = Velocity
SET Velocity          = CharacterProperties.Velocity
SET Speed2D           = VectorLengthXY(Velocity)
SET HasVelocity       = Speed2D > 5.0
```

`VectorLengthXY` 对应上一篇 Schema 里的 `ComponentStripping = StripZ`：**移动判定和姿态匹配都不看 Z**，两边保持一致。否则下落时 Speed2D 暴涨，会被误判成高速移动。

`> 5.0` 而不是 `> 0.0`：死区。物理速度几乎不会精确归零，5 单位/秒的死区避免站着不动时 `HasVelocity` 反复横跳，进而导致 Chooser 反复换库。

### 组四：派生量

[![](/img/in-post/gasp-abp/09-velocity-acceleration.png)](/img/in-post/gasp-abp/09-velocity-acceleration.png)
<small class="img-hint">真实加速度、本地空间加速度、最后的非零速度</small>

```text
SET VelocityAcceleration = (Velocity - VelocityLastFrame) / MAX(DeltaSeconds, 0.001)
SET RelativeAcceleration = UnrotateVector(VelocityAcceleration, RootTransform.Rotation)

Branch(HasVelocity)
  True ──► SET LastNonZeroVelocity = Velocity
```

三个都很重要：

**`VelocityAcceleration`** 是**真实**加速度（速度的时间导数），区别于 `Acceleration`（玩家**输入**的加速度）。撞墙时输入加速度还是满的，但真实加速度是反向的。做碰撞、急停反馈要用这个。

`MAX(DeltaSeconds, 0.001)` 防止暂停或第一帧时除零。

**`RelativeAcceleration`** 把加速度转到角色本地空间。`UnrotateVector` 是「世界 → 本地」。转完之后 Y 分量就是「侧向加速度」—— 这正是 `Get_LeanAmount` 需要的量。

**`LastNonZeroVelocity`** 是**朝向的记忆**。停下的那一刻速度归零，但角色不能立刻失去朝向信息，否则 Orientation Warping 会瞬间归位造成扭动。所以只在有速度时更新，停下后保持最后一个有效方向。它直接喂给 Orientation Warping 的 `LocomotionDirection`（见 4.2 节）。

## 3.5 UpdateState

[![](/img/in-post/gasp-abp/11-update-state.png)](/img/in-post/gasp-abp/11-update-state.png)
<small class="img-hint">Sequence 分五路，每路都是「存旧值 → 写新值」</small>

[![](/img/in-post/gasp-abp/10-state-movement-rotation-mode.png)](/img/in-post/gasp-abp/10-state-movement-rotation-mode.png)
<small class="img-hint">MovementMode / RotationMode 走的是同一个模板</small>

```text
Then 0:  MovementStateLastFrame = MovementState
         MovementState = IsMoving() ? Moving : Idle       ← 唯一一个自己算的

Then 1:  GaitLastFrame  = Gait
         Gait  = CharacterProperties.Gait                 ← 以下都是直接搬运

Then 2:  StanceLastFrame = Stance
         Stance = CharacterProperties.Stance

Then 3:  MovementModeLastFrame = MovementMode
         MovementMode = CharacterProperties.MovementMode

Then 4:  RotationModeLastFrame = RotationMode
         RotationMode = CharacterProperties.RotationMode
```

**注意 `MovementState` 是唯一一个 AnimBP 自己算的状态。** 其余四个都是从角色搬过来的。

为什么？因为「算不算在移动」是个**动画视角的判断**，不是移动系统的判断。移动系统认为速度 3 单位/秒就是在移动；动画系统认为那还是站着。把这个阈值放在 AnimBP 里，调手感时不用动 gameplay 代码。

## 3.6 专题：LastFrame 双份模式

全图出现了 **7 组** `xxx` / `xxxLastFrame` 配对：

```text
CharacterTransform / CharacterTransformLastFrame
Acceleration       / AccelerationLastFrame
Velocity           / VelocityLastFrame
MovementState      / MovementStateLastFrame
Gait               / GaitLastFrame
Stance             / StanceLastFrame
MovementMode       / MovementModeLastFrame
RotationMode       / RotationModeLastFrame
```

统一写法：**先存旧，再写新**。

它解决的是同一类问题：**边沿检测**。

```text
连续量：  差分         VelocityAcceleration = (V - V_last) / dt
离散量：  变化检测      if (Gait != GaitLastFrame) → 刚换了步态
```

离散枚举的 `LastFrame` 是给「进入/离开某状态的那一帧」用的 —— 起播特定动画、重置计时器、触发一次性逻辑。状态机方案里这类判断由状态转移天然提供；**MM 方案没有状态机，就必须自己维护这份快照**。

> 复刻建议：这个模式很容易漏掉某一组，导致某个边沿检测永远不触发。建议把这批赋值全部集中在 `UpdateState` 一处，不要散落在各个函数里。

---

# 第四部分：Motion Matching 节点与它的四个绑定

## 4.1 节点本体

[![](/img/in-post/gasp-abp/32-motion-matching-node.png)](/img/in-post/gasp-abp/32-motion-matching-node.png)
<small class="img-hint">整个系统的心脏：两个属性绑定 + 两个事件回调</small>

```text
Motion Matching 节点
├── Notify Recency Time Out  ← Get_MMNotifyRecencyTimeOut   （Thread Safe 绑定）
├── Blend Time               ← Get_MMBlendTime              （Thread Safe 绑定）
├── On Update                → Update_PoseSearch
└── On Motion Matching State Updated → Update_MotionMatchingPoseSelection
```

**两个属性用绑定而不是常量**，意味着它们每帧都可能变。**两个事件是整个 Chooser ↔ MM 协作的挂载点。**

## 4.2 Notify Recency Time Out

[![](/img/in-post/gasp-abp/28-mm-notify-recency.png)](/img/in-post/gasp-abp/28-mm-notify-recency.png)
<small class="img-hint">按 Gait 分档：0.2 / 0.2 / 0.16</small>

```text
Select（Index = Gait）
  Option 0 → 0.2      Walk
  Option 1 → 0.2      Run
  Option 2 → 0.16     Sprint
```

这个参数控制「`Motion Matched Branch In` 通知的有效期」：一个候选姿态被通知标记后，多久之内还算「可跳入」。

**为什么 Sprint 要更短？** 冲刺时步频高，同样 0.2 秒跨越的动作幅度更大。有效期不缩短，就会允许跳到一个相位已经差得较远的姿态上，表现为脚步错乱。

0.2 → 0.16 是 20% 的收紧，跟步频的提升幅度大致对应。**这是一个「按运动强度缩放时间窗」的通用思路**，不只适用于这一个参数。

> `Get_MMBlendTime` 没有截图，但从命名和绑定方式看是同类做法 —— 按状态返回不同的混合时长（一般是 Idle 长、高速短）。

## 4.3 On Update → Update_PoseSearch

[![](/img/in-post/gasp-abp/17-update-posesearch.png)](/img/in-post/gasp-abp/17-update-posesearch.png)
<small class="img-hint">上一篇讲的「Chooser 选库」，落到代码就是这五个节点</small>

```text
Update_PoseSearch(Context, Node)
  ├─ Evaluate Chooser: ABP_Chooser
  │     输入:  ABP_MMUE4_C ← Self
  │     输出:  ChooserPlayerSettings
  │            Result（数组）
  ├─ Convert to Motion Matching Node(Node) → MotionMatchingNode
  └─ Set Databases to Search
        Motion Matching Node ← 上一步
        Databases            ← Chooser 的 Result
        Interrupt Mode       ← Interrupt on Database Change
```

**这是上一篇整篇文章的落地点。** Chooser 的输出直接就是一组 Database，交给 MM 去搜。

三个细节：

**① `Self` 作为 Chooser 的输入对象。** Chooser 表里的每一列都是通过属性绑定去读这个对象上的变量 —— 也就是我们在第三部分辛苦维护的那些 `Gait` / `Stance` / `MovementMode` / `MovementState`。**数据链的全部意义就是为了这一刻。**

**② `Interrupt on Database Change` 是最关键的一个下拉框。**

| 选项 | 行为 | 后果 |
|---|---|---|
| Do Not Interrupt | 换库了也等当前动画走完 | 响应迟钝，但绝对稳 |
| **Interrupt on Database Change** | **只在库集合变化时打断重搜** | **变则响应，不变则连续** |
| Force Interrupt | 每帧都强制重搜 | 极度跟手，但抖 |

选中间档的含义是：**只要 Chooser 的输出没变，MM 就享受完整的 continuing pose 优待**（上一篇讲的 `ContinuingPoseCostBias` 折扣）；一旦状态切换导致换库，立刻打断重搜。

这一个设置同时解决了「响应」和「稳定」，是整套方案里性价比最高的一处配置。

**③ `ChooserPlayerSettings` 是第二路输出。** Chooser 不只吐数据库，还能吐一个设置结构体。上一篇提到的 OutputStruct 列类型就是干这个的 —— 让「选库」和「选参数」在同一次求值里完成，保证两者一致。

## 4.4 On State Updated → Update_MotionMatchingPoseSelection

[![](/img/in-post/gasp-abp/18-update-mm-pose-selection.png)](/img/in-post/gasp-abp/18-update-mm-pose-selection.png)
<small class="img-hint">搜索结果回读，并转成全局可用的 Tag</small>

```text
Update_MotionMatchingPoseSelection(Context, Node)
  Convert to Motion Matching Node(Node)
    └─ Get Motion Matching Search Result
         ├── Result Selected Anim         → SET CurrentSelectedAnim
         ├── Result Selected Time
         ├── Result Is Continuing Pose Search
         ├── Result Wanted Play Rate
         ├── Result Loop
         ├── Result Is Mirrored
         ├── Result Blend Parameters
         ├── Result Selected Database     → SET CurrentSelectedDatabase
         │                                  └─ Get Database Tags → SET CurrentDatabaseTags
         └── Result Search Cost
```

九个输出，蓝图里只接了两个（Anim 和 Database）。**其余七个是调试和扩展的入口**，尤其是：

- `Result Search Cost` —— 上一篇讲的 `FLT_MAX` 排查，就是把它打出来看
- `Result Is Continuing Pose Search` —— 判断这一帧是「继续播」还是「换了姿态」，做切换统计
- `Result Wanted Play Rate` —— MM 建议的播放速率，可以和 Dynamic Play Rate 交叉验证

## 4.5 专题：CurrentDatabaseTags 是全图的反馈总线

`CurrentDatabaseTags` 值得单独讲，因为它是这套架构里**最巧妙也最容易被忽略**的设计。

它的来源是：MM 选中了哪个 Database → 那个 Database 上挂了什么 GameplayTag。

它的去处遍布整个 AnimGraph：

```text
CurrentDatabaseTags
  ├── CONTAINS "TurnInPlace" ──► 切换 Steering 的 ProceduralTargetTime（4.7 节）
  ├── CONTAINS "Stops"       ──► 切换 Foot Placement 的插值设置（5.5 节）
  └── （可扩展：任意后处理节点的开关与参数）
```

**这形成了一个反馈环：**

```text
状态变量 ──► Chooser ──► 选中 Database ──► MM 搜索
                                              │
                              Database 的 Tag ┘
                                    │
                                    ▼
                          后处理节点的参数与开关
```

意义在于：**后处理层不需要重新判断「现在在干什么」，直接问「MM 现在在放哪一类动画」就够了。**

对比一下如果没有这个机制：Foot Placement 想知道「是不是在急停」，就得自己再写一遍 `Speed2D 下降 && TrjFutureVelocity 接近零 && ...` 的判断 —— 而且这份判断和 Chooser 里的那份很可能不一致，产生「Chooser 认为在急停、Foot Placement 认为不在」的撕裂。

用 Tag 之后，**判断只做一次，结果全局共享**，且天然与实际播放的动画一致。

> 复刻要点：给 Database 打 Tag 几乎零成本，但要**提前规划 Tag 命名空间**。建议按「运动族」而不是按「状态」打 —— `Stops` / `Pivots` / `TurnInPlace` / `Starts`，与上一篇讲的 Database 切分维度对齐。

---

# 第五部分：姿态链上的节点与绑定函数

按 AnimGraph 的实际顺序走。

## 5.1 Pose History

[![](/img/in-post/gasp-abp/37-pose-history-node.png)](/img/in-post/gasp-abp/37-pose-history-node.png)
<small class="img-hint">最简单的节点，也是 MM 能工作的前提</small>

```text
Pose History（节点标签 PoseHistory）
  Trajectory ← Trajectory（Thread Safe 绑定）
```

只有一个引脚，但**没有它 MM 就完全无法工作** —— 查询向量里的「历史姿态」部分全部来自这里。

节点标签 `PoseHistory` 要和 Schema 里配置的名称一致，这是上一篇 `FLT_MAX` 七步排查里的第 6 步。

## 5.2 Blend Stack 内部：Orientation Warping

[![](/img/in-post/gasp-abp/12-blendstack-orientation-warping.png)](/img/in-post/gasp-abp/12-blendstack-orientation-warping.png)
<small class="img-hint">AnimationBlendStackGraph_0：Warping 在 Blend Stack 的每个样本内部执行</small>

```text
Blend Stack Input → Local To Component → Orientation Warping
                                            Alpha                 ← 见下
                                            Target Time            0.0
                                            Locomotion Direction   ← LastNonZeroVelocity
                                            Current Anim Asset     ← GetCurrentBlendStackAnimAsset(Node)
                                            Current Anim Asset Time← GetCurrentBlendStackAnimAssetTime(Node)
                                            Warping Space          ← Get_OrientationWarpingWarpingSpace
```

**这张图信息量很大，逐条说：**

**① 位置：在 Blend Stack 的 per-sample 图里，不在主 AnimGraph 里。**

意味着 Warping 是**对栈里每一个动画样本分别做**的，而不是对混合后的结果做。这是正确的做法 —— 混合后再 Warp，两个方向不同的动画会先被平均成一个错误的中间方向，再被整体拧过去，结果是「转身时脚打滑」。

**② Alpha 由动画曲线控制：**

```text
GetCurrentBlendStackAnimAsset(Node)
  → Cast To AnimSequence
  → Get Curve Value from Animation
       Curve Name = "Enable_Warping"
       Time       = GetCurrentBlendStackAnimAssetTime(Node)
  → Alpha
```

**这是「动画资产反向控制蓝图逻辑」的典型手法。** 每个动画自己在时间轴上烘一条 `Enable_Warping` 曲线，声明「我这一段允许被拧多少」。

为什么需要？因为不是所有动画都能被 Warp：

| 动画类型 | Enable_Warping | 原因 |
|---|---|---|
| 循环跑步 | 1.0 | 方向随便调，看不出来 |
| 急停 | 前段 1.0，后段渐降到 0 | 脚已经踩定了，再拧就滑步 |
| 原地转身 | 0.0 | 动画本身就是转向，再 Warp 会双重旋转 |
| 起步 | 从 0 渐升 | 第一步的脚位是设计好的 |

**权限放在美术手里，而不是在蓝图里写一长串 if。** 加一个新动画，不用改任何蓝图。

**③ `Locomotion Direction ← LastNonZeroVelocity`** —— 用「最后的非零速度」而不是「当前速度」。停下的瞬间速度归零，若用当前速度，Warping 目标方向会瞬间失效导致角色扭一下。这就是 3.4 节维护 `LastNonZeroVelocity` 的唯一目的。

**④ Warping Space 也是绑定的：**

[![](/img/in-post/gasp-abp/30-orientation-warping-space.png)](/img/in-post/gasp-abp/30-orientation-warping-space.png)
<small class="img-hint">开了 Offset Root Bone 就以根骨为参考系，否则用组件</small>

```text
Get_OrientationWarpingWarpingSpace
  = OffsetRootBoneEnable ? RootBoneTransform : ComponentTransform
```

因为 Offset Root Bone 会让根骨与组件产生偏差。开启时如果 Warping 还以组件为参考，两个系统就会互相打架 —— 一个把人往左偏，另一个以为人没偏又往左偏一次。

## 5.3 Steering ×2

**GASP 用了两个 Steering 节点，参数完全不同。** 这是理解 TurnInPlace 的钥匙。

### 第一个：常规转向

[![](/img/in-post/gasp-abp/13-steering-main.png)](/img/in-post/gasp-abp/13-steering-main.png)
<small class="img-hint">Procedural Target Time = 0.2 —— 程序化转向为主</small>

```text
Reset Root Transform (Alpha 1.0)
  → Steering
      Enabled                  ← EnableSteering(MMBlendStackInput)
      Target Orientation       ← Get_DesiredFacing
      Mirrored                 false
      Procedural Target Time   0.2
      Animated Target Time     2.0
      Current Anim Asset       ← GetCurrentBlendStackAnimAsset
      Current Anim Asset Time  ← GetCurrentBlendStackAnimAssetTime
```

### 第二个：原地转身专用

[![](/img/in-post/gasp-abp/14-steering-turninplace.png)](/img/in-post/gasp-abp/14-steering-turninplace.png)
<small class="img-hint">Procedural Target Time = 100000.0 —— 等于关掉程序化转向</small>

```text
Steering
  Enabled                ← CurrentDatabaseTags CONTAINS "TurnInPlace"
  Procedural Target Time 100000.0        ← 注意这个数
  Animated Target Time   2.0
  → Component To Local → Output Pose
```

**`100000.0` 不是笔误，是一种惯用法。**

Steering 节点的两个 Target Time 决定了「程序化旋转」和「动画自带旋转」的分工：

- `Procedural Target Time` 小 → 程序化旋转快速补足差额
- 设成 100000 秒 → 程序化部分**慢到等于不存在**

于是在 TurnInPlace 时，**转身完全由动画自己的 root motion 完成**，程序化只做极慢的兜底修正。这正是原地转身该有的样子 —— 转身动画的脚步是精心设计的，程序化去插一脚就会滑步。

**串联而非二选一：** 两个节点是先后串在链上的，各自有独立的 `Enabled`。常规状态下第一个生效；进入 TurnInPlace 数据库时第二个也生效并主导。

### 谁提供目标朝向

[![](/img/in-post/gasp-abp/15-get-desired-facing.png)](/img/in-post/gasp-abp/15-get-desired-facing.png)
<small class="img-hint">两代方案的分岔口</small>

```text
Get_DesiredFacing
  Select（Index = UseExperimentalStateMachine）
    False ──► GetTrajectorySampleAtTime(Trajectory, 0.5)
              → Break Transform Trajectory Sample → Facing
    True  ──► CombineRotators(TargetRotation, (0, 0, -90))
```

**两代方案在这里正面分岔：**

| 分支 | 朝向来源 | 特点 |
|---|---|---|
| MM 主线（False） | **0.5 秒后的轨迹朝向** | 朝向来自轨迹预测，与移动意图天然一致 |
| 实验状态机（True） | 显式变量 `TargetRotation` | 朝向由状态机逻辑显式指定 |

MM 分支不需要「目标朝向」这个概念 —— 轨迹里已经包含了。这体现了上一篇讲的两代方案哲学差异：**MM 用连续量表达意图，状态机用离散状态表达意图。**

`-90.0` 又出现了，还是网格体朝向补偿（3.4 节的 `+90` 是反向操作）。

### 什么时候允许转向

[![](/img/in-post/gasp-abp/16-enable-steering.png)](/img/in-post/gasp-abp/16-enable-steering.png)
<small class="img-hint">两个条件，缺一不可</small>

```text
EnableSteering(Node)
  = ( MovementState == Moving  OR  MovementMode == InAir )
    AND
    GetCurrentBlendStackAnimIsActive(Node)
```

**第一个括号**：站着不动时不转向（原地转身交给第二个 Steering 节点），空中允许转向（滞空调整落点朝向）。

**第二个条件是容易漏的**：`GetCurrentBlendStackAnimIsActive` 检查栈顶动画是否还处于活跃状态。如果混合栈正在过渡、栈顶动画已经淡出，就不该继续以它为基准做转向 —— 否则会以一个即将消失的动画的朝向为准，转到一半又跳回去。

## 5.4 Offset Root Bone

[![](/img/in-post/gasp-abp/35-offset-root-bone-node.png)](/img/in-post/gasp-abp/35-offset-root-bone-node.png)
<small class="img-hint">五个引脚，四个绑函数 —— 全图绑定密度最高的节点</small>

```text
Offset Root Bone（节点标签 OffsetRoot）
  Translation Mode              ← Get_OffsetRootTranslationMode
  Rotation Mode                 ← Get_OffsetRootRotationMode
  Translation Halflife          ← Get_OffsetRootTranslationHalfLife
  Max Translation Error         ← Get_OffsetRootTranslationRadius
  Clamp To Translation Velocity ← IsMoving
```

这个节点解决的是「胶囊体和视觉网格允许分离多少」。分离量大 → 动画更自然（脚不滑）；分离量小 → 碰撞更准（不穿墙）。四个绑定就是在动态调节这个取舍。

### Rotation Mode

[![](/img/in-post/gasp-abp/22-offsetroot-rotation-mode.png)](/img/in-post/gasp-abp/22-offsetroot-rotation-mode.png)
<small class="img-hint">播蒙太奇时立刻归位</small>

```text
Get_OffsetRootRotationMode
  = IsSlotActive("DefaultSlot") ? Release : Accumulate
```

`Accumulate` 允许根骨旋转持续偏离；`Release` 主动收敛回胶囊体。

**只要 DefaultSlot 上有蒙太奇在播，立刻切 Release。** 因为蒙太奇（技能、交互、受击）通常有精确的朝向要求，不能让根骨还挂着一个历史累计的偏移。

### Translation Mode

[![](/img/in-post/gasp-abp/23-offsetroot-translation-mode.png)](/img/in-post/gasp-abp/23-offsetroot-translation-mode.png)
<small class="img-hint">三层判断：Slot → MovementMode → IsMoving</small>

```text
Get_OffsetRootTranslationMode
  IsSlotActive("DefaultSlot") ──► Release
  否则 Switch on EMovementMode:
    On Ground ──► IsMoving() ? Interpolate : Release
    In Air    ──► Release
    Sliding   ──► （按同样思路配置）
```

只有**站在地上且正在移动**时才用 `Interpolate`（允许平滑偏移）。其余情况一律 `Release`：

- 空中：没有脚步需要防滑，偏移只会让落地位置看起来不对
- 地面静止：站着不动却有位移偏移，视觉上就是「人和碰撞体分家」

### 两个数值参数

[![](/img/in-post/gasp-abp/24-offsetroot-halflife.png)](/img/in-post/gasp-abp/24-offsetroot-halflife.png)
<small class="img-hint">Idle 快速归位，Moving 慢速跟随</small>

```text
Get_OffsetRootTranslationHalfLife
  Idle   → 0.1     快速收敛
  Moving → 0.3     慢速跟随
```

半衰期 = 偏移量衰减一半所需时间。Idle 时 0.1 秒是「赶紧回来」；Moving 时 0.3 秒是「慢慢跟，别打断步态」。

[![](/img/in-post/gasp-abp/25-offsetroot-radius.png)](/img/in-post/gasp-abp/25-offsetroot-radius.png)
<small class="img-hint">最大偏移半径直接读变量，方便运行时调</small>

```text
Get_OffsetRootTranslationRadius = OffsetRootTranslationRadius（变量直通）
```

写成函数而不是直接绑变量，是为了留扩展位 —— 以后想按 Gait 或 Stance 分档，改函数即可，不用动 AnimGraph。**这是一个值得学的小习惯。**

### Clamp To Translation Velocity

绑 `IsMoving`。移动时限制偏移的变化速度不超过实际移动速度，防止「网格体自己往前窜」。静止时不限制，允许快速归位。

## 5.5 Foot Placement + Leg IK

[![](/img/in-post/gasp-abp/36-foot-placement-legik.png)](/img/in-post/gasp-abp/36-foot-placement-legik.png)
<small class="img-hint">Remap Curves → Local To Component → Foot Placement → Leg IK</small>

```text
Remap Curves → Local To Component → Foot Placement → Leg IK
                                      Alpha 1.0        Alpha 1.0
                                      Plant Settings         ← Get_FootPlacementPlantSettings
                                      Interpolation Settings ← Get_FootPlacementInterpolationSettings
```

`Local To Component` 是必须的 —— Foot Placement 和 Leg IK 都在组件空间工作。

[![](/img/in-post/gasp-abp/31-footplacement-interp-settings.png)](/img/in-post/gasp-abp/31-footplacement-interp-settings.png)
<small class="img-hint">又一次用 CurrentDatabaseTags 做决策</small>

```text
Get_FootPlacementInterpolationSettings
  = CurrentDatabaseTags CONTAINS "Stops"
      ? InterpolationSettings_Stops
      : InterpolationSettings_Default
```

**急停时脚部 IK 需要更「硬」的插值** —— 脚一旦踩定就不能再飘，否则观感是刹车没刹住。其余情况用较软的插值，避免地形起伏时脚步僵硬。

再次印证 4.5 节的结论：**后处理层不自己判断状态，只读 Tag。**

## 5.6 Additive Lean

[![](/img/in-post/gasp-abp/33-additive-lean.png)](/img/in-post/gasp-abp/33-additive-lean.png)
<small class="img-hint">1D 加法混合空间，只在移动时启用</small>

```text
Blendspace Player（BS1D_Additive_Lean）
  X ← Get_LeanAmount.X
  → Apply Mesh Space Additive
      Enabled ← IsMoving
```

[![](/img/in-post/gasp-abp/29-get-lean-amount.png)](/img/in-post/gasp-abp/29-get-lean-amount.png)
<small class="img-hint">侧向加速度 × 速度缩放</small>

```text
Get_LeanAmount
  X = CalculateRelativeAccelerationAmount().Y
      × MapRangeClamped(Speed2D, 165→375, 0.5→1.0)
  Y = 0.0
```

拆成两个因子：

**方向与强度** = `RelativeAcceleration` 的 Y 分量（本地空间侧向加速度）。左转为负、右转为正，转得越急数值越大。3.4 节的 `UnrotateVector` 就是为它服务的。

**速度缩放** = 慢速时 ×0.5，375 单位/秒以上 ×1.0。**同样的转向输入，走路只倾斜一半，冲刺才倾斜到底。** 符合物理直觉（离心力与速度平方相关），也避免走路时倾斜过头显得滑稽。

`Y = 0.0` 表示不做前后倾斜。加减速时的前倾后仰交给动画本身表现，不用程序化叠加。

> 顺带一提：这套「一个 signed float 同时编码方向和强度，再按速度缩放」的模式非常通用。做贴墙倾斜、载具侧倾、受击摇摆都是同一个套路。

## 5.7 Aim Offset

[![](/img/in-post/gasp-abp/34-aim-offset.png)](/img/in-post/gasp-abp/34-aim-offset.png)
<small class="img-hint">Blend Poses by bool + Dead Blending：非对称混合时长</small>

```text
BS_Neutral_AO_Stand（Blendspace Player）
  Yaw   ← Get_AOValue.X
  Pitch ← Get_AOValue.Y
        │
        ▼
Blend Poses by bool
  True Pose        ← 上面的 AO 姿态
  False Pose       ← Additive Identity Pose
  True Blend Time  0.75
  False Blend Time 1.5
  Active Value     ← Enable_AO
        │
        ▼
Dead Blending → Apply Mesh Space Additive (Alpha 1.0)
```

**`0.75` 进 / `1.5` 出 是刻意的非对称设计**：抬枪要快（0.75 秒），放下要慢（1.5 秒）。快进慢出在所有「叠加表演」上都适用 —— 快进保证响应，慢出避免闪烁。

（这和上一篇提到的 LocoDev 避障系统用 `Increase 4 / Decrease 1` 是同一个思路。）

**用 `Blend Poses by bool` + `Additive Identity Pose` 而不是直接调 Alpha**，好处是关闭时走的是完整的姿态混合路径，可以享受 `Dead Blending` 的惯性化处理，不会有突变。

### AO 的三个函数

[![](/img/in-post/gasp-abp/19-character-properties-struct.png)](/img/in-post/gasp-abp/19-character-properties-struct.png)
<small class="img-hint">Get_AOValue：瞄准旋转与根骨朝向的差，再被曲线关掉</small>

```text
Get_AOValue
  Delta(Rotator)( CharacterProperties.AimingRotation, RootTransform.Rotation )
    → (Roll, Pitch, Yaw)
  Lerp(Vector)
    A = (Yaw, Pitch, 0)
    B = (0, 0, 0)
    Alpha ← GetCurveValue("Disable_AO")
  → Return Value X = 横向偏差
    Return Value Y = 纵向偏差
```

「瞄准方向」与「根骨朝向」的差就是 AO 需要补的角度。注意参考系是 `RootTransform` 而不是 Actor —— 因为 Offset Root Bone 之后，视觉根骨才是身体的真实朝向。

`Lerp` 到零、Alpha 由 `Disable_AO` 曲线驱动 —— **又一次「动画自己声明能力」**。翻越、受击、交互这类动画在时间轴上把 `Disable_AO` 拉到 1，AO 就自动归零，不会出现「翻墙翻到一半上半身还在瞄准」的鬼畜画面。

[![](/img/in-post/gasp-abp/20-get-ao-yaw.png)](/img/in-post/gasp-abp/20-get-ao-yaw.png)
<small class="img-hint">只有 Strafe 模式才有横向 AO</small>

```text
Get_Ao_Yaw
  Select（Index = RotationMode）
    Orient to Movement → 0.0
    Strafe             → Get_AOValue.X
    Aim                → 0.0
```

**两个 0 的理由完全不同：**

- `OrientToMovement`：身体总是朝着移动方向，没有「瞄准」概念，AO 无意义
- `Aim`：身体已经被强制转向瞄准方向，差值本来就该是 0，不需要再叠加

**只有 `Strafe` 是「身体朝一个方向、眼睛看另一个方向」，才需要 AO。**

[![](/img/in-post/gasp-abp/21-enable-ao.png)](/img/in-post/gasp-abp/21-enable-ao.png)
<small class="img-hint">三个条件与门</small>

```text
Enable_AO
  =  ABS(Get_AOValue.X) <= Select(MovementState: Idle→115.0, Moving→180.0)
  AND RotationMode == Strafe
  AND GetSlotLocalWeight("DefaultSlot") < 0.5
```

三个条件各管一件事：

**① 角度上限，按状态分档。**

| 状态 | 上限 | 理由 |
|---|---|---|
| Idle | 115° | 站着扭超过 115° 是反人体的，应该改为原地转身 |
| Moving | 180° | 移动时身体在动，可以接受更大的扭转 |

超限直接关掉 AO，而不是钳制到上限 —— 钳制会停在一个僵硬的极限姿势，关掉则回到自然姿态，由转身逻辑接手。

**② 只在 Strafe 模式启用**，与 `Get_Ao_Yaw` 的逻辑呼应。

**③ `GetSlotLocalWeight("DefaultSlot") < 0.5`** —— 蒙太奇权重过半时关掉 AO。用**权重**而不是 `IsSlotActive` 布尔值，因此在蒙太奇淡入过程中就会平滑关闭，而不是等它完全生效才突然关掉。

> 对比一下 5.4 节的 Offset Root Bone 用的是 `IsSlotActive`（布尔）。**同一个 Slot，两个节点用了不同粒度的查询** —— 根骨需要立刻响应，AO 需要平滑过渡。这个区分很讲究。

---

# 第六部分：辅助判定与查询函数

## 6.1 IsMoving

[![](/img/in-post/gasp-abp/26-is-moving.png)](/img/in-post/gasp-abp/26-is-moving.png)
<small class="img-hint">三个「不等于零」的容差比较</small>

```text
IsMoving
  = Velocity          ≠ (0,0,0)  容差 0.1
  AND
    Acceleration      ≠ (0,0,0)  容差 0.0
  （图中另有 TrjFutureVelocity ≠ (0,0,0) 容差 10.0 的比较，
    引脚走线在截图角度下辨认不清，实际接线以工程为准）
```

**关键是三个不同的容差：**

| 量 | 容差 | 为什么 |
|---|---|---|
| `Velocity` | 0.1 | 物理速度有数值噪声，需要小死区 |
| `TrjFutureVelocity` | 10.0 | 预测量本身噪声大，死区必须大得多 |
| `Acceleration` | 0.0 | 输入是玩家给的，要么有要么没有，不需要死区 |

**给每个量单独设容差，而不是统一一个数** —— 这是让状态判定不抖的关键细节。用同一个容差，要么输入不灵敏，要么预测值把状态抖飞。

**同时要求「有速度」和「有输入」** 的效果：松开摇杆后，虽然还在滑行（有速度），但 `IsMoving` 立刻变 false → `MovementState` 变 Idle → Chooser 换到停止相关的库。**这就是急停能提前起播的机制。**

## 6.2 IsStarting

[![](/img/in-post/gasp-abp/27-is-starting.png)](/img/in-post/gasp-abp/27-is-starting.png)
<small class="img-hint">未来速度显著高于当前速度 = 正在起步</small>

```text
IsStarting
  = IsMoving()
  AND VectorLengthXY(TrjFutureVelocity) >= VectorLengthXY(Velocity) + 100.0
```

**「未来会比现在快至少 100 单位/秒」= 正在加速起步。**

`+100` 这个绝对阈值避免了匀速时的误判 —— 匀速跑动时未来速度和当前速度基本相等，差值远小于 100。

这是 3.3 节 `TrjFutureVelocity` 价值的最直接体现：**不需要状态机，不需要记录「上一帧是不是站着」，一个比较就判出了起步。**

## 6.3 Blend Stack 查询三件套

前面反复出现、但一直没单独讲的三个函数：

```text
GetCurrentBlendStackAnimAsset(Node)      → 栈顶正在播的 AnimSequence
GetCurrentBlendStackAnimAssetTime(Node)  → 它当前播到第几秒
GetCurrentBlendStackAnimIsActive(Node)   → 它是否仍然活跃（没被淡出取代）
```

三个都要求传入 `MMBlendStackInput`（Anim Node Reference）。出现的位置：

| 调用点 | 用到哪个 | 目的 |
|---|---|---|
| Orientation Warping（5.2） | Asset + Time | 采样该动画的 `Enable_Warping` 曲线 |
| Steering ×2（5.3） | Asset + Time | 计算动画自带 root motion 还能提供多少转向 |
| `EnableSteering`（5.3） | IsActive | 栈顶已淡出就别再以它为基准 |

**为什么后处理层需要知道「现在在播哪个动画、播到第几秒」？**

因为它们的行为要跟着**具体资产**走，而不是跟着状态走：

- Warping 要读那个动画自己声明的授权曲线
- Steering 要知道动画自带旋转还剩多少，才能决定程序化部分补多少

**这三个函数是 Blend Stack 与后处理层之间唯一的接口。** 没有它们，后处理只能对混合后的结果盲目动手 —— 而混合结果是好几个动画的加权平均，读不出任何一个动画的曲线。

同族的还有一个：

```text
Convert to Motion Matching Node(Node) → MotionMatchingNode
```

把泛型 Anim Node Reference 转成 Motion Matching 专用引用。`Update_PoseSearch` 和 `Update_MotionMatchingPoseSelection` 开头都要先做这一步，之后才能调 `Set Databases to Search` 和 `Get Motion Matching Search Result`。

## 6.4 Slot 查询二人组

| 函数 | 返回 | 用在 | 为什么用这个粒度 |
|---|---|---|---|
| `IsSlotActive("DefaultSlot")` | bool | Offset Root 的两个 Mode（5.4） | 根骨要**立刻**切模式，不需要过渡 |
| `GetSlotLocalWeight("DefaultSlot")` | float，与 0.5 比 | `Enable_AO`（5.7） | AO 要在蒙太奇**淡入过程中**就开始退场 |

同一个 Slot，两种粒度。

**选布尔还是选权重，取决于「这个响应需不需要过渡」。** 布尔是阶跃，蒙太奇一开始播就立刻生效；权重是连续量，可以在混合过程中提前介入。

这个区分在自己搭系统时很容易忽略 —— 一律用 `IsSlotActive` 会导致所有叠加层在蒙太奇起播那一帧同时突变。

## 6.5 两个数值防护函数

```text
SafeDivide(A, B)          用在 AccelerationAmount（3.4 组二）
MAX(DeltaSeconds, 0.001)  用在 VelocityAcceleration（3.4 组四）
```

两处都是除法保护，但值得再强调一次原因：

**AnimBP 里的 NaN 不会报错，只会静默污染。** 一个 NaN 进入 pose search 的代价计算，结果是所有候选的 Cost 都变成 NaN，比较全部失败，MM 随机选一个 —— 表现为「动画偶发性抽风」，而 Output Log 干干净净。

**凡是分母来自外部数据（角色属性、DeltaTime）的除法，一律加保护。** 这不是防御性编程过度，是这个环境里排查成本极高的一类 bug。

## 6.6 被绑定但没有截图的三个函数

以下三个在图里出现为绑定项或调用节点，但内部结构没有单独截图。这里给出**从命名、同族函数和数据依赖推断的形态**，实机需要打开确认。

### `Get_MMBlendTime`

绑在 Motion Matching 节点的 `Blend Time`（4.1）。

与 `Get_MMNotifyRecencyTimeOut` 是同一个绑定位置的邻居，极可能也是 `Select`：按 `Gait` 或 `MovementState` 分档，**低速长、高速短**。

理由与 4.2 节相同 —— 高速时同样的混合时长会跨越更大的动作幅度，混合痕迹更明显。

### `Get_FootPlacementPlantSettings`

绑在 Foot Placement 的 `Plant Settings`（5.5），与已截图的 `Get_FootPlacementInterpolationSettings` 是同一个节点上的兄弟引脚。

大概率同构：读 `CurrentDatabaseTags` 分档。`Stops` / `Pivots` 这类脚步需要「踩死」的动画用更强的 plant，循环移动用较松的。

### `CalculateRelativeAccelerationAmount`

被 `Get_LeanAmount` 调用（5.6），取其 `.Y` 分量。

从名字拆：`Relative`（本地空间）+ `Acceleration`（加速度）+ `Amount`（归一化量）。所以它做的是**把 `RelativeAcceleration` 归一化到 [-1, 1]**。

关键推断：**归一化的分母是分方向的。**

```text
加速方向 → 除以 CurrentMaxAcceleration
减速方向 → 除以 CurrentMaxDeceleration
```

**这解释了 `CharacterProperties` 里为什么会有 `CurrentMaxDeceleration` 这个乍看多余的字段**（2.2 节）—— 加速和减速的上限本来就不一样，用同一个分母归一化会导致刹车时的倾斜量算错。

如果只用一个上限，急刹车（减速度远大于加速度上限）会算出远超 1 的值，倾斜直接打满穿帮。

---

# 第七部分：总表

## 7.1 变量

| 类别 | 变量 |
|---|---|
| **数据源** | `CharacterProperties` |
| **变换** | `CharacterTransform` / `CharacterTransformLastFrame` / `RootTransform` |
| **速度** | `Velocity` / `VelocityLastFrame` / `Speed2D` / `HasVelocity` / `LastNonZeroVelocity` |
| **加速度** | `Acceleration` / `AccelerationLastFrame` / `AccelerationAmount` / `HasAcceleration` / `VelocityAcceleration` / `RelativeAcceleration` |
| **轨迹** | `Trajectory` / `TrjPastVelocity` / `TrjCurrentVelocity` / `TrjFutureVelocity` / `PreviousDesiredControllerYawLastUpdate` |
| **状态枚举** | `MovementState` / `Gait` / `Stance` / `MovementMode` / `RotationMode`（各带 `LastFrame`） |
| **MM 结果** | `CurrentSelectedAnim` / `CurrentSelectedDatabase` / `CurrentDatabaseTags` |
| **配置** | `OffsetRootBoneEnable` / `OffsetRootTranslationRadius` / `UseExperimentalStateMachine` / `InterpolationSettings_Default` / `InterpolationSettings_Stops` |
| **状态机分支专用** | `TargetRotation` |

## 7.2 函数

| 类别 | 函数 | 调用方 |
|---|---|---|
| **数据采集** | `UpdatePropertiesFromCharacter` | Event Graph |
| **每帧主干** | `UpdateTrajectory` / `UpdateEssentialValues` / `UpdateState` | Event Graph |
| **MM 回调** | `Update_PoseSearch` / `Update_MotionMatchingPoseSelection` | MM 节点事件 |
| **MM 参数** | `Get_MMNotifyRecencyTimeOut` / `Get_MMBlendTime` | MM 节点绑定 |
| **Steering** | `Get_DesiredFacing` / `EnableSteering` | Steering 节点绑定 |
| **Warping** | `Get_OrientationWarpingWarpingSpace` | Warping 节点绑定 |
| **Offset Root** | `Get_OffsetRootTranslationMode` / `Get_OffsetRootRotationMode` / `Get_OffsetRootTranslationHalfLife` / `Get_OffsetRootTranslationRadius` | Offset Root Bone 节点绑定 |
| **Foot Placement** | `Get_FootPlacementPlantSettings` / `Get_FootPlacementInterpolationSettings` | Foot Placement 节点绑定 |
| **Lean** | `Get_LeanAmount` / `CalculateRelativeAccelerationAmount` | Blendspace 绑定 |
| **Aim Offset** | `Get_AOValue` / `Get_Ao_Yaw` / `Enable_AO` | Blendspace / Blend 节点绑定 |
| **判定** | `IsMoving` / `IsStarting` | 被上面各类调用 |
| **Blend Stack 查询** | `GetCurrentBlendStackAnimAsset` / `...AnimAssetTime` / `...AnimIsActive` / `Convert to Motion Matching Node` | Warping / Steering / MM 回调 |
| **Slot 查询** | `IsSlotActive` / `GetSlotLocalWeight` | Offset Root / Enable_AO |
| **数值防护** | `SafeDivide` / `MAX` | UpdateEssentialValues |

---

# 第八部分：七条可复用的设计约定

**① 唯一入口 + 一次性快照。**
所有外部数据从一个接口函数一次性拉进一个结构体。之后全图只读自己的成员变量。这同时买到了三样东西：线程安全、帧内一致性、与角色类型解耦。

**② 归一化优先于绝对值。**
`AccelerationAmount` 而不是加速度本身，`Speed2D` 配合 `MapRangeClamped` 而不是裸速度。动画表现从此与角色移动参数解耦。

**③ 双份变量做边沿检测。**
没有状态机就必须自己维护 `LastFrame`。连续量用来差分，离散量用来检测变化。集中在一处赋值，不要散落。

**④ 每个阈值单独调，不要共用常量。**
`HasVelocity` 用 5.0、`IsMoving` 的速度容差 0.1、预测速度容差 10.0、输入容差 0.0、`IsStarting` 用 +100。**五个数字五个来源，没有一个是「统一的魔法数」。** 想省事共用一个，结果必然是某处不灵敏、某处抖动。

**⑤ 动画通过曲线声明自己的能力。**
`Enable_Warping`、`Disable_AO` —— 每个动画在时间轴上标注「我这段允许被程序化修改多少」。权限交给美术，加资产不用改蓝图。

**⑥ 用 Tag 做后处理层的决策，不要重复判断状态。**
`CurrentDatabaseTags` 把「MM 实际在放什么」广播给所有后处理节点。判断只做一次，且天然与实际播放内容一致。

**⑦ 快进慢出，且分级查询。**
AO 的 0.75/1.5、Offset Root 的 0.1/0.3 —— 加进来要快，撤出去要慢。同时注意查询粒度：需要立刻响应就查布尔（`IsSlotActive`），需要平滑过渡就查权重（`GetSlotLocalWeight`）。

---

# 第九部分：复刻检查清单

按依赖顺序，前面没做完不要做后面：

```text
□  1. 定义 CharacterProperties 结构体（15 字段：连续量 / 上限量 / 枚举）
□  2. 定义 BPI_PlayerData 接口，角色侧实现 GetPropertiesForAnimation
□  3. AnimBP 里写 UpdatePropertiesFromCharacter，确认标了 Thread Safe

□  4. UpdateTrajectory：两套 TrajectoryGenerationData + Generate Trajectory
□  5. 核对：History/Prediction 参数范围 ≥ Schema 采样时间范围
□  6. 三段 TrjXxxVelocity 采样
□  7. UpdateEssentialValues：变换 / 加速度 / 速度 / 派生量，注意 ±90° 补偿
□  8. UpdateState：五组枚举 + LastFrame

□  9. IsMoving / IsStarting，五个阈值各自调
□ 10. AnimGraph 放 Pose History，标签与 Schema 一致

□ 11. Motion Matching 节点 + Update_PoseSearch（Chooser → SetDatabasesToSearch）
□ 12. Interrupt Mode 选 Interrupt on Database Change
□ 13. Update_MotionMatchingPoseSelection → CurrentDatabaseTags
□ 14. 给 Database 打 Tag（Stops / Pivots / TurnInPlace / Starts）

□ 15. Blend Stack 内：Orientation Warping + Enable_Warping 曲线
□ 16. Steering ×2（常规 0.2 / TurnInPlace 100000）
□ 17. Offset Root Bone + 四个 Get_ 函数
□ 18. Foot Placement + Leg IK，插值设置读 Tag
□ 19. Additive Lean（RelativeAcceleration.Y × 速度缩放）
□ 20. Aim Offset（Get_AOValue / Get_Ao_Yaw / Enable_AO / 0.75 进 1.5 出）
```

**前 10 步是地基。** 第 11 步之前如果 `Trajectory` 或 `Pose History` 有任何问题，MM 一定返回 `FLT_MAX`，而且你会花大量时间去怀疑 Schema 和 Database —— 那是上一篇讲的七步排查里最常见的弯路。

---

# 相关阅读

- [GASP 5.8 Motion Matching 全流程拆解](/2026/09/07/gasp-motion-matching-animbp-chooser-database/) —— 资产分层、Chooser Table、Database 切分
- [UE5 Motion Matched Interaction 实践](/2026/09/07/ue5-motion-matched-interaction/)
