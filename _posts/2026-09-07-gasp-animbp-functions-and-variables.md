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

截图主要来自 `ABP_MasterMM` 及其父级/子图，少量来自 `SandboxCharacter_CMC_ABP`（判定函数散落在多个 ABP 里）。文中给出的数值都是资产里的实际值，不是推荐值。

引擎自带的函数注释（图上那些灰色文字块）我尽量原文引用了 —— 有几处它写明的理由和从图上推出来的不一样，那些地方单独标了出来。也有一处注释和实际接线不符（6.1 节），同样保留。

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
├── MovementDirection          EMovementDirection
├── JustLanded                 bool，落地那一帧由 C++ 置位
└── LandVelocity               Vector，落地瞬间的速度（用 Z 判轻重）
```

> 后两个字段在最初那张 Break 图里被折叠了，是从 `JustLanded_Light` / `JustLanded_Heavy`（7.6 节）的 Break 节点上补出来的。**Break 结构体节点默认会隐藏没连线的引脚**，所以从单张图推断结构体的完整字段并不可靠。

分成三类看：

| 类别 | 字段 | 用途 |
|---|---|---|
| **连续量** | Velocity / InputAcceleration / ActorTransform / GroundLocation / AimingRotation / BasedMovementDelta / LandVelocity | 喂 Trajectory、算派生量、驱动 Warping 和 AO |
| **上限量** | CurrentMaxAcceleration / CurrentMaxDeceleration | 做**归一化**用 —— 把绝对加速度变成 0~1 |
| **离散枚举** | MovementMode / Stance / RotationMode / Gait / MovementDirection | 喂 Chooser 选库 |
| **瞬时标志** | JustLanded | 只在事件发生那一帧为真 |

**上限量的存在是关键。** 有了 `CurrentMaxAcceleration`，`AccelerationAmount` 才能是 0~1 的归一化值 —— 换个移动参数不同的角色，动画表现不会跟着变。这是「让动画层与移动参数解耦」的标准做法。

`CurrentMaxDeceleration` 乍看是个冗余字段，直到 6.6 节 `CalculateRelativeAccelerationAmount` 才用上：**加速和刹车必须用各自的上限归一化**，共用一个分母会让刹车时的身体倾斜量算错。

**瞬时标志这一类只有一个成员，但它代表了一种蓝图侧算不出来的信息。** 「刚刚落地」是一个发生在物理帧的事件，动画蓝图只能看到 `MovementMode` 的前后差异，推不出撞击强度。**这类信息必须由 C++ 侧在事件发生时抓下来塞进结构体。**

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

**这套变量最终喂给了三个地方**，看完它们才能理解为什么值得维护这么一大堆冗余数据：

| 消费者 | 用法 | 章节 |
|---|---|---|
| `Get_MMInterruptMode` | 四组状态任一跳变 → 强制打断 MM 的连贯性偏好 | 4.6 |
| `Get_MMBlendTime` | `MovementMode` 从 InAir 变 OnGround → 缩短混合时长 | 6.6 |
| `ShouldTurnInPlace` | `MovementState` 从 Moving 变 Idle → 允许 Stick Flick 转身 | 7.3 |

三者的共同形状是 `当前 == A AND 上一帧 == B`，或者 `当前 != 上一帧`。**没有状态机，边沿就得靠这种笨办法造出来。**

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

第三个可变参数 `Interrupt Mode` 在 `Update_PoseSearch` 里作为 `Set Databases to Search` 的入参传入，不是节点上的绑定引脚 —— 见 4.6 节。

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

官方注释给的理由是同一件事的另一个说法（6.6 节末尾有补图）：这个窗口必须跟脚步声的间隔匹配，否则冲刺时相邻两声会被当成同一个 notify 去重掉。

`Get_MMBlendTime` 的分档轴则完全不同 —— 不按 Gait，按 `MovementMode` 的跳变。详见 6.6 节。

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

> 这张图里 `Interrupt Mode` 是写死的字面量。工程里另有一个 `Get_MMInterruptMode` 函数，把这个选择变成了每帧动态计算 —— **默认不打断，只在核心状态跳变的那一帧才打断**。那是比写死更进一步的做法，见 4.6 节。

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
  ├── CONTAINS "TurnInPlace" ──► 切换 Steering 的 ProceduralTargetTime（5.3 节）
  ├── CONTAINS "Stops"       ──► 切换 Foot Placement 的插值与 Plant 设置（5.5、6.6 节）
  ├── CONTAINS "Pivots"      ──► 否决 IsStarting（6.2 节）
  └── CONTAINS "Pivots"      ──► 否决 ShouldSpinTransition（7.4 节）
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

**两个方向的用法要分清：**

| 用法 | 例子 | 作用 |
|---|---|---|
| 调参数 | Foot Placement 的 Settings、Steering 的 TargetTime | 「在播这类动画时，后处理换一套参数」 |
| **做否决** | `IsStarting`、`ShouldSpinTransition` 里的 `NOT Contains(Pivots)` | 「在播这类动画时，禁止某个判定成立」 |

第二种是更硬的需求。它解决的是 7.7 节那个问题：**姿态相似的动作，纯数值判定必然区分不开**，只能靠"当前在播什么"来打破歧义。

## 4.6 Interrupt Mode：整套 LastFrame 变量的兑现点

[![](/img/in-post/gasp-abp/61-get-mm-interrupt-mode.png)](/img/in-post/gasp-abp/61-get-mm-interrupt-mode.png)
<small class="img-hint">四组「变没变」的比较，OR 到一起</small>

> This function controls the Interupt Mode of the motion matching node. This determines whether motion matching will force a blend into a new database if the selectable databases have changed, or wait until it finds a match that costs less than the currently playing animation. By default, we do not interrupt. However, whenever a core state has changed, we know we want to start playing a new animation, therefore force an interrupt. This prevents motion matching from sticking in the idle if the character has started moving, or staying in a cycle animation if the character wants to stop, which can happen based on the "continuing pose bias" tuning. Essentially, this keeps motion matching responsive to changes in core states.

```text
Get_MMInterruptMode
  anyCoreStateChanged =
        ( MovementState != MovementStateLastFrame )
     OR ( Gait    != GaitLastFrame    AND MovementState == Moving )
     OR ( MovementMode != MovementModeLastFrame )
     OR ( Stance  != StanceLastFrame  AND MovementMode  == OnGround )

  return anyCoreStateChanged ? Interrupt on Database Change
                             : Do Not Interrupt
```

**3.6 节讲的那一堆 `XxxLastFrame` 变量，最大的一个消费者就是这里。**

### 它在解决什么

Motion Matching 有个叫 **continuing pose bias** 的调参：给"继续播当前动画"一个代价折扣，防止每帧乱跳。这个折扣调得越狠，动画越连贯，但也越"粘"。

粘的后果是：**玩家已经开始跑了，MM 还赖在 idle 里** —— 因为继续播 idle 的折扣后代价，仍然低于切到跑步的代价。

Interrupt Mode 就是这个矛盾的出口：

| 模式 | 行为 |
|---|---|
| `Do Not Interrupt` | 等到真找到更便宜的匹配才切。连贯，但可能滞后 |
| `Interrupt on Database Change` | 库一变就强制混过去，不比代价 |

**默认不打断，只在核心状态发生跳变的那一帧打断。**

逻辑很直白：状态没变，说明玩家意图没变，让 MM 按代价慢慢选，优先连贯；状态变了，说明玩家做了个新决定，**这时候连贯性要给响应性让路**。

### 两个带门的条件

四项里有两项加了额外限制，这是细节所在：

```text
Gait   变了  →  还要求 MovementState == Moving
Stance 变了  →  还要求 MovementMode  == OnGround
```

**站着不动时切换走/跑档位，不该打断 idle。** Gait 是个"准备状态"，玩家可以站着预切成 Sprint 再起跑 —— 那一刻动画不该有任何反应。

**空中切换蹲/站，不该打断跳跃。** 同理，蹲伏姿态在空中没有意义，等落地再说。

**没有这两个门，会出现「站着按一下冲刺键，角色抖一下」这种典型 bug。** 状态确实变了，但那个变化在当前情境下不该产生动画反应。

这条经验可以推广：**「状态变了」不等于「该换动画了」，中间还差一个「这个变化在当前情境下有没有视觉意义」的判断。**

### 为什么必须是 LastFrame 而不是事件

这四项全部是 `当前值 != 上一帧值`。用委托或事件回调也能知道状态变了，但会碰到时序问题：**事件可能在这一帧的动画更新之前或之后到达**，而 MM 需要的是"就在这一帧，状态是不是刚变的"。

存一份上一帧的副本，在 `UpdateState` 里统一比较，**时序完全确定**，不依赖事件的到达顺序。这是 3.6 节那套看起来笨拙的双份变量真正的价值。

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

配套有一个取引用的函数：

[![](/img/in-post/gasp-abp/63-get-pose-history-reference.png)](/img/in-post/gasp-abp/63-get-pose-history-reference.png)
<small class="img-hint">和 MM 节点取引用是同一个套路</small>

```text
Get_PoseHistoryReference
  = Get Pose History Reference( Convert to Pose History Node(PoseHistory) )
```

**「先 Convert，再取 Reference」是引擎里访问 AnimNode 的固定两步。** `Convert to XXX Node` 把泛型 Anim Node Reference 转成具体类型（附带一个 `Result` 分支引脚用于失败处理），转完才能调该类型专属的接口。

`Update_PoseSearch` 里的 `Convert to Motion Matching Node` 是同一个模式。**看到 `Convert to ...` 就知道下面要访问某个 AnimNode 的内部状态了。**

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

[![](/img/in-post/gasp-abp/55-orientation-warping-space-doc.png)](/img/in-post/gasp-abp/55-orientation-warping-space-doc.png)
<small class="img-hint">开了 Offset Root Bone 就以根骨为参考系，否则用组件</small>

```text
Get_OrientationWarpingWarpingSpace
  = OffsetRootBoneEnabled ? RootBoneTransform : ComponentTransform
```

官方注释：

> Orientation Warping uses Offset Root Bone's root orientation as its warping space when it's enabled. When warping mode is in Component mode, we assume root bone is identity.

后半句是关键：**Component 模式下的前提假设是「根骨等于单位变换」。**

也就是说，两个分支不是"两种都行，选一个"，而是**同一个假设的两种成立方式**：要么根骨真的没偏（没开 Offset Root），要么就得显式告诉 Warping 根骨偏到哪了。

开了 Offset Root 却还用 Component 模式，等于是在一个已经不成立的假设上做计算 —— 两个系统会互相打架，一个把人往左偏，另一个以为人没偏又往左偏一次。

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

[![](/img/in-post/gasp-abp/51-offsetroot-rotation-mode-doc.png)](/img/in-post/gasp-abp/51-offsetroot-rotation-mode-doc.png)
<small class="img-hint">播蒙太奇时立刻归位</small>

```text
Get_OffsetRootRotationMode
  = IsSlotActive("DefaultSlot") ? Release : Accumulate
```

官方注释把两个枚举的语义说清楚了：

> The Release Enum essentially blends out any offset, after which it will be locked to the capsule rotation, just as it would be without a root offset node.
>
> The Accumulate Enum means the root will counter-rotate any changes to the capsule rotation, making it appear to rotate independently from the capsule, which allows root motion and steering to fully control its rotation.

**`Accumulate` 的机制值得注意：它是「反向抵消胶囊体的旋转变化」。**

不是"允许偏移增长"这么被动 —— 胶囊体每转一度，根骨就反向转一度，净效果是**根骨在世界空间里纹丝不动**。于是根骨的朝向完全交给 root motion 和 Steering 决定，胶囊体怎么转都不影响它。

`Release` 则是退化成"没有这个节点"的状态：偏移混掉，根骨锁死在胶囊体上。

**只要 DefaultSlot 上有蒙太奇在播，立刻切 Release。** 因为蒙太奇（技能、交互、受击）通常有精确的朝向要求，不能让根骨还挂着一个历史累计的偏移。

### Translation Mode

[![](/img/in-post/gasp-abp/52-offsetroot-translation-mode-doc.png)](/img/in-post/gasp-abp/52-offsetroot-translation-mode-doc.png)
<small class="img-hint">三层判断：Slot → MovementMode → IsMoving</small>

```text
Get_OffsetRootTranslationMode
  IsSlotActive("DefaultSlot") ──► Release
  否则 Switch on EMovementMode:
    On Ground  ──► IsMoving() ? Interpolate : Release
    In Air     ──► Release
    Sliding    ──► （未接线，走默认）
    Traversing ──► （未接线，走默认）
```

官方注释：

> The Interpolate Enum means the root is allowed to deviate slightly from the capsule location based on root motion, but will always try to interpolate back toward center. This is helpful when the animation data and capsule movement are not perfectly matched, such as during starts, pivots, and other complex movements.

**`Interpolate` 的定位说得很准：它是在给「动画位移和胶囊体位移对不上」这件事兜底。**

起步、转向这些动作，动画里的位移曲线不可能和 CMC 算出来的胶囊体位移完全一致。硬锁在一起就会脚滑，完全放开又会人和碰撞体分家。Interpolate 允许小幅偏离 + 持续往回收，是这两者之间的折中。

只有**站在地上且正在移动**时才用它。其余情况一律 `Release`：

- 空中：没有脚步需要防滑，偏移只会让落地位置看起来不对
- 地面静止：站着不动却有位移偏移，视觉上就是「人和碰撞体分家」

顺带确认 `EMovementMode` 枚举有四项：`On Ground` / `In Air` / `Sliding` / `Traversing`。后两项在这个函数里没接线。

### 两个数值参数

[![](/img/in-post/gasp-abp/53-offsetroot-halflife-doc.png)](/img/in-post/gasp-abp/53-offsetroot-halflife-doc.png)
<small class="img-hint">Idle 快速归位，Moving 慢速跟随</small>

```text
Get_OffsetRootTranslationHalfLife
  Idle   → 0.1     快速收敛
  Moving → 0.3     慢速跟随
```

> This function controls the speed at which the Root Offset node can interpolate the root bone's translation. When stopped, we want to interpolate very quickly, so that the stop always ends at the capsule's center, but when moving, we allow for slightly smoother interpolation.

半衰期 = 偏移量衰减一半所需时间。**Idle 那档的 0.1 有个明确目的：保证急停结束时根骨精确落在胶囊体中心。**

这很重要 —— 停下来是玩家会盯着看的时刻，如果人站定了却和碰撞体差着几厘米，后续任何以胶囊体为基准的逻辑（交互距离、瞄准射线）都会显得不对。移动中没人会注意这点偏差，所以可以放宽到 0.3 换取平滑。

[![](/img/in-post/gasp-abp/54-offsetroot-radius-doc.png)](/img/in-post/gasp-abp/54-offsetroot-radius-doc.png)
<small class="img-hint">最大偏移半径直接读变量</small>

```text
Get_OffsetRootTranslationRadius = OffsetRootTranslationRadius（变量直通）
```

> Set the Offset Root Node's "Max Translation Error" radius from a console variable. This makes it easy to tune while playing.

**这个变量的值来自控制台变量（CVar）。** 我之前猜它是"留扩展位"，实际理由更直接：**为了能在 PIE 运行中实时改。**

这类"需要边跑边调"的参数，做成 CVar 比暴露在 Details 面板里有用得多 —— 改 Details 要停下来重进，改 CVar 立刻生效。手感参数尤其吃这个，因为好不好只能靠反复试。

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

> 这张图省略了状态机分支。完整版（含 `BlendStackInputs.Tags` 那一路）和它的孪生函数 `Get_FootPlacementPlantSettings` 一起放在 6.6 节。

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

（`CalculateRelativeAccelerationAmount` 的完整实现见 6.6 节 —— 它分方向用不同的上限做归一化，这是 `CurrentMaxDeceleration` 唯一的用武之地。）

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

[![](/img/in-post/gasp-abp/38-is-moving-full.png)](/img/in-post/gasp-abp/38-is-moving-full.png)
<small class="img-hint">三个容差比较，但只有两个接进了 AND</small>

官方注释写的是设计意图：

> Look at the current and future velocities (determined by trajectory generation) to determine if the character is trying to move (future velocity is greater than 0), or trying to stop (future velocity is 0).

但**实际接线和注释不一致**，这点值得单独说：

```text
IsMoving
  = Velocity      ≠ (0,0,0)  容差 0.1
  AND  true                          ← 中间引脚是勾选的字面量
  AND  Acceleration ≠ (0,0,0)  容差 0.0
```

`TrjFutureVelocity ≠ (0,0,0) 容差 10.0` 这个比较节点**存在于图里，但输出引脚是空的**，没连进 AND。AND 的中间引脚被一个勾上的布尔字面量顶替了。

**所以未来速度这一路是被旁路掉的。** 注释描述的是原本的设计，节点留在图里作为「随时可以接回去」的开关。

这种「注释和接线不一致」在示例工程里很常见 —— **看图要看引脚，不要看注释。**

三个容差本身仍然值得看：

| 量 | 容差 | 为什么 |
|---|---|---|
| `Velocity` | 0.1 | 物理速度有数值噪声，需要小死区 |
| `TrjFutureVelocity` | 10.0 | 预测量本身噪声大，死区必须大得多（当前未启用） |
| `Acceleration` | 0.0 | 输入是玩家给的，要么有要么没有，不需要死区 |

**给每个量单独设容差，而不是统一一个数** —— 这是让状态判定不抖的关键细节。

**当前生效的语义是「有速度 且 有输入」**：松开摇杆后，虽然还在滑行（有速度），但 `Acceleration` 归零 → `IsMoving` 立刻 false → `MovementState` 变 Idle → Chooser 换到停止相关的库。**这就是急停能提前起播的机制**，而且它不依赖被旁路掉的那一路。

## 6.2 IsStarting

[![](/img/in-post/gasp-abp/39-is-starting-full.png)](/img/in-post/gasp-abp/39-is-starting-full.png)
<small class="img-hint">未来速度显著高于当前速度 = 正在起步，但 Pivot 期间一律否决</small>

```text
IsStarting
  = IsMoving()
  AND VectorLengthXY(TrjFutureVelocity) >= VectorLengthXY(Velocity) + 100.0
  AND NOT( CurrentDatabaseTags CONTAINS "Pivots" )
```

**「未来会比现在快至少 100 单位/秒」= 正在加速起步。**

`+100` 这个绝对阈值避免了匀速时的误判 —— 匀速跑动时未来速度和当前速度基本相等，差值远小于 100。

这是 3.3 节 `TrjFutureVelocity` 价值的最直接体现：**不需要状态机，不需要记录「上一帧是不是站着」，一个比较就判出了起步。**

### 第三个条件才是精髓

官方注释：

> If the current Database asset is a pivot database, this function will always return false. This prevents the Motion Matching system from interrupting a pivot, since the second half of a pivot is very similar to a start.

**Pivot 的后半段和 Start 在姿态上高度相似。**

如果不加这个否决，会发生：角色急转 → 进 Pivot 库 → 转到一半，速度开始回升，`IsStarting` 判定成立 → Chooser 切到 Start 库 → **Pivot 被自己「转完之后的样子」打断，永远转不完**。

这是 4.5 节 `CurrentDatabaseTags` 反馈总线的又一个用例，而且是最典型的一类：**用「我现在在播什么」否决一个本来会成立的判定，防止自我打断。**

姿态相似的两个动作，光靠数值条件区分不开，必须靠「当前在播哪个库」这个额外信息。

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

## 6.6 三个补上截图的函数

这三个之前只在绑定位置露过面。补图之后，其中两个印证了推断，一个推断错了 —— 错的那个更有意思。

### `CalculateRelativeAccelerationAmount`（推断成立）

[![](/img/in-post/gasp-abp/56-calc-rel-accel-1.png)](/img/in-post/gasp-abp/56-calc-rel-accel-1.png)
<small class="img-hint">先做除零保护，再用 dot 判断在加速还是在减速</small>

[![](/img/in-post/gasp-abp/57-calc-rel-accel-2.png)](/img/in-post/gasp-abp/57-calc-rel-accel-2.png)
<small class="img-hint">两条分支结构相同，只差归一化分母</small>

官方注释：

> This function calculates the character's Relative Acceleration Amount. This value represents the current amount of acceleration or deceleration relative to the actor rotation. It is normalized to a range of -1 to 1 so that -1 equals the Max Braking Deceleration, and 1 equals the Max Acceleration of the Character Movement Component.

```text
if CurrentMaxAcceleration > 0 AND CurrentMaxDeceleration > 0:
    if dot(Acceleration, Velocity) > 0:          ← 同向 = 在加速
        UnrotateVector(
          ClampVectorSizeMax(VelocityAcceleration, CurrentMaxAcceleration)
            / CurrentMaxAcceleration,
          CharacterTransform.Rotation )
    else:                                        ← 反向 = 在刹车
        UnrotateVector(
          ClampVectorSizeMax(VelocityAcceleration, CurrentMaxDeceleration)
            / CurrentMaxDeceleration,
          CharacterTransform.Rotation )
```

**分方向用不同分母，这一点推断对了。** `CurrentMaxDeceleration` 这个字段的存在理由确认：加速上限和刹车上限本来就不是一个数，共用分母会让刹车时的倾斜量算错。

三个之前没料到的细节：

**一、判断加速/减速用的是 `dot(Acceleration, Velocity)`，不是加速度符号。** 点积同向为正 = 加速度和速度一个方向 = 在加速。这个判据在任意朝向下都成立，不需要先转到本地空间。

**二、输入是 `VelocityAcceleration`（3.4 组四那个手算的），不是 CMC 给的 `Acceleration`。** 也就是说，倾斜跟的是**速度的实际变化率**，而不是玩家的输入意图。撞墙时输入还在推、速度已经归零，倾斜会正确地反映"没在加速"。

**三、先 `ClampVectorSizeMax` 再除。** 这保证结果绝对落在 [-1, 1]，哪怕某帧的实际加速度超过了配置上限（碰撞、外力）。除完再 clamp 也能达到目的，但先 clamp 少一次越界中间值。

最后 `UnrotateVector` 转到角色本地空间 —— 这才是 `Relative` 的含义。

### `Get_FootPlacementPlantSettings`（推断成立）

[![](/img/in-post/gasp-abp/58-footplacement-plant-settings.png)](/img/in-post/gasp-abp/58-footplacement-plant-settings.png)
<small class="img-hint">和 InterpolationSettings 完全同构</small>

```text
isStops = Select( Index = UseExperimentalStateMachine,
                  False = CurrentDatabaseTags CONTAINS "Stops",
                  True  = BlendStackInputs.Tags CONTAINS "Stop" )

return Select( Index = isStops,
               False = PlantSettings_Default,
               True  = PlantSettings_Stops )
```

同一节点上的 `Get_FootPlacementInterpolationSettings` 是逐节点对应的双胞胎：

[![](/img/in-post/gasp-abp/59-footplacement-interp-settings-full.png)](/img/in-post/gasp-abp/59-footplacement-interp-settings-full.png)
<small class="img-hint">换掉两个 Settings 变量，其余一模一样</small>

**「读 CurrentDatabaseTags 分档」推断对了，但漏了一层：MM 路径和状态机路径读的是不同来源。**

| 路径 | 读哪里 | 匹配的 tag |
|---|---|---|
| Motion Matching | `CurrentDatabaseTags` | `Stops` |
| 实验状态机 | `BlendStackInputs.Tags` | `Stop` |

两条路径拿"当前在播什么"的方式完全不同 —— MM 从选中的数据库拿，状态机从 Blend Stack 的输入结构拿。函数把这个差异吞掉了，对外只暴露一个 Settings。

**这是 4.5 节反馈总线的完整形态**：`CurrentDatabaseTags` 只是 MM 路径的那一半，状态机路径有自己的等价物 `BlendStackInputs.Tags`。凡是要"知道当前在播什么"的地方，都会看到这对 Select 组合。

顺带确认了 `S Blend Stack Inputs` 结构含 `Blend Curve` 和 `Tags` 两个字段。

### `Get_MMBlendTime`（推断错了）

[![](/img/in-post/gasp-abp/60-get-mm-blend-time.png)](/img/in-post/gasp-abp/60-get-mm-blend-time.png)
<small class="img-hint">分档轴不是 Gait，是 MovementMode 的跳变</small>

我之前推断它「按 Gait 分档，低速长高速短」，理由是它和 `Get_MMNotifyRecencyTimeOut` 挂在同一个节点上。实际结构完全不同：

```text
Switch on MovementMode:
  OnGround:
      Switch on MovementModeLastFrame:
          InAir → 0.2      ← 刚落地
          其他  → 0.5
  InAir:
      Velocity.Z > 100.0 ? 0.15   ← 刚起跳
                         : 0.5
```

官方注释：

> This function is used to change the blend time of the Motion Matching node, based on the current and previous states. In the future, we plan to allow blend times to be more directly set from the chosen databases.

图上还有两条分区注释，直接写明了两个特例：落地（`0.2`）和起跳（`0.15`）。

**分档轴不是「跑多快」，是「有没有刚发生状态跳变」。**

我推断错的原因是类比错了对象。`NotifyRecencyTimeOut` 按 Gait 分档，是因为它管的是**脚步声的疏密**，那确实是速度的函数。而 Blend Time 管的是**混合时长**，它要解决的问题不是"动作幅度大小"，而是：

**落地和起跳这两个瞬间，动画必须立刻到位，否则观感上会"飘"。** 0.5 秒的混合放在落地上，角色会像踩进棉花里。

注意两个特例都是**边沿**：

- 落地 = `MovementMode == OnGround` 且 `LastFrame == InAir`
- 起跳 = `MovementMode == InAir` 且 `Velocity.Z > 100`（上升中）

第一个是标准的 LastFrame 边沿检测（3.6 节）。第二个换了个思路 —— 用**速度符号**代替历史比较，因为"在空中且在上升"本身就足以区分起跳和下落，不需要额外记一帧。

**这一节的教训比结论有用：同一个绑定位置的邻居函数，分档逻辑不一定同构。** 要看这个参数控制的是什么物理量，而不是看它的邻居怎么写。

### 顺带：`Get_MMNotifyRecencyTimeOut` 的官方理由

[![](/img/in-post/gasp-abp/62-mm-notify-recency-doc.png)](/img/in-post/gasp-abp/62-mm-notify-recency-doc.png)
<small class="img-hint">Walk 0.2 / Run 0.2 / Sprint 0.16</small>

4.2 节讲过数值，这次补图带了注释：

> The notify recency time out needs to be a larger value that the time between each footstep sfx for each gait otherwise notifies will get filtered out.

（原文 `that` 应为 `than`。）观察到的事实是 Sprint 取 `0.16`，比 Walk/Run 的 `0.2` 小 —— 冲刺时两次脚步的间隔更短，**这个窗口必须跟着缩短，否则相邻两声脚步会被当成同一个 notify 去重掉，冲刺时就会漏音。**

---

# 第七部分：事件判定函数族

前面六部分覆盖的是**每帧都在算的连续量**。这一部分是另一类东西：**判断"某件事是不是正在发生"的布尔函数**。

它们不参与主干更新，全部由 Chooser 或状态机转移条件调用，用来决定"该切到哪个动画库"。放在一起看，能看出这套系统判定事件的完整套路。

## 7.1 基础量：Get_TrajectoryTurnAngle

[![](/img/in-post/gasp-abp/40-get-trajectory-turn-angle.png)](/img/in-post/gasp-abp/40-get-trajectory-turn-angle.png)
<small class="img-hint">输入方向与当前速度方向的夹角</small>

```text
Get_TrajectoryTurnAngle
  = Delta( RotationFromXVector(Acceleration),
           RotationFromXVector(Velocity) ).Yaw
```

**「玩家想去的方向」与「角色正在去的方向」之间差多少度。**

这个函数本身只有三个节点，但它是后面四个判定的共同基础。值得单独拎出来的原因是它体现了一个取舍：

**用 `Acceleration` 而不是 `TrjFutureVelocity` 来代表意图。** 两者都能表示"想去哪"，但加速度是**当前帧的原始输入方向**，没有经过轨迹预测的平滑。判转向要的就是这份未经平滑的即时性 —— 预测值会滞后，等它转过来，转向动画的起播时机已经错过了。

`RotationFromXVector` 把向量转成 Rotator，再取 Delta 的 Yaw。**没有先归一化向量** —— 因为只关心方向，`RotationFromXVector` 内部本来就只用方向。

后面所有用到它的地方都套了 `ABS`：只关心转多少度，不关心往左还是往右。

## 7.2 IsPivoting

[![](/img/in-post/gasp-abp/42-is-pivoting.png)](/img/in-post/gasp-abp/42-is-pivoting.png)
<small class="img-hint">外层：按路径选子图，再和 IsMoving 求与</small>

> This function is used to determine if the character is pivoting by checking if the character's future trajectory is moving in a much different direction than the character's current trajectory.

```text
IsPivoting
  = Select( Index = UseExperimentalStateMachine,
            False = <MM Pivot conditions>,
            True  = <SM Pivot Condition> )
  AND IsMoving()
```

MM 那一侧的子图：

[![](/img/in-post/gasp-abp/41-mm-pivot-conditions.png)](/img/in-post/gasp-abp/41-mm-pivot-conditions.png)
<small class="img-hint">阈值按 RotationMode 分三档</small>

```text
MM Pivot conditions
  = ABS( Get_TrajectoryTurnAngle() ) >= Select( RotationMode:
        OrientToMovement → 45.0
        Strafe           → 30.0
        Aim              →  0.0 )
```

**阈值按 RotationMode 分档，这是这个函数最值得抄的地方。**

| 模式 | 阈值 | 为什么 |
|---|---|---|
| OrientToMovement | 45° | 角色朝向跟着移动方向转，小角度变化靠转身自然吸收，不需要 pivot |
| Strafe | 30° | 朝向锁定，横移时同样的角度变化对脚步的冲击更大，门槛要低 |
| Aim | 0° | 任何方向变化都算 pivot |

同一个物理量（转角），在不同朝向模式下**对动画的意义完全不同**。OrientToMovement 下转 40° 只是身体顺势带过去；Strafe 下转 40° 意味着脚要重新排布。

Aim 模式取 `0.0` 值得单独说：`ABS(x) >= 0` 恒为 true，所以**瞄准状态下只要在移动就永远判定为 pivoting**。这不是偷懒 —— 瞄准时角色始终面朝准星，任何移动方向的改变都是纯粹的脚步重排，本来就该一直走 pivot 库。

最后与 `IsMoving()` 求与：**站着不动时输入方向再怎么变都不是 pivot。**

注意这个函数所在的蓝图是 `SandboxCharacter_CMC_ABP`，不是 `ABP_MasterMM`。示例工程里判定函数散落在多个 ABP 中，找不到时记得往子类里翻。

## 7.3 ShouldTurnInPlace

[![](/img/in-post/gasp-abp/43-should-turn-in-place.png)](/img/in-post/gasp-abp/43-should-turn-in-place.png)
<small class="img-hint">角度门槛 + 两种触发情境</small>

> This function is used to determine if the character is turning in place by checking if the root bone rotation is different from the character's capsule rotation. For this project, if the rotation is greater than 50 degrees and the character is currently aiming, the character should be turned in place. We also allow turn in places to play if the character has just stopped, which gives us a "Stick Flick" behavior.

```text
ShouldTurnInPlace
  = ABS( Delta( CharacterProperties.OrientationIntent,
                RootTransform.Rotation ).Yaw ) >= 50.0
  AND ( CharacterProperties.InputState.WantsToAim
        OR ( MovementState == Idle
             AND MovementStateLastFrame == Moving ) )
```

**角度用的是「意图朝向」和「根骨朝向」的差，不是和胶囊体朝向的差。**

这是 Offset Root Bone 存在的直接后果（5.4 节）。根骨被允许偏离胶囊体，所以"角色视觉上朝哪"由根骨决定，胶囊体只是碰撞代理。**判转身要拿视觉朝向去比，否则会在根骨还没转过来时就误判转身完成。**

两个触发情境的区别：

**情境一：`WantsToAim`。** 瞄准时朝向锁定在准星上，玩家推摇杆改变意图朝向 → 角度差累积 → 转身。这是常规用法。

**情境二：`MovementState == Idle AND LastFrame == Moving`。** 这是**刚停下的那一帧**，官方叫 "Stick Flick"。

Stick Flick 指的是：玩家快速拨一下摇杆再松开。角色几乎没移动，但意图朝向已经甩到了新方向 —— 这一帧刚好满足"刚停下 + 角度差大"，于是播一个转身。**用一个转身动画兜住了"想转向但没真的走起来"这个手感盲区。**

如果没有这条，快速拨杆的结果是角色抽搐一下回到原样，玩家会觉得输入丢了。

情境二是 3.6 节 LastFrame 双份模式的教科书用例：**`当前 == A AND 上一帧 == B` 就是一次边沿检测**，只在跳变那一帧为真。

图上还留了一条 WIP 备注：

> Turn in place behavior during the aiming state is still WIP. Additional limits need to be applied to the steering or root offset node to prevent the character from lagging too far behind.

翻译过来是：转身期间 Steering 和 Offset Root 会各自往自己的目标拉，两者叠加会让根骨落后胶囊体太多。**官方自己也还没解决这个耦合。**

## 7.4 ShouldSpinTransition

[![](/img/in-post/gasp-abp/44-should-spin-transition.png)](/img/in-post/gasp-abp/44-should-spin-transition.png)
<small class="img-hint">大角度 + 高速 + 非 Pivot</small>

> If the root bone rotation and character's capsule rotations are very different while moving, this function will allow a spin transition animation to play. Spin transitions are locomotion animations that rotate the character while moving in a fixed world direction, and are useful when switching rotation modes.

```text
ShouldSpinTransition
  = ABS( Delta( CharacterTransform.Rotation,
                RootTransform.Rotation ).Yaw ) >= 130.0
  AND Speed2D >= 150.0
  AND NOT( CurrentDatabaseTags CONTAINS "Pivots" )
```

**和 `ShouldTurnInPlace` 是一对：都在测根骨与另一个朝向的偏差，但比较对象和阈值完全不同。**

| | ShouldTurnInPlace | ShouldSpinTransition |
|---|---|---|
| 比较对象 | 意图朝向 vs 根骨 | **胶囊体朝向** vs 根骨 |
| 阈值 | 50° | **130°** |
| 速度要求 | 站定（或瞄准） | **Speed2D ≥ 150** |

比较对象的差异是关键：

- **转身**问的是"玩家想让我朝哪，我现在朝哪"→ 意图 vs 根骨
- **Spin** 问的是"我实际在往哪走，我身体朝哪"→ 胶囊体 vs 根骨

后者是**身体和运动方向脱节**，只在移动中才可能发生。官方举的例子：Orient to Movement 模式下朝摄像机跑，切到 Strafe → 角色需要瞬间转 180°。

`130°` 这个阈值说明它专治大角度：小于 130° 的偏差交给 Steering 平滑处理，超过就得靠专门的旋转动画。

`NOT Contains(Pivots)` 又出现了 —— 和 `IsStarting` 同样的防自我打断（6.2 节）。**Pivot 过程中根骨和胶囊体本来就会大幅偏离，那是 pivot 动画自己造成的，不能拿它当触发 spin 的理由。**

图上一条实话：

> Currently, we are using refacing starts in place of spin transitions, but plan to provide actual spin transition data in a future release.

**函数写好了，但对应的动画数据还没做**，暂时用 refacing start 顶着。判定逻辑和动画资产是解耦的，可以先把判定搭好再补资产。

## 7.5 JustTraversed

[![](/img/in-post/gasp-abp/45-just-traversed.png)](/img/in-post/gasp-abp/45-just-traversed.png)
<small class="img-hint">曲线还在，但 Slot 已经退出 = 正在混出翻越动作</small>

> This function is used to select the tail end of traversal animations when blending back to locomotion. For example, if the MovingTraversal anim curve value is greater than 1, and the default slot is NOT active (slots are not active when blending out), the character must be blending out from a moving traversal action, therefore this function will return true. The chooser then allows the Motion Matching node to select from the "FromTraversal" databases for a seamless followthrough.

```text
JustTraversed
  = NOT IsSlotActive("DefaultSlot")
  AND GetCurveValue("MovingTraversal") > 0.0
  AND ABS( Get_TrajectoryTurnAngle() ) <= 50.0
```

**这个函数是全篇最巧的一个判定，值得慢慢看。**

前两个条件单独看都很普通，组合起来构成了一个精确的时间窗：

| 条件 | 含义 |
|---|---|
| `MovingTraversal` 曲线 > 0 | 当前姿态里**还有**翻越动画的成分 |
| Slot **不**活跃 | 蒙太奇**已经**进入淡出 |

**两者同时成立的唯一时刻，就是翻越动作正在混出、但还没混完的那一小段。**

原理在官方注释里说破了：`IsSlotActive` 在淡出期间返回 false，但曲线值仍然大于 0（因为姿态里还有它的权重）。**用「Slot 状态」和「曲线值」的不同步，把一个转瞬即逝的过渡窗口给框了出来。**

这比"记一个 bool 然后延时清掉"高明得多 —— 不需要任何状态变量，窗口的起止完全由混合本身决定，混多久窗口就多长。

框出这个窗口是为了让 Chooser 切到 `FromTraversal` 数据库。翻越结束时角色的姿态很特殊（可能在半空、身体前倾），普通的 locomotion 循环接不上，需要一组专门"从翻越姿态接回跑步"的动画。**这正好对应上一篇里数据库命名的 `FromTraversal` 阶段字段。**

第三个条件 `ABS(TurnAngle) <= 50` 是个否决：**翻完立刻要转向的话，就不走 FromTraversal 的顺接了。** 顺接动画假设你会继续朝原方向跑，玩家要拐弯时强行顺接反而更别扭，不如让 MM 自由选。

## 7.6 落地判定四件套

落地这一个事件，被拆成了四个函数。

### `Get_LandVelocity`

[![](/img/in-post/gasp-abp/48-get-land-velocity.png)](/img/in-post/gasp-abp/48-get-land-velocity.png)

```text
Get_LandVelocity = CharacterProperties.LandVelocity.Z
```

一行转发。**存在的意义是把「落地冲击」这个概念固定为 Z 分量** —— 调用方不需要知道 `LandVelocity` 其实是个三维向量，也不会有人误用 XY。

### `JustLanded_Light` / `JustLanded_Heavy`

[![](/img/in-post/gasp-abp/46-just-landed-light.png)](/img/in-post/gasp-abp/46-just-landed-light.png)
<small class="img-hint">轻着地</small>

[![](/img/in-post/gasp-abp/47-just-landed-heavy.png)](/img/in-post/gasp-abp/47-just-landed-heavy.png)
<small class="img-hint">重着地，只有比较符号相反</small>

```text
JustLanded_Light = JustLanded AND ABS(LandVelocity.Z) <  ABS(HeavyLandSpeedThreshold)
JustLanded_Heavy = JustLanded AND ABS(LandVelocity.Z) >= ABS(HeavyLandSpeedThreshold)
```

两个函数只差比较符号，**互斥且完备** —— `JustLanded` 为真时必然恰好命中一个。

两侧都套 `ABS`：`LandVelocity.Z` 是负值（向下），阈值配置可能填正也可能填负。**两边都取绝对值，配置怎么填都不会错。** 这种对配置容错的写法在示例工程里出现了多次。

`JustLanded` 是 `CharacterProperties` 里的字段，由 C++ 侧在落地那一帧置位。**这类"某事刚发生"的瞬时标志，蓝图侧算不出来，只能由 C++ 推过来** —— 这也是 2.1 节那个"唯一入口"必须存在的原因之一。

### `PlayLand` / `PlayMovingLand`

[![](/img/in-post/gasp-abp/49-play-land.png)](/img/in-post/gasp-abp/49-play-land.png)
<small class="img-hint">纯边沿检测</small>

[![](/img/in-post/gasp-abp/50-play-moving-land.png)](/img/in-post/gasp-abp/50-play-moving-land.png)
<small class="img-hint">同样的边沿，加一个转角限制</small>

```text
PlayLand       = MovementMode == OnGround AND MovementModeLastFrame == InAir
PlayMovingLand = MovementMode == OnGround AND MovementModeLastFrame == InAir
                 AND ABS( Get_TrajectoryTurnAngle() ) <= 120.0
```

**这里出现了同一事件的第二套判定方式，和 `JustLanded` 并存。**

| | 数据来源 | 特点 |
|---|---|---|
| `JustLanded_*` | C++ 推来的 `JustLanded` 标志 + 冲击速度 | 带**强度**信息 |
| `PlayLand` / `PlayMovingLand` | `MovementMode` 的 LastFrame 边沿 | 纯**时机**，蓝图自足 |

两套并存不是冗余。`JustLanded_*` 回答"这次落地有多重"，`PlayLand` 回答"落地这一帧到了没"。前者选动画强度，后者管触发时机。

`PlayMovingLand` 多的那个 `<= 120°` 条件和 `JustTraversed` 的第三条件是同一个思路：**落地后如果要大幅转向，就别用"带着水平速度继续跑"的落地动画。** 转角超过 120° 说明玩家想掉头，顺势前冲的落地动画会和意图打架。

## 7.7 这一族的四条共同套路

七个判定函数看下来，套路是重复的：

**一、阈值不是常数，是查表。** `IsPivoting` 按 RotationMode 三档，`Get_MMBlendTime` 按 MovementMode 分支。硬编码一个 magic number 是最省事的，但也是手感最差的。

**二、"事件发生"= 边沿，不是状态。** `PlayLand`、`ShouldTurnInPlace` 的 Stick Flick 分支，都是 `当前 == A AND 上一帧 == B`。3.6 节那套 LastFrame 变量的价值，到这一部分才完全兑现。

**三、几乎每个判定都带一个否决条件。**

| 函数 | 否决 | 防什么 |
|---|---|---|
| `IsStarting` | `NOT Contains(Pivots)` | Pivot 后半段被误判成起步 |
| `ShouldSpinTransition` | `NOT Contains(Pivots)` | Pivot 造成的偏差触发 spin |
| `JustTraversed` | 转角 > 50° | 要拐弯时强行顺接 |
| `PlayMovingLand` | 转角 > 120° | 要掉头时用前冲落地 |

**肯定条件决定"什么时候可以播"，否决条件决定"什么时候不该播"。** 后者往往比前者更影响成品质量，因为出错的表现是"动画卡住"或"动作打架"，比不播更难看。

**四、姿态相似的动作靠 tag 区分，不靠数值。** 两次 `NOT Contains(Pivots)` 都在处理同一类问题：**Pivot 中段的数值特征和别的动作撞了**，光看速度、转角区分不出来，只能问"我现在在播哪个库"。

这是 4.5 节反馈总线真正的用途 —— 不是为了炫技，是因为**纯数值判定在动作姿态相似时必然失效**，必须引入「当前在播什么」作为额外维度。

---

# 第八部分：总表

## 8.1 变量

| 类别 | 变量 |
|---|---|
| **数据源** | `CharacterProperties` |
| **变换** | `CharacterTransform` / `CharacterTransformLastFrame` / `RootTransform` |
| **速度** | `Velocity` / `VelocityLastFrame` / `Speed2D` / `HasVelocity` / `LastNonZeroVelocity` |
| **加速度** | `Acceleration` / `AccelerationLastFrame` / `AccelerationAmount` / `HasAcceleration` / `VelocityAcceleration` / `RelativeAcceleration` |
| **轨迹** | `Trajectory` / `TrjPastVelocity` / `TrjCurrentVelocity` / `TrjFutureVelocity` / `PreviousDesiredControllerYawLastUpdate` |
| **状态枚举** | `MovementState` / `Gait` / `Stance` / `MovementMode` / `RotationMode`（各带 `LastFrame`） |
| **MM 结果** | `CurrentSelectedAnim` / `CurrentSelectedDatabase` / `CurrentDatabaseTags` |
| **配置** | `OffsetRootBoneEnabled` / `OffsetRootTranslationRadius`（CVar 驱动） / `UseExperimentalStateMachine` / `InterpolationSettings_Default` / `InterpolationSettings_Stops` / `PlantSettings_Default` / `PlantSettings_Stops` / `HeavyLandSpeedThreshold` |
| **状态机分支专用** | `TargetRotation` / `BlendStackInputs`（含 `Blend Curve` / `Tags`） |

## 8.2 函数

| 类别 | 函数 | 调用方 |
|---|---|---|
| **数据采集** | `UpdatePropertiesFromCharacter` | Event Graph |
| **每帧主干** | `UpdateTrajectory` / `UpdateEssentialValues` / `UpdateState` | Event Graph |
| **MM 回调** | `Update_PoseSearch` / `Update_MotionMatchingPoseSelection` | MM 节点事件 |
| **MM 参数** | `Get_MMNotifyRecencyTimeOut` / `Get_MMBlendTime` / `Get_MMInterruptMode` | MM 节点绑定 |
| **Steering** | `Get_DesiredFacing` / `EnableSteering` | Steering 节点绑定 |
| **Warping** | `Get_OrientationWarpingWarpingSpace` | Warping 节点绑定 |
| **Offset Root** | `Get_OffsetRootTranslationMode` / `Get_OffsetRootRotationMode` / `Get_OffsetRootTranslationHalfLife` / `Get_OffsetRootTranslationRadius` | Offset Root Bone 节点绑定 |
| **Foot Placement** | `Get_FootPlacementPlantSettings` / `Get_FootPlacementInterpolationSettings` | Foot Placement 节点绑定 |
| **Lean** | `Get_LeanAmount` / `CalculateRelativeAccelerationAmount` | Blendspace 绑定 |
| **Aim Offset** | `Get_AOValue` / `Get_Ao_Yaw` / `Enable_AO` | Blendspace / Blend 节点绑定 |
| **状态判定** | `IsMoving` / `IsStarting` | 被上面各类调用 |
| **事件判定** | `Get_TrajectoryTurnAngle` / `IsPivoting` / `ShouldTurnInPlace` / `ShouldSpinTransition` / `JustTraversed` | Chooser、状态机转移条件 |
| **落地判定** | `Get_LandVelocity` / `JustLanded_Light` / `JustLanded_Heavy` / `PlayLand` / `PlayMovingLand` | Chooser、状态机转移条件 |
| **节点引用** | `GetCurrentBlendStackAnimAsset` / `...AnimAssetTime` / `...AnimIsActive` / `Convert to Motion Matching Node` / `Get_PoseHistoryReference` | Warping / Steering / MM 回调 |
| **Slot 查询** | `IsSlotActive` / `GetSlotLocalWeight` | Offset Root / Enable_AO / JustTraversed |
| **数值防护** | `SafeDivide` / `MAX` | UpdateEssentialValues |

---

# 第九部分：十条可复用的设计约定

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

**⑧ 判定要成对写：肯定条件 + 否决条件。**
`IsStarting` 的 `NOT Contains(Pivots)`、`JustTraversed` 的转角上限、`PlayMovingLand` 的 120° —— 每个判定都配了一条"什么时候不该播"。**肯定条件决定功能有没有，否决条件决定成品好不好看。** 出错时前者的表现是"没反应"，后者是"动作打架"，后者更难查也更刺眼。

**⑨ 数值区分不开的，用「当前在播什么」区分。**
Pivot 后半段和 Start 的速度、转角特征几乎一样，纯数值判定必然误触发。引入 `CurrentDatabaseTags` 作为额外维度，才能把它们分开。**这是 Motion Matching 相比状态机唯一真正缺失的东西 —— 状态机天然知道自己在哪个状态，MM 需要手动把这个信息喂回来。**

**⑩ 状态变了 ≠ 该换动画了。**
`Get_MMInterruptMode` 里，Gait 变化要求 `MovementState == Moving`，Stance 变化要求 `MovementMode == OnGround`。**中间隔着一层"这个变化在当前情境下有没有视觉意义"的判断。** 少了这层，就会有"站着按冲刺键角色抖一下"这类 bug。

---

# 第十部分：复刻检查清单

按依赖顺序，前面没做完不要做后面：

```text
□  1. 定义 CharacterProperties 结构体（连续量 / 上限量 / 枚举 / 瞬时标志）
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
□ 12. Get_MMInterruptMode：默认 Do Not Interrupt，核心状态跳变才打断
□ 13. Get_MMBlendTime：落地 0.2 / 起跳 0.15 / 常规 0.5
□ 14. Update_MotionMatchingPoseSelection → CurrentDatabaseTags
□ 15. 给 Database 打 Tag（Stops / Pivots / TurnInPlace / Starts / FromTraversal）

□ 16. Blend Stack 内：Orientation Warping + Enable_Warping 曲线
□ 17. Steering ×2（常规 0.2 / TurnInPlace 100000）
□ 18. Offset Root Bone + 四个 Get_ 函数
□ 19. Foot Placement + Leg IK，Plant/Interpolation 两套设置都读 Tag
□ 20. Additive Lean（CalculateRelativeAccelerationAmount.Y × 速度缩放）
□ 21. Aim Offset（Get_AOValue / Get_Ao_Yaw / Enable_AO / 0.75 进 1.5 出）

□ 22. Get_TrajectoryTurnAngle，后面四个判定都依赖它
□ 23. IsPivoting（阈值按 RotationMode 分 45/30/0）
□ 24. ShouldTurnInPlace（50° + 瞄准 或 刚停下）
□ 25. JustTraversed（Slot 不活跃 + 曲线仍 >0 的混出窗口）
□ 26. 落地四件套（JustLanded_Light/Heavy + PlayLand/PlayMovingLand）
```

**前 10 步是地基。** 第 11 步之前如果 `Trajectory` 或 `Pose History` 有任何问题，MM 一定返回 `FLT_MAX`，而且你会花大量时间去怀疑 Schema 和 Database —— 那是上一篇讲的七步排查里最常见的弯路。

**22 到 26 可以最后做。** 这一批是判定函数，不做也能跑，只是 Chooser 的分支会少几条。**但它们决定了手感的上限** —— 前 21 步搭的是"能动"，这 5 步补的是"动得对"。

---

# 相关阅读

- [GASP 5.8 Motion Matching 全流程拆解](/2026/09/07/gasp-motion-matching-animbp-chooser-database/) —— 资产分层、Chooser Table、Database 切分
- [UE5 Motion Matched Interaction 实践](/2026/09/07/ue5-motion-matched-interaction/)
