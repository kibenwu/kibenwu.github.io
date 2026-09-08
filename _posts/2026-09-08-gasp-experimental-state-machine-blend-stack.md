---
layout: post
title: GASP 5.8 实验性状态机拆解（三）
subtitle: State Machine + Chooser + 单帧 Motion Matching + Blend Stack
author: KivenWu
header-style: text
tags:
  - UE5
  - Animation
  - Motion Matching
  - Blend Stack
  - Chooser
  - State Machine
  - GASP
---

# 这篇讲什么

前两篇讲的是 GASP 的**主线方案**：Chooser 选数据库 → Motion Matching 节点每帧搜索 → 节点内建 Blend Stack 播放。

- [（一）动画蓝图、Chooser Table 与 Database 切分](/2026/09/07/gasp-motion-matching-animbp-chooser-database/)
- [（二）动画蓝图的变量、函数与节点绑定](/2026/09/07/gasp-animbp-functions-and-variables/)

这一篇讲**方案 B**，也就是 GASP 里那个标着 `(Experimental!)` 的第二套 locomotion 实现：

> **State Machine + Choosers + Motion Matching + Blendstack (Experimental!)**
>
> This is a highly experimental setup that aims to combine the controllability of State Machines, the scalability of Choosers, the power of Motion Matching, and the blending behavior of Blend Stack, all in an effort to build a flexible locomotion system that is artist friendly and easy to control.
>
> —— Epic 在 AnimGraph 上的原注释

四个词对应四个诉求，这是理解整套设计的钥匙：

| 组件 | 提供的能力 | 单独用时的缺陷 |
|---|---|---|
| State Machine | **可控性**：状态、转换条件、进入/退出回调都是显式的 | 资产爆炸，状态重入难处理 |
| Chooser | **可扩展性**：加动画只是加一行表，不动图 | 只能按条件筛，不看姿态 |
| Motion Matching | **表现力**：按姿态/轨迹挑动画与入点 | 不好精确控制"现在必须播这个" |
| Blend Stack | **混合行为**：换资产自动起混合，支持多层堆叠 | 本身不做决策 |

Epic 自己也写明了这套东西的定位：

> The main purpose of this setup is to inform future tool development and experiment with workflow questions such as "what could we do if state machines used a blend stack internally, and could easily handle state re-entry?" Although the current workflow is far from ideal, we felt it'd be great to show this off anyway.

翻译一下：**这是给引擎组自己看的原型，不是给你抄进项目的模板。** 但它把"状态机内部用 Blend Stack、并且能优雅处理状态重入"这个问题解得挺漂亮，值得拆开看。

本文所有截图来自 `SandboxCharacter_CMC_ABP` / `SandboxCharacter_Mover_ABP` 的 `State Machine (Experimental)` 图层，Epic 原注释我原文引用并逐句解释。引擎侧 API 签名与转换配置项的语义来自 UE 5.8 安装目录的源码，可核对。

**如果你只想看一个问题的答案**：状态机 Details 面板里 `Allow Inertialization for Self Transitions` 为什么有的勾有的不勾、`Transition Notifications` 为什么只填 Start —— 直接跳 **6.10 / 6.11**。

---

# 第一部分：整体架构

## 1.1 一个不输出姿态的状态机

这是全套设计里最反直觉的一点，先看图：

[![](/img/in-post/gasp-sm/01-animgraph-state-controller-blendstack.png)](/img/in-post/gasp-sm/01-animgraph-state-controller-blendstack.png)
<small class="img-hint">AnimGraph：State Controller 的姿态被丢弃，真正出画面的是 Blend Stack</small>

```text
State Controller (State Machine) ──► Inertialization ──► Two Way Blend [A]
                                                                       [B] ◄── Blend Stack
                                                         Alpha = 1.0  ──►  输出
```

Alpha 恒等于 `1.0`，意味着 **A 引脚（状态机的姿态）永远权重为 0**。Epic 的原注释：

> The state machine below is used as a purely logical state machine, and outputs no pose. Its job is to write to the Blend Stack using "On State Entry" anim node functions. The Two Way Blend node allows only the Blend Stack pose to pass through, but is set to "always update children", enabling the State Machine to run its logic before the Blend Stack.

三句话三个关键点：

**① 状态机退化成纯逻辑机。** 它的每个状态里可以什么都不接（或接个占位），姿态被 Two Way Blend 丢掉。它唯一的产出是**副作用**——在 `OnStateEntry_*` 里给 Blend Stack 的输入结构赋值。

**② `Alpha = 1.0` 是"只让 B 过"的写法。** 为什么不直接把 State Controller 删掉？因为 AnimGraph 里**没被连接的节点不会被更新**。要让状态机的 `Update` 每帧跑，它必须挂在有效的姿态链上。

**③ `Always Update Children` 决定了执行顺序。** 这是 Two Way Blend 节点上那个勾选项（图上右上角的闪电图标表示节点带函数绑定）。默认情况下权重为 0 的分支会被跳过更新；勾上之后两个分支都更新，且 **A 在 B 之前**。这一条至关重要——状态机必须先跑完逻辑、把 `BlendStackInputs` 写好，Blend Stack 才在同一帧读到新值。顺序反了就会晚一帧。

> **可以直接抄的经验**：任何"用状态机做决策、用别的节点出画面"的结构，都要靠 `Always Update Children` + Alpha 锁死来保证时序。这比在 Event Graph 里手动排序可靠，因为它遵守 AnimGraph 自己的更新顺序。

## 1.2 数据流全景

先把整条链画出来，后面每一节都是在填这张图的某一格：

```text
【每帧，Event Graph / Thread Safe Update】
  Update_MovementDirection   ──► MovementDirection（F/B/LL/LR/RL/RR）
  Update_TargetRotation      ──► TargetRotation / TargetRotationDelta

【状态转换发生时，一次性】
  State Controller 的转换条件（读上面那些变量 + NoValidAnim 等）
        │
        ▼
  OnStateEntry_XXX  ──►  SetBlendStackAnimFromChooser(State, ForceBlend)
                              │
                              ├─ SET StateMachineState = XXX
                              ├─ 缓存 Previous_BlendStackInputs
                              ├─ 复位 NoValidAnim / NotifyTransition_*
                              ├─ Evaluate Chooser (CHT_xxxCharacterAnimations)
                              │     └─► ValidAnims[] + S_ChooserOutputs
                              ├─ 若 UseMM → MotionMatch(ValidAnims) 覆盖 Anim/Time/Loop
                              ├─ SET BlendStackInputs（Anim/StartTime/Loop/BlendTime/BlendProfile）
                              └─ 若 ForceBlend → ForceBlendOnNextUpdate()

【姿态求值时，Property Access】
  Blend Stack 节点的 5 个引脚 ◄── BlendStackInputs.*
  Play Rate 引脚（如接）      ◄── Get_DynamicPlayRate()
```

一句话总结：**状态机决定"什么时候换"，Chooser 决定"换成什么类别"，Motion Matching 决定"具体哪条、从第几帧进"，Blend Stack 负责"怎么混过去"。** 四层职责完全不重叠。

## 1.3 函数与变量清单

先建立索引，知道有哪些零件：

[![](/img/in-post/gasp-sm/02-anim-node-functions.png)](/img/in-post/gasp-sm/02-anim-node-functions.png)
<small class="img-hint">State Machine (Experimental) 图层下的 Anim Node Functions</small>

```text
SetBlendStackAnimFromChooser      ← 核心，所有 OnStateEntry 都调它
IsAnimationAlmostComplete         ← 转换条件用
Get_DynamicPlayRate               ← Blend Stack 播放速率
OnStateEntry_IdleLoop
OnStateEntry_TransitionToIdle
OnStateEntry_LocomotionLoop
OnStateEntry_TransitionToLocomotion
OnUpdate_TransitionToLocomotion
OnStateEntry_InAirLoop
OnStateEntry_TransitionToInAir
OnStateEntry_IdleBreak
OnStateEntry_SlideLoop
OnStateEntry_TransitionToSlide
```

规律很清楚：**每个状态一个 `OnStateEntry_`，只有 `TransitionToLocomotion` 额外有 `OnUpdate_`**（因为它要每帧插值一个旋转，见 4.3 节）。

[![](/img/in-post/gasp-sm/03-direction-rotation-functions.png)](/img/in-post/gasp-sm/03-direction-rotation-functions.png)
<small class="img-hint">另外两组：Movement Direction 与 Target Rotation</small>

```text
Movement Direction
  Update_MovementDirection            ← 有副作用，每帧调
  Get_MovementDirectionThresholds     ← 纯函数，算象限边界

Target Rotation
  Update_TargetRotation               ← 有副作用，每帧调
  Get_StrafeYawRotationOffset         ← 纯函数，算 strafe 偏移
```

变量分两组。第一组是状态机 / Blend Stack 相关：

[![](/img/in-post/gasp-sm/08-variables-animgraph.png)](/img/in-post/gasp-sm/08-variables-animgraph.png)
<small class="img-hint">Anim Graph 分类下的变量</small>

| 变量 | 类型 | 作用 |
|---|---|---|
| `BlendStackInputs` | `S_BlendStackInputs` | **唯一的输出通道**，Blend Stack 五个引脚全从这里读 |
| `Previous_BlendStackInputs` | `S_BlendStackInputs` | 上一次选择的快照（当前未使用，见 4.2） |
| `StateMachineState` | `E_ExperimentalStateMachineState` | 当前逻辑状态，喂给 Chooser 当筛选条件 |
| `NoValidAnim` | `bool` | Chooser/MM 都没结果 → 触发转到下一个状态 |
| `NotifyTransition_Re-Transition` | `bool` | 请求重入当前转换 |
| `NotifyTransition_ToLoop` | `bool` | 请求转到循环状态 |
| `SearchCost` | `float` | 上次单帧 MM 的代价，调试/阈值用 |
| `ValidAnims` | `Animation Asset[]` | Chooser 输出的候选集，喂给 MM |

第二组是方向与朝向：

[![](/img/in-post/gasp-sm/09-variables-direction-rotation.png)](/img/in-post/gasp-sm/09-variables-direction-rotation.png)
<small class="img-hint">Movement Direction 与 Target Rotation 分类下的变量</small>

| 变量 | 类型 | 作用 |
|---|---|---|
| `MovementDirection` | `E_MovementDirection` | F / B / LL / LR / RL / RR |
| `MovementDirectionLastFrame` | 同上 | 上一帧快照，象限迟滞用 |
| `MovementDirectionBias` | 同上 | 左脚前 / 右脚前的偏好 |
| `MovementDirectionThresholds` | `S_MovementDirection...` | 四个象限边界（FL/FR/DL/DR） |
| `TargetRotation` | `Rotator` | 给 Steering 节点的目标朝向 |
| `TargetRotationOnTransitionStart` | `Rotator` | 转换开始时的快照 |
| `TargetRotationDelta` | `float` | 与角色朝向的差值，Chooser 用它挑起步/转身 |
| `UseExperimentalStateMachine` | `bool` | 总开关，切换方案 A / 方案 B |

---

# 第二部分：数据准备层

这一层每帧都跑，跟状态机没有直接关系，但状态机的转换条件和 Chooser 的筛选列全靠它。

[![](/img/in-post/gasp-sm/20-update-call-order.png)](/img/in-post/gasp-sm/20-update-call-order.png)
<small class="img-hint">调用顺序固定：先方向，再朝向（Update_TargetRotation 依赖 MovementDirection）</small>

**顺序不能换。** `Update_TargetRotation` 里的 strafe 偏移要按 `MovementDirection` 去选曲线，所以方向必须先算好。

## 2.1 Update_MovementDirection：为什么不用 Blendspace

Epic 的原注释先交代了动机：

> This function sets the "Movement Direction", which determines which set of directional animations to play. Because we do not use blendspaces, we need to be specific about which animations to play depending on the movement direction. In this setup, we have 4 main directions: Forward (F), Backward (B), Left, and Right, with left and right each having 2 options depending on which foot should be forward: Left with the left foot forward (LL), Left with the right foot forward (LR), and likewise for the right. Certain games may want to control which foot is forward based on things like camera shoulder, or weapon.

**这套方案不用 Blendspace。** 原因在后面 `Update_TargetRotation` 的注释里说得更明白：大量使用转身/起步过渡动画时，Blendspace 那种"两条动画按角度插值"的做法会把过渡动画糊掉。所以这里改成离散的 6 个枚举值：

```text
F   前
B   后
LL  左移 · 左脚在前        LR  左移 · 右脚在前
RL  右移 · 左脚在前        RR  右移 · 右脚在前
```

左右各两份，是为了让"哪只脚在前"可以被游戏逻辑指定——注释里举的例子是**过肩镜头的肩别**和**持械手**。

### 第一步：缓存上一帧

[![](/img/in-post/gasp-sm/21-umd-cache-last-frame.png)](/img/in-post/gasp-sm/21-umd-cache-last-frame.png)
<small class="img-hint">先存快照，再判断是否在移动</small>

> Cache the last frame's movement direction, and only update the movement direction if we are in the moving state.

```text
SET MovementDirectionLastFrame = MovementDirection
Branch (MovementState == Moving) ──► 继续
                              └──► 什么都不做（保持上一帧的方向）
```

**停下来的时候方向不清零**，这很重要：停止动画、转身停止动画都要靠"停之前朝哪个方向走"来选。

### 第二步：算出角度

[![](/img/in-post/gasp-sm/22-umd-calculate-direction.png)](/img/in-post/gasp-sm/22-umd-calculate-direction.png)
<small class="img-hint">Calculate Direction：未来速度方向 vs 角色朝向</small>

> Use the future velocity direction and the current capsule rotation to determine the "Direction" of movement, expressed as an angle from -180 to +180 degrees, with 0 being forward, -90 being left, +90 being right, and +/-180 being backwards.

```text
Normalize(Trj Future Velocity)  ──► Calculate Direction.Velocity
CharacterProperties.OrientationIntent ──► Calculate Direction.Base Rotation
                                          └──► SET Direction  (-180 .. +180)
```

两个细节：

**① 用的是 `Trj Future Velocity`，不是当前速度。** 轨迹的未来速度已经把输入意图算进去了，用它判断方向比用当前速度**提前若干帧**，转向响应会更快。这跟 Motion Matching 用未来轨迹匹配是同一个思路。

**② Base Rotation 用 `OrientationIntent` 而不是实际胶囊体旋转。** `OrientationIntent` 是角色**想要**朝的方向，用它做基准可以避免"胶囊体还在慢慢转、方向枚举反复跳变"。

### 第三步：取象限边界

[![](/img/in-post/gasp-sm/23-umd-set-thresholds.png)](/img/in-post/gasp-sm/23-umd-set-thresholds.png)
<small class="img-hint">阈值不是常量，每帧重算</small>

> Set the movement direction thresholds. These are the thresholds that you can see if you enable the state machine debugging command using the widget.

阈值每帧从 `Get_MovementDirectionThresholds` 取，因为它是**动态的**——下面 2.2 节专门讲。

### 第四步：落到象限

[![](/img/in-post/gasp-sm/24-umd-quadrants-a.png)](/img/in-post/gasp-sm/24-umd-quadrants-a.png)
<small class="img-hint">先短路两种"永远向前"的情况，再按象限分支</small>

> If the character is in the "OrientToMovement" rotation mode, or is sprinting, then we always set the Movement Direction to F, since we only want to play F animations. If you want to set up omnidirectional sprint, the sprint check could be removed. If the character is in the Strafe Rotation Mode, then set the Movement Direction based on what quadrant the "Direction" value is in, using the thresholds as the boundaries of each quadrant. For the L and R quadrants, the Movement Direction Bias value determines whether the character should have the left or right foot forward when strafing.

```text
IF  RotationMode == OrientToMovement  OR  Gait == Sprint
        └──► MovementDirection = F      （短路，不看角度）

ELSE（Strafe 模式）
    In Range(Direction, FL, FR)  ──► F
    In Range(Direction, FL, DL)  ──► Select(Bias) ? LL : LR
    In Range(Direction, FR, DR)  ──► Select(Bias) ? RL : RR
    否则                          ──► B
```

[![](/img/in-post/gasp-sm/25-umd-quadrants-b.png)](/img/in-post/gasp-sm/25-umd-quadrants-b.png)
<small class="img-hint">L/R 象限各挂一个 Select，用 MovementDirectionBias 选左脚前还是右脚前</small>

两处设计值得抄：

**① `OrientToMovement` 下只播 F 动画。** 角色朝向永远跟着移动方向转，所以身体相对速度永远是"向前"。这一条直接省掉了 5/6 的动画量。

**② 冲刺也强制 F。** 注释明确说了：如果你要做全向冲刺，把这个判断删掉就行。这是 Epic 少见的直接给出改法的地方。

## 2.2 Get_MovementDirectionThresholds：象限迟滞

这个函数是整套方向系统里最"手感向"的部分。

[![](/img/in-post/gasp-sm/04-get-movement-direction-thresholds.png)](/img/in-post/gasp-sm/04-get-movement-direction-thresholds.png)
<small class="img-hint">按当前方向和播放状态动态改变象限大小</small>

> This function adjusts the thresholds of the Movement Direction quadrants based on various conditions. These are largely subjective things and can be tuned to fit your needs. You can see the quadrants change if you enable state machine debugging in the widget.

返回四个值：`FL` / `FR` 是 F 象限的左右边界，`DL` / `DR` 是 B 象限的左右边界。

```text
Switch on E_MovementDirection
  ├─ F / B ──► Branch(Is Pivoting)
  │              └─► 都返回：FL -60  FR 60  DL -120  DR 120
  └─ LL/LR/RL/RR ──► Branch( 条件见下 )
                       True  ──► FL -60  FR  60  DL -140  DR 140
                       False ──► FL -40  FR  40  DL -140  DR 140
```

**第一条规则（F/B 或正在 pivot）：**

> Widen the F and B quadrant if the character is currently in the F or B directions, or is pivoting. This makes it less likely to switch to the L and R quadrants if you are already in the F or B one and moving at a 45 or 135 degree angle.

这是标准的**迟滞（hysteresis）**：已经在 F 里，就把 F 的门开大一点，别让 45° 输入把你抖到 L 去。`MovementDirectionLastFrame` 的存在就是为这个。

**第二条规则（L/R 象限）：**

> If the character is in the L or R quadrant, widen it only if the character is playing a transition animation or is aiming. This means that whenever the character is playing a looping animation and not aiming, moving at a 45 or 135 will put the character into the F or B direction, which feels a bit more natural.

图上的条件是 `AND( BlendStackInputs.Loop , NOT WantsToAim )`：

- **True（正在播循环动画 且 不在瞄准）** → `FL/FR = ±60`，F 象限大 → 45° 会被判成 F。**这是"更自然"的那一边。**
- **False（正在播过渡动画 或 在瞄准）** → `FL/FR = ±40`，F 象限小 → 45° 会被判成 L/R。

按德摩根律，False 分支的条件等价于 `NOT Loop OR WantsToAim`，跟注释里"playing a transition animation or is aiming"完全对上。

> **注意 `DL/DR` 也变了**：F/B 时是 ±120，进了 L/R 之后变成 ±140，也就是要更偏后才判成 B。B 象限被收窄了 20°——同样是防抖，只不过防的是"L 抖到 B"。

**这三组数字（±60/±40/±120/±140）是主观手感值**，注释里明说了 "largely subjective"。移植到自己项目时按自己的动画覆盖范围调。

## 2.3 Update_TargetRotation：用旋转换资产量

先看 Epic 的注释，这段是全篇信息密度最高的一段：

> In an effort to reduce asset count, the state machine setup uses only the 4 main cardinal directions (F,B,L,R). Typically, blendspaces could be used to solve for 45 or 135 degree angles, however, the heavy use of transition animations makes this difficult. Therefore, instead of relying solely on orientation warping, we give the steering node a custom target rotation, meaning we can make the F run rotate to run at 45 degrees, giving us a more natural feel, and increasing coverage with lower amounts of data.

拆成因果链：

```text
只做 4 个基本方向（省资产）
   ↓ 45°/135° 怎么办？
Blendspace 插值 ──✗ 过渡动画一多就糊
Orientation Warping 硬掰 ──△ 角度大了会扭曲
   ↓
给 Steering 节点一个自定义 Target Rotation
   ↓
让"向前跑"这条动画整体转 45° 去跑 45° 方向
   → 数据量不变，覆盖角度翻倍，手感还更自然
```

**这是本文最值得带走的一条设计思路**：不要总想着"把动画掰成需要的样子"，可以反过来"把需要的方向转成动画擅长的样子"。前者是 warping，后者是 steering。

### 结构：Sequence 分两路

[![](/img/in-post/gasp-sm/30-utr-delta-and-idle.png)](/img/in-post/gasp-sm/30-utr-delta-and-idle.png)
<small class="img-hint">Then 0 算 TargetRotation，Then 1 算 Delta</small>

**下半路（Delta）：**

> Save the delta between the root and target rotation. This is mainly used in the Chooser to select different animations like starts and turns.

```text
TargetRotationDelta = Delta(Rotator)( TargetRotation , RootTransform.Rotation ).Z
```

只取 Yaw。这个值就是 Chooser 表里那一列 **`Future Facing Delta`** ——起步、90° 转身、180° 转身全靠它区分。第三部分会看到具体的表。

**上半路第一段（静止）：**

> If the character is not moving, the target rotation should match the character's rotation.

```text
Branch(Is Moving) False ──► TargetRotation = CharacterProperties.OrientationIntent
```

静止时目标朝向 = 当前朝向，也就是**不给 Steering 任何偏移**，否则站着不动会被慢慢拧过去。

### 三种旋转模式

[![](/img/in-post/gasp-sm/31-utr-orient-and-strafe.png)](/img/in-post/gasp-sm/31-utr-orient-and-strafe.png)
<small class="img-hint">Switch on E_RotationMode：Orient to Movement / Strafe / Aim</small>

> When in the Orient to Movement rotation mode, the target rotation should always match the capsule rotation.

```text
Orient to Movement ──► TargetRotation = OrientationIntent
```

因为这个模式下永远播 F 动画（见 2.1），身体已经对着移动方向，不需要额外偏移。

> When in the Strafe rotation mode, an offset is applied to the target rotation in order for the directional animations to match the actual strafing angle.

```text
Strafe ──► TargetRotation = (OrientationIntent.X,
                             OrientationIntent.Y,
                             OrientationIntent.Z + Get_StrafeYawRotationOffset())
```

**只加在 Yaw 上。** 这个 offset 就是"让 F 动画去跑 45°"的那个角度。

`Aim` 分支在截图里是空的——瞄准模式下朝向由控制器决定，不需要动画侧再插手。

## 2.4 Get_StrafeYawRotationOffset：把曲线塞进假动画里

这个函数的实现是全篇最"脏"的一处 hack，但它揭示了一个真实的引擎限制。

[![](/img/in-post/gasp-sm/05-strafe-yaw-offset-map-range.png)](/img/in-post/gasp-sm/05-strafe-yaw-offset-map-range.png)
<small class="img-hint">先把 -180~180 映射成 0~8，再除以 30 换算成"秒"</small>

> This function gets the direction between the future velocity and the current character rotation, and uses a curve to map that direction to an offset value. Each Movement Direction has its own curve and offset values. **Because querying a curve asset is not currently thread safe, we store the curves in a dummy anim sequence**, which is why we have to map the direction to the number of frames the dummy anim sequence has, and divide by 30. In the animations, each frame represents an angle at an increment of 45 degrees.

问题：**`UCurveFloat` 资产的采样不是线程安全的**，而这个函数要在 Thread Safe Update 里跑。

Epic 的解法：把曲线烤进一个**假的 AnimSequence**（资产名 `StrafeOffsetCurveContainer`），然后用线程安全的 `Get Curve Value from Animation` 去采样。

代价是要做一次坐标换算：

```text
Calculate Direction( Normalize(Trj Future Velocity), OrientationIntent )
   → Direction  (-180 .. +180)
        ↓  Map Range Clamped
   In:  -180 .. 180        Out: 0 .. 8        ← 8 = 假动画的帧数
        ↓  ÷ 30                               ← 30 = 假动画的帧率
   Mapped Direction（单位：秒）
```

`8 帧 / 360°` 正好是**每帧 45°**，跟注释里 "each frame represents an angle at an increment of 45 degrees" 对上。除以 30 是因为 `Get Curve Value from Animation` 的 Time 参数收的是秒。

[![](/img/in-post/gasp-sm/06-strafe-yaw-offset-curve-select.png)](/img/in-post/gasp-sm/06-strafe-yaw-offset-curve-select.png)
<small class="img-hint">六个方向各有一条曲线，按 MovementDirection 选名字</small>

```text
Select( Index = MovementDirection )
  F  → "StrafeOffset_F"     B  → "StrafeOffset_B"
  LL → "StrafeOffset_LL"    LR → "StrafeOffset_LR"
  RL → "StrafeOffset_RL"    RR → "StrafeOffset_RR"
        ↓
Get Curve Value from Animation( StrafeOffsetCurveContainer, 曲线名, Mapped Direction )
        ↓
Return  （角度偏移）
```

**每个方向一条曲线**，因为"F 动画能被转多少度还看得过去"和"LL 动画能被转多少度"是不一样的。曲线是美术/TA 手调的，横轴是实际移动角度，纵轴是允许的旋转偏移。

> **这个 hack 要不要抄？** 如果你的项目也需要在线程安全上下文里查曲线，这确实是当前唯一干净的做法。替代方案是把曲线数据烤成 `TArray<float>` 存在 UDataAsset 里自己插值——更啰嗦，但没有"帧数/帧率"这种隐式耦合。GASP 这个写法有个真实风险：**改假动画的帧数或帧率，映射就会静默算错**。

---

# 第三部分：核心函数 SetBlendStackAnimFromChooser

Epic 自己的定位：

> This function is the heart of the Experimental State Machine Setup, and is called in all of the "OnStateEntry_" functions in the State Controller. Its job is to set properties on the Blend Stack (using the Blend Stack Inputs struct) from a chooser, and perform a single-frame motion match when needed. Whenever the Blend Stack Input's anim asset reference is changed, the Blend Stack will automatically trigger a blend to the new animation, using whatever blend parameters are currently input to the Blend Stack node via the struct.

最后一句是整套机制的基石：**Blend Stack 节点检测到 `AnimationAsset` 引脚的值变了，就自动起一次混合。** 你不需要调任何"播放"函数，只要改结构体里那个引用。

## 3.1 签名与骨架

[![](/img/in-post/gasp-sm/40-sbs-entry.png)](/img/in-post/gasp-sm/40-sbs-entry.png)
<small class="img-hint">两个入参 + 一个 4 路 Sequence</small>

```text
SetBlendStackAnimFromChooser( State Machine State : E_ExperimentalStateMachineState,
                              Force Blend         : bool )
  → Sequence [Then 0 .. Then 3]
```

四段的分工：

| Then | 做什么 | 为什么在这个顺序 |
|---|---|---|
| 0 | 写 `StateMachineState` | Chooser 要读它，必须最先写 |
| 1 | 缓存 `Previous_BlendStackInputs` | 必须在被覆盖前存 |
| 2 | 复位三个转换 bool | 必须在新决策前清干净 |
| 3 | Chooser → MM → 写 `BlendStackInputs` → 可能 ForceBlend | 主体 |

## 3.2 Then 0：状态即筛选条件

[![](/img/in-post/gasp-sm/41-sbs-set-state.png)](/img/in-post/gasp-sm/41-sbs-set-state.png)
<small class="img-hint">把入参写进成员变量</small>

> Set the "State Machine State" from the function's input. This is used within the chooser below to select the main category of animations to select from, and prevents us from needing a separate chooser for each state.

**一个 Chooser 服务全部状态**，靠的就是把状态本身当成一列筛选条件。这个决策很关键：

```text
❌ 每个状态一张 Chooser 表  → 13 张表，公共列改一次要改 13 遍
✅ 一张表 + State 列        → 1 张表，加状态只是加行
```

## 3.3 Then 1：缓存上一次的选择

[![](/img/in-post/gasp-sm/42-sbs-cache-previous.png)](/img/in-post/gasp-sm/42-sbs-cache-previous.png)
<small class="img-hint">Previous_BlendStackInputs = BlendStackInputs</small>

> Cache the previous "Blend Stack Inputs", which is effectively the previously selected animation with all of its metadata. Although currently unused, this could be used to do things like override blend times by comparing the current and previous tags.

**Epic 明说了当前没用**，但留了口子。设想的用法是"按前后两个动画的 Tag 组合决定混合时长"：

```text
从 Idle 的 Tag  →  Run 的 Tag    ：BlendTime 0.3（起步要软）
从 Run 的 Tag   →  Pivot 的 Tag  ：BlendTime 0.1（转向要脆）
```

这就是所谓 **transition matrix**（转换矩阵）的雏形。想做的话，`Previous_BlendStackInputs.Tags` 和 `ChooserOutputs.Tags` 一比就有了。

## 3.4 Then 2：为什么必须复位 bool

[![](/img/in-post/gasp-sm/43-sbs-reset-bools.png)](/img/in-post/gasp-sm/43-sbs-reset-bools.png)
<small class="img-hint">三个 bool 全部置 false</small>

> Reset various bools that are used in transitions. This makes sure that if one of these bools caused a transition into a state (which then calls this function from the "OnStateEntry_" function), these are reset, preventing them from triggering more than one transition.

```text
SET NoValidAnim = false
SET NotifyTransition_Re-Transition = false
SET NotifyTransition_ToLoop = false
```

这是**事件型 bool 的标准处理**。这三个 bool 的语义是"请求一次转换"，不是"当前处于某状态"。如果不在进入新状态时清掉：

```text
第 N 帧   ：NoValidAnim = true  → 触发 A→B 转换
第 N 帧末 ：进入 B，OnStateEntry_B 执行
第 N+1 帧 ：NoValidAnim 还是 true → 又触发 B→C 转换   ❌ 连环炸
```

> **可以直接抄的经验**：任何"用 bool 当一次性事件"的状态机，都必须在 `OnStateEntry` 里复位。放在 `OnStateExit` 不行——多条转换线出去时容易漏。

## 3.5 Then 3-①：Evaluate Chooser

[![](/img/in-post/gasp-sm/44-sbs-evaluate-chooser.png)](/img/in-post/gasp-sm/44-sbs-evaluate-chooser.png)
<small class="img-hint">Evaluate Chooser 同时吐出资产数组和输出结构体</small>

> Evaluate the chooser which contains all the animations for this character's locomotion. The chooser will output every animation that matches the selection criteria, along with an output struct which is used to select additional data such as blend times and tags. (**There is currently a limitation in choosers where even if it outputs an array of assets, only the first valid output struct will be output. This should be fixed in a future release**). If there are no valid animation, set the "No Valid Anim" condition to true, which will trigger a blend to the next state (if this function is called from a transition state).

```text
Evaluate Chooser: CHT_CMCCharacterAnimations
   Context Object = SandboxCharacter_CMC_ABP_C（self）
   ├─ Result           : Animation Asset[]   ──► SET ValidAnims
   └─ S_ChooserOutputs : struct              ──► SET ChooserOutputs
        ↓
   IS NOT EMPTY(ValidAnims) ?
        ├─ True  → 继续
        └─ False → SET NoValidAnim = true → Return（提前退出）
```

三个要点：

**① 输出的是数组，不是单个资产。** 这是这套设计能接上 Motion Matching 的前提——Chooser 做**粗筛**，MM 在粗筛结果里做**精选**。

**② Epic 亲口承认的引擎限制**：即使输出 N 个资产，**只有第一个有效的输出结构体会被返回**。也就是说 `BlendTime` / `BlendProfile` / `Tags` 这些元数据，全组候选共用第一行的。这在实践中的影响是：**同一个 MM 候选集里的动画，混合参数必须一致**，否则你会拿到错的那份。

**③ `NoValidAnim` 是"选不出来"的标准出口。** 不是报错，是转换条件。配合转换状态（transition state）就构成了自然的降级链：

```text
想播 Pivot → Chooser 无结果 → NoValidAnim=true → 退回 Locomotion Loop
```

## 3.6 Then 3-②：把结构体填好

[![](/img/in-post/gasp-sm/45-sbs-set-blend-stack-inputs.png)](/img/in-post/gasp-sm/45-sbs-set-blend-stack-inputs.png)
<small class="img-hint">Set members in S Blend Stack Inputs：一次写六个字段</small>

> If there is a valid animation, set the Blend Stack Inputs from the data output by the chooser. If multiple animations are output, only the first will be used unless overridden by a Motion Match.

```text
ValidAnims[0]                              ──► Anim
Is Animation Asset Looping(ValidAnims[0])  ──► Loop
ChooserOutputs.StartTime                   ──► Start Time
ChooserOutputs.BlendTime                   ──► Blend Time
Get Blend Profile by Name(ChooserOutputs.BlendProfile) ──► Blend Profile
ChooserOutputs.Tags                        ──► Tags
```

注意 `Loop` **不是**从 Chooser 读的，是从资产本身查的（`Is Animation Asset Looping`）。少一个可以填错的地方。

`Blend Profile` 在 Chooser 里存的是**名字（FName）**，运行时用 `Get Blend Profile by Name` 去骨骼上找。因为 Blend Profile 是 Skeleton 的子对象，Chooser 表里不方便直接持引用。

## 3.7 Then 3-③：单帧 Motion Matching

这是全套设计的精华。

[![](/img/in-post/gasp-sm/46-sbs-use-mm-branch.png)](/img/in-post/gasp-sm/46-sbs-use-mm-branch.png)
<small class="img-hint">只有 ChooserOutputs.UseMM 为真时才走 MM</small>

[![](/img/in-post/gasp-sm/47-sbs-motion-match-override.png)](/img/in-post/gasp-sm/47-sbs-motion-match-override.png)
<small class="img-hint">MotionMatch → 校验 → 覆盖 Anim / Start Time / Loop</small>

Epic 的注释很长，值得逐句拆：

> If the "Use MM" property on the chooser output struct is set to true (meaning an animation with this property set was selected by the chooser), perform a motion match on all the animations output by the chooser (could be one or many), and override the Blend Stack Inputs struct's properties based on the Motion Match result. **This allows us to use the chooser for broad animation selection, but still rely on motion matching to select animations and entry frames based on pose or trajectory, giving us lots of control.** If the "MM Cost Limit" property is greater than 0, then the best result must pass this threshold in order to be considered valid. In some cases this can be useful if we only want to pick the animation if it's a very close match. If motion matching fails to find a result (usually if an asset is set to use motion matching in the chooser but does not contain a "Branch In" notify state), or if the asset fails to pass the cost limit check, then we set NoValidAnim to true, and exit the function.

图上的接线：

```text
Motion Match( Anim Instance = self,
              Assets to Search = ValidAnims,
              Pose History Name = "PoseHistory" )
   → Break Pose Search Blueprint Result
        ├─ Selected Anim  ──► Cast To AnimationAsset ──► Success?
        ├─ Selected Time
        └─ Search Cost    ──► SET SearchCost

有效性 = AND(
    Cast Success ,
    Select( Index = (MMCostLimit > 0) ,
            True  = (SearchCost <= MMCostLimit) ,
            False = true )
)

Branch(有效性)
  True  ──► Set members in S Blend Stack Inputs(
                Anim       = SelectedAnim,
                Start Time = SelectedTime,
                Loop       = Is Animation Asset Looping(SelectedAnim) )
  False ──► SET NoValidAnim = true → Return
```

### 为什么叫"单帧"MM

跟方案 A 的区别就在这里：

| | 方案 A：Motion Matching 节点 | 方案 B：单帧 MM |
|---|---|---|
| 搜索频率 | **每帧**（受 `Pose Jump Threshold Time` 节流） | **只在状态进入时一次** |
| 搜索范围 | 整个 `PoseSearchDatabase` | Chooser 筛出来的 `ValidAnims` |
| 谁决定切换时机 | MM 自己（代价更低就跳） | **状态机的转换条件** |
| 播放由谁管 | 节点内建 Blend Stack | 外部独立 Blend Stack |

**结果是"决策权在你，选帧权给 MM"。** 状态机说"现在该播 pivot 了"，MM 说"那就播这条、从第 17 帧进，因为这一帧的脚位和你现在最像"。

### `MM Cost Limit` 的用法

```text
MMCostLimit == 0  → 不设门槛，MM 有结果就用
MMCostLimit >  0  → SearchCost 必须 ≤ 这个值，否则算失败
```

注释说的场景是 "only want to pick the animation if it's a very close match"。典型用途：**特殊过渡动画**。比如"从翻越落地接跑"这条动画，只有在落地姿态真的很接近时才用它，不接近就退回普通起步——用 Cost Limit 卡一刀，比写十条判断条件干净。

### MM 失败的头号原因

> usually if an asset is set to use motion matching in the chooser but does not contain a "Branch In" notify state

`MotionMatch` 的 `AssetsToSearch` 可以直接收**普通动画资产**（不必是 `PoseSearchDatabase`），但前提是那条动画上打了 **`Pose Search: Motion Matched Branch In`** 通知状态（`UAnimNotifyState_PoseSearchBranchIn`），并且该通知里指定了要用哪个 Database（提供 Schema 与索引数据）。

**没打 Branch In 的动画，MM 直接搜不到，静默失败，然后 `NoValidAnim = true`。** 这是这套方案最容易踩的坑，排查时先查通知。

[![](/img/in-post/gasp-sm/13-notify-states.png)](/img/in-post/gasp-sm/13-notify-states.png)
<small class="img-hint">GASP 动画上的通知状态：ExcludeFromDatabase / BlockTransition，加一串 FoleyEvent</small>

顺带认一下常见的三个 Pose Search 通知状态（引擎注释原文）：

| 通知状态 | 引擎注释含义 |
|---|---|
| `Pose Search: Motion Matched Branch In` | 把这段动画本身变成可被 `MotionMatch` 搜索的入点，并指定所属 Database |
| `Pose Search: Block Transition In` | 搜索**不会**返回落在这段区间里的结果，但已经在播的动画可以自然推进过去 |
| `Pose Search: Exclude From Database` | 彻底从数据库里剔掉这段，永远不会被搜到也不会播 |

图上那条动画的用法很典型：**开头 `ExcludeFrom...`（起始几帧不许作为入点）→ 中段 `BlockTransition`（这段不许跳进来）**，再叠一排 `FoleyEvent: Walk` 做脚步声。

## 3.8 Then 3-④：ForceBlend 与状态重入

这是解决"状态重入"问题的那一块，也是 Epic 说想拿这套原型验证的核心命题。

[![](/img/in-post/gasp-sm/48-sbs-force-blend.png)](/img/in-post/gasp-sm/48-sbs-force-blend.png)
<small class="img-hint">Convert to Blend Stack Node → Force Blend On Next Update</small>

> If the anim asset reference on the Blend Stack Inputs struct has changed, then the Blend Stack node will automatically trigger a blend to the new animation. However, if the chooser picks an anim asset that is already playing (such as doing the same pivot twice in a row), then we have to force the Blend Stack to re-blend into whatever is set in the struct. This ensures that whenever we call this function, we can always trigger a new blend, regardless of the current animation. The only time that we don't force a blend is on the looping states, since if we are already playing that loop, we don't need to re-blend into it. This can happen in rare instances if we are playing a loop, then try to play something like a pivot but no result is valid, so we transition back to the same looping animation.

问题的本质：**Blend Stack 是靠"引用变了"来触发混合的，那"引用没变但我想重播"怎么办？**

```text
连续两次同向 pivot：
   第 1 次：Anim = M_Pivot_L  （从 Loop 换过来 → 引用变了 → 自动混合 ✅）
   第 2 次：Anim = M_Pivot_L  （引用没变 → 不混合 → 动画继续往下播 ❌）
```

解法就是 `ForceBlendOnNextUpdate()`——手动置一个"下一帧强制混合"的标记。

**规则很简明：**

```text
ForceBlend = true   ← 所有过渡状态（Transition to Locomotion / Idle / Slide / InAir ...）
ForceBlend = false  ← 所有循环状态（Idle Loop / Locomotion Loop / InAir Loop / Slide Loop）
```

循环状态不强制的理由在注释最后一句：**从 Loop 出发想播 pivot 但选不到，`NoValidAnim` 把你退回同一个 Loop** ——这时如果强制重混，本来跑得很顺的循环动画会突然从头（或从 Chooser 给的 StartTime）重开，画面上是一个明显的抖动。

> **这就是"state re-entry"问题的完整解法**：把"是否需要重入"做成 `OnStateEntry` 的一个入参，由状态自己声明。传统状态机做不到这点——它的 `Transition` 只有"进/不进"，没有"进但重来一遍"。

---

# 第四部分：Chooser 表怎么组织

方案 B 的 Chooser 跟方案 A 不一样：方案 A 的 Chooser 输出的是 **Database**，方案 B 输出的是**动画资产数组 + 元数据结构体**。

## 4.1 三层嵌套

[![](/img/in-post/gasp-sm/12-chooser-root-table.png)](/img/in-post/gasp-sm/12-chooser-root-table.png)
<small class="img-hint">根表 CHT_MoverCharacterAnimations：按 State / Stance / Gait 分派到子表</small>

根表只做**粗分派**，三列条件：

| 列 | 类型 | 说明 |
|---|---|---|
| State Machine State | Enum (Or) | 可以一格里勾多个状态，如 `Idle Loop \| Transition to Idle Loop` |
| Stance | Enum Value | Stand / Crouch |
| Gait | Enum Value | Walk / Run / Sprint / Any |

行的 `Result` 全是**嵌套子表**：

```text
Stand Stopped   ← Idle Loop | Transition to Idle Loop        , Stand , Any
Stand Walks     ← Locomotion Loop | Transition to Locomotion , Stand , Walk
Stand Runs      ← 同上                                        , Stand , Run
Stand Sprints   ← 同上                                        , Stand , Sprint
Crouch Stopped  ← Idle 系                                     , Crouch, Any
Crouch Walks    ← Locomotion 系                               , Crouch, Any
In Air          ← In Air Loop | Transition to In Air          , Any   , Any
Slide           ← Transition to Slide | Slide Loop            , Any   , Any
```

注意 `Enum (Or)` 这一列的价值：**Loop 状态和进入该 Loop 的过渡状态共用同一个子表**。因为"走路循环"和"走路起步"用的是同一批资产，只是筛选条件不同——放一张表里，起步动画和循环动画的关系一眼可见。

再往下还有一层：`Stand Walks` 里按方向再分成 `Stand Walks F` / `B` / `L` / `R`。

## 4.2 叶子表长什么样

[![](/img/in-post/gasp-sm/10-chooser-stand-walks-f.png)](/img/in-post/gasp-sm/10-chooser-stand-walks-f.png)
<small class="img-hint">Stand Walks F：三列条件搞定循环 + 起步 + 四种转身 + 三种衔接</small>

列结构：

```text
Result | Enum(Or) State Machine State | Float Range Speed 2D | Float Range Future Facing Delta
```

行的读法（自上而下即优先级）：

| Result | State | Speed 2D | Future Facing Delta | 语义 |
|---|---|---|---|---|
| `M_Relaxed_Walk_Loop_F` | Locomotion Loop | 任意 | 任意 | 循环，兜底 |
| `Stand Walks F From Traversal`（子表） | Transition to Locomotion | ≥ 100 | -45 ~ 45 | 翻越后接走 |
| `Stand Walks F Lands`（子表） | Transition to Locomotion | 任意 | -130 ~ 130 | 落地后接走 |
| `Stand Walks F From Slide`（子表） | Transition to Locomotion | 任意 | -130 ~ 130 | 滑铲后接走 |
| `M_Relaxed_Walk_Start_F_Lfoot` | Transition to Locomotion | 0 ~ 100 | -45 ~ 0 | 起步·左脚 |
| `M_Relaxed_Walk_Start_F_Rfoot` | Transition to Locomotion | 0 ~ 100 | 0 ~ 45 | 起步·右脚 |
| `M_Relaxed_Walk_...Turn_090_L_Lfoot` | Transition to Locomotion | 0 ~ 100 | -130 ~ -45 | 起步 + 左转 90° |
| `M_Relaxed_Walk_...Turn_180_L_Lfoot` | Transition to Locomotion | 0 ~ 100 | ~ -130 | 起步 + 左转 180° |
| `M_Relaxed_Walk_...Turn_090_R_Rfoot` | Transition to Locomotion | 0 ~ 100 | 45 ~ 130 | 起步 + 右转 90° |
| `M_Relaxed_Walk_...Turn_180_R_Rfoot` | Transition to Locomotion | 0 ~ 100 | 130 ~ | 起步 + 右转 180° |
| `M_Relaxed_Trans_..._to_Walk_Lfoot` | Transition to Locomotion | ≥ 250 | -90 ~ 90 | 从跑降速接走·左脚 |
| `M_Relaxed_Trans_..._to_Walk_Rfoot` | Transition to Locomotion | ≥ 250 | -90 ~ 90 | 同上·右脚 |
| `M_Relaxed_Tran..._to_Walk_Lfoot` | Transition to Locomotion | ≥ 400 | -90 ~ 90 | 从冲刺降速接走 |

**这张表把方案 B 的可读性优势展示得很彻底。** 三条规律：

**① `Speed 2D` 区分"从静止起步"和"从高速降速"。** `0~100` 是起步，`≥250` 是从跑过来，`≥400` 是从冲刺过来。同一个逻辑状态（Transition to Locomotion），靠速度区间自动挑对应的衔接动画。

**② `Future Facing Delta` 区分"直着起步"和"转身起步"。** 这一列就是 2.3 节算出来的 `TargetRotationDelta`。角度区间 `±45 / ±130` 跟动画名里的 `090` / `180` 对得上——注意 90° 的动画覆盖 45°~130°，靠 Steering 的 Target Rotation 补齐差值（这就是 2.3 节那套设计在这里的落地）。

**③ 左右脚成对出现。** `Lfoot` / `Rfoot` 两行的条件几乎一样，靠 `Future Facing Delta` 的正负分开（`-45~0` vs `0~45`）。**同时两行都命中时会一起进 `ValidAnims`，然后交给 MM 按当前脚位选**——这就是 3.7 节说的"Chooser 粗筛、MM 精选"。

## 4.3 行的输出结构体

[![](/img/in-post/gasp-sm/11-chooser-row-details.png)](/img/in-post/gasp-sm/11-chooser-row-details.png)
<small class="img-hint">选中一行后的详情面板：上半是条件，下半是 S_ChooserOutputs</small>

条件部分除了表上可见的三列，还有几个隐藏列：

| 字段 | 值（此行） | 说明 |
|---|---|---|
| `IsPivoting` | Match False | 布尔列，要求当前不在 pivot |
| `Movement Direction Recent` | 0 元素 | "最近的移动方向"历史筛选，此行不用 |
| `Movement Mode Recent` | 1 元素 | "最近的移动模式"历史筛选 |
| `Disabled` | 未勾 | 整行开关，调试时可临时关掉 |

`*_Recent` 这类**历史列**很有意思：它筛的不是"当前是什么"，而是"刚才是什么"。用来做"刚落地"、"刚从滑铲出来"这类只在短窗口内成立的条件。

输出结构体 `S_ChooserOutputs`：

| 字段 | 此行的值 | 用途 |
|---|---|---|
| `StartTime` | 0.0 | 起始时间；被 MM 覆盖时无效 |
| `UseMM` | ✔ | 是否走单帧 Motion Matching |
| `MMCostLimit` | 0.0 | 0 = 不设代价门槛 |
| `Blend Time` | 0.2 | 混合时长 |
| `Blend Profile` | `FastFeet_FastRoot` | 混合曲线（按骨骼加权） |
| `Tags` | 1 元素 | 元数据标签，供转换规则和 3.3 的扩展用 |

`Blend Profile = FastFeet_FastRoot` 是个很实用的细节：**脚和 root 混合得快、上身混合得慢**。转身/起步这类动画，脚必须马上到位（否则滑步），上身可以慢慢摆过去（更自然）。这比全身统一 blend time 好得多。

> **回顾 3.5 节的引擎限制**：一整组 `ValidAnims` 只会拿到**第一行**的 `S_ChooserOutputs`。所以设计表的时候要保证**能同时命中的那几行，输出参数一致**。上面 Lfoot/Rfoot 那对就是这样——两行的 BlendTime/Profile/UseMM 完全一样，谁的输出被采纳都没关系。

---

# 第五部分：播放期的速率控制

选好动画只是开始，播放过程中还要让脚步跟得上位移。方案 A 靠 MM 节点返回的 `WantedPlayRate`，方案 B 得自己算。

## 5.1 Get_DynamicPlayRate 的整体思路

> This function is used to dynamically scale the play rate of the animation in the Blend Stack based on the capsule speed and speed curves baked into the animations.

原理一句话：**动画里烤了一条"这一帧我原本以多快的速度在动"的曲线，拿胶囊体实际速度去除它，就是需要的播放速率。**

```text
PlayRate = clamp( 实际速度 / 动画自带速度 , Min , Max )   然后按 alpha 曲线淡入淡出
```

这就是 **Play Rate Warping**（速率扭曲）。跟 Stride Warping（步幅扭曲）解决同一个问题——脚滑——但手段不同：一个改播放速度，一个改骨骼位置。前者不破坏动画本身，后者对速度差异大的情况更有效。GASP 两个都用。

## 5.2 入口与保底

[![](/img/in-post/gasp-sm/50-gdpr-entry.png)](/img/in-post/gasp-sm/50-gdpr-entry.png)
<small class="img-hint">取当前资产与时间；不是 AnimSequence 就直接返回 1.0</small>

```text
Get Current Blend Stack Anim Asset( BlendStackInput )
   → Cast To AnimSequence
        ├─ Cast Failed ──► Return 1.0
        └─ 成功 ──► SET AnimSequence
Get Current Blend Stack Anim Asset Time( BlendStackInput ) ──► SET AnimTime
   → Sequence [Then 0 .. Then 4]
```

**注意入参是 `Blend Stack Input`（Anim Node Reference）**，不是资产引用。这个函数是作为 Blend Stack 节点的**引脚绑定**（Property Access）调用的，能直接问节点"你现在在播什么、播到第几秒"。

Cast 失败（比如是 BlendSpace）就返回 1.0——**整个函数有四处"查不到就返回 1.0"的保底**，这是很好的防御式写法：曲线缺失不会让角色速率乱飞，只是退化成不做 warping。

## 5.3 Alpha 曲线：可以在动画内部开关

[![](/img/in-post/gasp-sm/51-gdpr-alpha-curve.png)](/img/in-post/gasp-sm/51-gdpr-alpha-curve.png)
<small class="img-hint">Enable_Warping 曲线当 alpha 用</small>

> Cache the value of the Enable_PlayRateWarping curve at the current frame of the animation. This acts as an alpha, allowing us to smoothly enable and disable rate warping at different points in an animation. If the curve is not found on the animation, then return a Play Rate of 1.

```text
Get Curve Value from Animation( AnimSequence, "Enable_Warping", AnimTime )
   ├─ 找到 ──► SET AlphaCurve = OutValue
   └─ 没找到 ──► Return 1.0
```

> **注释与实现不一致**：注释写的曲线名是 `Enable_PlayRateWarping`，图上节点里填的是 **`Enable_Warping`**。以图为准。

**"alpha 而不是 bool"这个选择很关键。** 一条 0→1 的曲线让 warping 可以在动画内部平滑开关：

```text
起步动画：前 10 帧 alpha=0（推地阶段不许改速率，改了推力感就没了）
          之后渐变到 1（进入循环，开始跟速）
落地动画：着地瞬间 alpha=0，缓冲结束后升到 1
```

用 bool 的话开关那一帧速率会跳变，肉眼可见。

## 5.4 速度曲线

[![](/img/in-post/gasp-sm/52-gdpr-speed-curve.png)](/img/in-post/gasp-sm/52-gdpr-speed-curve.png)
<small class="img-hint">MoveData_Speed：动画自带的速度</small>

> Cache the value of the speed curve at the current frame of the animation. If the curve is not found on the animation, then return a Play Rate of 1.

```text
Get Curve Value from Animation( AnimSequence, "MoveData_Speed", AnimTime )
   ├─ 找到 ──► SET SpeedCurve
   └─ 没找到 ──► Return 1.0
```

这条曲线是**烤出来的**，不是手画的。GASP 有工具从 root motion 提取每帧的水平速度写成曲线。可以在动画编辑器里看到它：

[![](/img/in-post/gasp-sm/14-anim-curves.png)](/img/in-post/gasp-sm/14-anim-curves.png)
<small class="img-hint">一条 GASP 动画上的曲线：contact_l / contact_r / movedata_speed / steeringtargettime / enable_turninplacesteering</small>

顺便认一下这几条曲线的分工，都是"把美术信息传给运行时"的通道：

| 曲线 | 用途 |
|---|---|
| `movedata_speed` | 本文的速率扭曲基准 |
| `contact_l` / `contact_r` | 左右脚触地时机，供 Foot Placement / Foley 用 |
| `steeringtargettime` | 告诉 Steering 节点"到这个时间点应该转到位" |
| `enable_turninplacesteering` | 原地转身时才启用 steering 的开关 |

> **这是 GASP 一个贯穿性的设计模式**：所有"这段动画有什么特性"的信息，都通过**曲线**（连续量）或**通知**（离散事件）写在资产上，而不是写在蓝图里的资产名判断里。加动画不用改代码。

## 5.5 上下限也可以按帧变

[![](/img/in-post/gasp-sm/53-gdpr-min-max-curves.png)](/img/in-post/gasp-sm/53-gdpr-min-max-curves.png)
<small class="img-hint">MaxDynamicPlayRate / MinDynamicPlayRate 缺失时回落到 1.25 / 0.75</small>

> Set the min and max values of the play rate using curves on the animation. If the curves are not present, use a standard default of Max: 1.25 and Min .75. Currently the only animations that use the min and max curves are some of the backwards run animations, as they don't look good if rate scaled too fast.

```text
"MaxDynamicPlayRate" 找到 → SET Max = OutValue ；否则 SET Max = 1.25
"MinDynamicPlayRate" 找到 → SET Min = OutValue ；否则 SET Min = 0.75
```

**默认 ±25% 是个很实用的经验值。** 超过这个范围，人眼就能看出"这个人被快放/慢放了"。

注释里点名了唯一的例外：**部分后退跑动画**。后退跑本来就别扭，稍微加速就更假，所以单独给了更紧的上限。这种"个别动画需要特殊参数"的需求，用曲线解决而不是在蓝图里 `if (assetName == ...)`，是正确的做法。

## 5.6 最终计算

[![](/img/in-post/gasp-sm/54-gdpr-divide-clamp-lerp.png)](/img/in-post/gasp-sm/54-gdpr-divide-clamp-lerp.png)
<small class="img-hint">Safe Divide → Clamp → Lerp</small>

> Divide the current speed of the capsule by the current speed of the animation to determine how much the animation should be rate-scaled, and clamp the result using the min and max values. Finally, use the alpha curve to blend in or out of the calculated rate.

```text
Clamp( SpeedCurve , 1.0 , 999.0 )        ← 分母保护，防止近 0 除
        ↓
Safe Divide( A = Speed 2D , B = 上面的值 )
        ↓
Clamp( Min Dynamic Play Rate , Max Dynamic Play Rate )
        ↓
Lerp( A = 1.0 , B = 上面的值 , Alpha = AlphaCurve )
        ↓
Return
```

**两层除零保护**：先把分母 clamp 到 `[1.0, 999.0]`，再用 `Safe Divide`。动画速度曲线在起步的前几帧本来就接近 0，没有这层保护会直接产生天文数字的播放速率。

`Lerp(1.0, rate, alpha)` 的写法值得注意：**alpha=0 时结果是 1.0（正常速率），不是 0**。这是"关闭 warping"的正确语义。

---

# 第六部分：状态机的图、回调与转换配置

这一部分回答三个问题：**这个逻辑状态机长什么样**、**回调里干了什么**、**Details 面板那堆开关为什么有的勾有的不勾**。

## 6.1 状态机全图

先看三个状态组。

[![](/img/in-post/gasp-sm/60-sm-idle-states.png)](/img/in-post/gasp-sm/60-sm-idle-states.png)
<small class="img-hint">Idle States：Entry → Transition to Idle → Idle Loop，Idle Loop 与 Idle Break 互跳（91% / 9%）</small>

```text
Entry ─────────────────────► Transition to Idle ──► Idle Loop ⇄ Idle Break
Locomotion -> Idle ────────►        ▲
-> Grounded ──► Conduit ───►        │
                              Re-Enter（自转换，两条规则）
```

[![](/img/in-post/gasp-sm/61-sm-locomotion-states.png)](/img/in-post/gasp-sm/61-sm-locomotion-states.png)
<small class="img-hint">Locomotion States：结构一致，但 Re-Enter 上挂了四条规则</small>

```text
Idle -> Locomotion ──► Transition to Locomotion ──► Locomotion Loop
                              ▲
                       Re-Enter（自转换，四条规则）
```

[![](/img/in-post/gasp-sm/62-sm-in-air-states.png)](/img/in-post/gasp-sm/62-sm-in-air-states.png)
<small class="img-hint">In Air States：最简形态，没有 Re-Enter</small>

**三个共同的模式：**

**① 每个状态组都是"过渡状态 + 循环状态"两个一对。** `Transition to X` 负责播一次性动画（起步 / 落地 / 转身），`X Loop` 负责循环。所有 `OnStateEntry` 都是给这两类状态写的。

**② 用 Conduit 做多入口汇聚。** `-> Grounded` 这条外部转换先进 Conduit，再由 Conduit 分派到 Idle 或 Locomotion。Conduit 不持有姿态、不做混合，只透传条件——引擎里它有一条额外的 entry rule，必须先为真才会考虑经由它的任何转换。

**③ `Re-Enter` 是自转换（self transition）。** 这个胶囊节点的箭头指回它自己所在的那个过渡状态。它是这整套方案里最关键的一个机制，也是下面 6.9 / 6.10 两节的主角。注意 Locomotion 侧挂了**四条**规则（图上四个叠起来的箭头图标），Idle 侧两条，In Air 一条都没有——复杂度差异一眼可见。

## 6.2 OnStateEntry：最简形态


[![](/img/in-post/gasp-sm/55-onstateentry-idleloop.png)](/img/in-post/gasp-sm/55-onstateentry-idleloop.png)
<small class="img-hint">OnStateEntry_IdleLoop：一个节点，两个参数</small>

```text
OnStateEntry_IdleLoop
  └─► Set Blend Stack Anim from Chooser( State = Idle Loop , Force Blend = ☐ )
```

**循环状态的 `Force Blend` 不勾**（原因见 3.8）。整个函数就这一个节点——状态机侧的代码量极小，全部逻辑都在那个共用函数里。

## 6.3 OnStateEntry：过渡状态要多存一个快照

[![](/img/in-post/gasp-sm/56-onstateentry-transition-to-locomotion.png)](/img/in-post/gasp-sm/56-onstateentry-transition-to-locomotion.png)
<small class="img-hint">OnStateEntry_TransitionToLocomotion：先存 TargetRotationOnTransitionStart，再选动画，Force Blend 勾上</small>

```text
OnStateEntry_TransitionToLocomotion
  ├─► SET TargetRotationOnTransitionStart = TargetRotation
  └─► Set Blend Stack Anim from Chooser( State = Transition to Locomotion Loop ,
                                         Force Blend = ☑ )
```

两处差异：

**① 先存 `TargetRotationOnTransitionStart`。** 这是"进入这次过渡时，我原本打算朝哪转"的快照。因为过渡动画（起步 / 转身）**播到一半玩家可能改主意**，需要拿"当初的目标"和"现在的目标"比。

**② `Force Blend` 勾上。** 过渡动画必须每次都从头（或 MM 指定的入点）重新混合进来，连续两次同向 pivot 才不会失效。

## 6.4 OnUpdate：把快照慢慢追上来

这是全套里唯一的 `OnUpdate_` 函数。

[![](/img/in-post/gasp-sm/57-onupdate-transition-to-locomotion.png)](/img/in-post/gasp-sm/57-onupdate-transition-to-locomotion.png)
<small class="img-hint">OnUpdate_TransitionToLocomotion：RInterpTo，速度 5.0</small>

> This value is used in a transition condition that handles the "breaking" of a rotational start or pivot animation.

```text
每帧：
  TargetRotationOnTransitionStart =
      RInterpTo( Current    = TargetRotationOnTransitionStart ,
                 Target     = TargetRotation ,
                 Delta Time = GetDeltaSeconds() ,
                 Interp Speed = 5.0 )
```

单看这行代码会觉得莫名其妙——**为什么要让"开始时的快照"慢慢变成"当前值"？** 因为这个变量真正的用途不是记录历史，而是**度量分歧**：

```text
两者差值 = |TargetRotation - TargetRotationOnTransitionStart|

差值小  → 玩家的意图没变，转身动画照播
差值大  → 玩家在转身动画播到一半时又改了方向
          → 转换条件成立 → "打断"（break）当前过渡，重新选一条
```

而 `RInterpTo(速度 5.0)` 的作用是**让这个分歧随时间自然衰减**：

```text
刚进入过渡时：快照 = 当前值，差值 = 0
玩家立刻反打：差值瞬间变大 → 立刻打断 ✅（响应快）
玩家慢慢绕圈：差值涨得比衰减慢 → 不打断 ✅（不会碎成一堆过渡）
过渡播了一会儿：快照已经追上来，差值回到 0 → 不会因为陈旧数据误判 ✅
```

> **这是一个低通滤波器（low-pass filter）**，只不过写在动画蓝图里。`RInterpTo` + "和实时值比差"这个组合，是"检测突变、忽略缓变"的通用手法，比"记住 N 帧前的值再比"稳定得多，也不用存历史。插值速度 5.0 大约对应 200ms 的时间常数。

## 6.5 IsAnimationAlmostComplete：过渡状态的自然出口

[![](/img/in-post/gasp-sm/07-is-animation-almost-complete.png)](/img/in-post/gasp-sm/07-is-animation-almost-complete.png)
<small class="img-hint">非循环 且 剩余时间 ≤ 0.75s</small>

> This function is used in the State Controller to trigger a blend whenever the currently playing animation is nearing its end. At the moment we are using a fixed value of .75 seconds, since all of our transition animations have long "tails". This may need to be adjusted for shorter animation. This value could also be set by adding to the chooser outputs, so that each animation could specify how far from the end should a transition be triggered.

```text
Convert to Blend Stack Node( State Machine Blend Stack )
   ├─ Is Current Asset Looping ──► NOT ─────┐
   └─ Get Current Asset Time Remaining      │
              ↓                             │
         ( ≤ 0.75 ) ──────────────────► AND ──► Return
```

三个要点：

**① 只对非循环动画成立。** 循环动画永远没有"快播完"。

**② `0.75s` 这个魔数是为"长尾巴"动画服务的。** GASP 的过渡动画末尾都有一段收尾（脚落稳、身体归位），这段可以被下一个动画混掉，不必播完。提前 0.75s 起混合，衔接感明显更好。

**③ Epic 自己给出了改进方向**：把这个值加进 `S_ChooserOutputs`，让每条动画自己声明。**如果你要把这套方案往产品化推进，这是第一个该改的地方**——用固定值意味着所有过渡动画的尾巴必须一样长。

这个函数配合 `NoValidAnim`，构成了过渡状态的出口（下一节会看到还有第三个）：

```text
过渡状态 ──┬── IsAnimationAlmostComplete → 正常打完，进 Loop
           └── NoValidAnim               → 一开始就选不出来，直接退回
```

## 6.6 转换规则总览

这个状态机上的规则一共五类，全部只读变量、不产生副作用：

| # | 规则 | 挂在哪 | 作用 |
|---|---|---|---|
| ① | `IsAnimationAlmostComplete AND StateTime > 0` | 过渡 → 循环 | 手写的 Automatic Rule |
| ② | `NoValidAnim OR BlendStackInputs.Loop` | 过渡 → 循环 | 跳过过渡，直奔循环 |
| ③ | `Stance != StanceLastFrame AND StateTime > 0` | Idle 的 Re-Enter | 状态量变了，重选 |
| ④ | `(Dir\|Stance\|Gait 任一变) AND StateTime > 0` | Locomotion 的 Re-Enter | 同上 |
| ⑤ | `IsPivoting / ShouldTurnInPlace + 条件化时间门槛` | Re-Enter | 特殊动作重触发 |

**注意每条规则里都有一个 `Current State Time > X`**——这不是可选的装饰，是这套自转换机制能跑起来的必要条件，6.9 节讲原因。

## 6.7 ①：手写 Automatic Rule

[![](/img/in-post/gasp-sm/63-rule-animation-almost-complete.png)](/img/in-post/gasp-sm/63-rule-animation-almost-complete.png)
<small class="img-hint">过渡状态 → 循环状态：IsAnimationAlmostComplete AND CurrentStateTime > 0.0</small>

> This acts similar to the "Automatic Rule" condition in typical state machines, which triggers the transition automatically whenever the animation is almost over. Since this state machine is purely logical and contains no animations, we need to do this manually by looking at the current animation in the blendstack.

**这段注释解释了 Details 面板里两个字段为什么是关着的：**

```text
Automatic Rule Based on Sequence Player in State  →  ☐ 未勾
Automatic Rule Trigger Time                       →  -1.0 s（关闭）
```

引擎自带的 Automatic Rule 是这么工作的（引擎注释原文）：

> Try setting the rule automatically based on **most relevant asset player node's remaining time** and the Automatic Rule Trigger Time of the transition

关键词是 **asset player node**。这个状态机的状态里**一个 sequence player 都没有**（姿态在外面的 Blend Stack 上），所以引擎找不到任何 asset player，Automatic Rule 直接失效。只能手写：去问 Blend Stack "你现在播的那条还剩多久"（6.5 节）。

> **这是"状态机不出姿态"这个设计付出的第一个代价**：所有依赖"状态内部有动画"的引擎特性全部失效——Automatic Rule、Sync Group、状态自身的动画通知，都得自己补。

## 6.8 ②：选不到，或者循环动画赢了

[![](/img/in-post/gasp-sm/64-rule-novalidanim-or-loop.png)](/img/in-post/gasp-sm/64-rule-novalidanim-or-loop.png)
<small class="img-hint">NoValidAnim OR BlendStackInputs.Loop</small>

> If no animations were found when entering into the transition state, this transition takes us straight to the looping state.
>
> In addition, if a looping animation was chosen when searching for transition animations, then that should force us into the looping state. **This allows us to do things like perform a motion match between a transition and a looping animation. If the looping animation wins, we enter into the looping state.**

第一句就是 3.5 节那个降级出口。**第二句是新东西，很妙：**

```text
Chooser 输出 = [ 起步动画A , 起步动画B , 循环动画 ]   ← 三条一起进 ValidAnims
        ↓  单帧 MM 在三条里搜
若循环动画的代价最低（当前姿态已经很像跑起来的样子）
        ↓  BlendStackInputs.Loop == true
规则 ② 成立 → 状态机立刻从"过渡状态"转到"循环状态"
```

**这等于让 Motion Matching 去决定"这次到底要不要播过渡动画"。** 起步的时候如果角色姿态已经接近跑动中段（比如从翻越落地下来），那就没必要再播一遍起步——直接进循环更自然。

注意这里状态机和 Blend Stack 的分工：**Blend Stack 已经在播循环动画了，状态机只是把自己的逻辑状态改成一致**。规则 ② 不是"去播循环"，而是"承认已经在播循环了"。这种"状态跟随实际播放内容"的写法，只有在姿态与状态解耦之后才可能。

## 6.9 ③④⑤：Re-Enter 自转换

三条规则的形状一样：**"某个决策输入变了" AND "当前状态已经跑了一会儿"**。

### ③ Idle：Stance 变了

[![](/img/in-post/gasp-sm/65-rule-idle-state-changed.png)](/img/in-post/gasp-sm/65-rule-idle-state-changed.png)
<small class="img-hint">Stance != Stance Last Frame AND CurrentStateTime > 0.0</small>

> If any of these states have changed, we know we need to reselect an idle animation. Therefore, transition to (or re-start) the "Transition to Idle Loop" state.
>
> Checking to see if the current state time is greater than 0 prevents this transition from firing multiple times per frame.

### ④ Locomotion：方向 / 姿态 / 步态 任一变了

[![](/img/in-post/gasp-sm/66-rule-locomotion-state-changed.png)](/img/in-post/gasp-sm/66-rule-locomotion-state-changed.png)
<small class="img-hint">三组 != 取 OR，再 AND 上时间门槛</small>

```text
( MovementDirection != MovementDirectionLastFrame )
OR ( Stance != StanceLastFrame )
OR ( Gait   != GaitLastFrame )
AND ( CurrentStateTime > 0.0 )
```

**`xxxLastFrame` 这批变量的用途终于闭环了**：2.1 节存了 `MovementDirectionLastFrame`，就是给这条规则用的。方向从 F 变成 LL，说明该换一批方向动画了 → 重入过渡状态 → 重跑一次 Chooser + MM。

### ⑤ Pivot：条件化的时间门槛

[![](/img/in-post/gasp-sm/67-rule-pivoting.png)](/img/in-post/gasp-sm/67-rule-pivoting.png)
<small class="img-hint">IsPivoting AND CurrentStateTime > ( Tags 含 Pivot/Start ? 0.5 : 0.0 )</small>

> If "Is Pivoting" is true, and we are not playing the beginning of a pivot or start animation, then transition into the "Transition to Locomotion Loop" state. Since "Is Pivoting" is also used in the chooser, a pivoting animation will likely be chosen.
>
> If other conditions in the chooser prevent a pivot from being chosen, or no pivot animation is found, then the transition state will be skipped. **HOWEVER, as long as the "Is Pivoting" condition is true and no pivot animation is playing, this transition will trigger once per frame, allowing a pivot to be selected if conditions change on subsequent frames.**

```text
门槛 = Select( Index = Tags.Contains("Pivot") OR Tags.Contains("Start") ,
               True  = 0.5 ,      ← 正在播 pivot/start：至少让它播 0.5s 再考虑重触发
               False = 0.0 )      ← 没在播：立刻可以触发
条件 = IsPivoting AND ( CurrentStateTime > 门槛 )
```

**加粗那句是这套机制最强的一点：自转换变成了一个每帧重试的循环。**

```text
第 N 帧  ：IsPivoting=true → 重入过渡状态 → Chooser 选不到 pivot
          → NoValidAnim=true → 规则② 把你退回 Locomotion Loop
第 N+1 帧：IsPivoting 还是 true，Loop 里没在播 pivot（门槛=0.0）
          → 再重入一次 → 再试一次
...
第 N+k 帧：速度/角度终于进了某一行的区间 → 选到了 → 真的播出来
```

**这是"持续尝试直到条件满足"，而不是"错过就算了"。** 传统状态机做这件事要么加一个"等待"状态，要么在转换条件里塞一堆容错。这里靠"自转换 + NoValidAnim 立刻退回"两条规则就实现了，而且完全没有额外状态。

代价是**每帧都在跑 Chooser + 单帧 MM**——性能上不能算便宜。真要上产品，得给这个重试加节流（比如按 0.05s 间隔）。

### ⑤' TurnInPlace：同样的形状

[![](/img/in-post/gasp-sm/68-rule-turn-in-place.png)](/img/in-post/gasp-sm/68-rule-turn-in-place.png)
<small class="img-hint">ShouldTurnInPlace AND CurrentStateTime > ( Tags 含 TurnInPlace ? 0.75 : true )</small>

> This transition is very similar to the pivot transition in the locomotion states. If "Should Turn in Place" is true, and we are not playing the beginning of a TurnInPlace animation, then transition into the "Transition to Idle Loop" state. Since "ShouldTurnInPlace" is also used in the chooser, a turn in place animation will be chosen.
>
> If we play more than .75 seconds of a turn, and "Should Turn in Place" is still true, then we should re-trigger a turn in place animation. At the moment, all of our turn in place animations have a similar turning duration, which lets us use a fixed time.

```text
条件 = ShouldTurnInPlace AND
       Select( Index = Tags.Contains("TurnInPlace") ,
               True  = CurrentStateTime > 0.75 ,   ← 已经在转：转够 0.75s 才允许再转一次
               False = true )                      ← 没在转：立刻可以转
```

语义是"**转身没转够就再来一次**"：一次转身动画大约转 90°，玩家要转 180° 就需要连着触发两次。`Tags` 里的 `TurnInPlace` 标记让规则能问"我现在是不是正在转"——**这就是 3.6 节把 `Tags` 写进 `BlendStackInputs` 的用处**，转换规则拿它当"当前在播什么类别"的判据，不用去比对资产名。

注意 Epic 自己标了这里的妥协：*"all of our turn in place animations have a similar turning duration, which lets us use a fixed time"*——`0.75` 这个数字只在"所有转身动画时长接近"的前提下成立。跟 6.5 节的 `0.75` 一样，正确做法是加进 `S_ChooserOutputs` 让每条动画自己声明。

## 6.10 关键配置：Allow Inertialization for Self Transitions

这是本节最值得讲清楚的一个开关。先看两张 Details 面板的对比。

[![](/img/in-post/gasp-sm/69-transition-details-self-inertialization.png)](/img/in-post/gasp-sm/69-transition-details-self-inertialization.png)
<small class="img-hint">Re-Enter 上的 "Idle - State Changed" 规则：Allow Inertialization for Self Transitions ✔ 勾上</small>

[![](/img/in-post/gasp-sm/70-transition-details-almost-complete.png)](/img/in-post/gasp-sm/70-transition-details-almost-complete.png)
<small class="img-hint">"General - Animation Almost Complete" 规则：同一个开关 ☐ 不勾</small>

```text
规则 Idle - State Changed           →  Allow Inertialization for Self Transitions = ✔
规则 General - Animation Almost Complete →  同一个开关 = ☐
```

### 引擎里它到底是什么

`Engine/Source/Editor/AnimGraph/Public/AnimStateTransitionNode.h`：

```cpp
/** Whether to fall back to inertialization/dead blending when reentering an already-active state.
    This can avoid pops.
    The target state must enable bAlwaysResetOnEntry for the inertial blend to trigger. */
UPROPERTY(EditAnywhere, Category="Transition|Experimental")
bool bAllowInertializationForSelfTransitions;
```

**默认 `false`**（`AnimStateTransitionNode.cpp` 里注释写明 `// Defaults to false`，为了保持旧行为）。

从名字看它像个"混合方式"的开关，但**它真正的第一个作用是"准不准转"**。`AnimNode_StateMachine.cpp` 里找有效转换的地方：

```cpp
// If transition is valid and not waiting on other conditions
// and we're not doing a transition to self, unless the self-transition can inertialize
if (PotentialTransition.TargetState != CurrentState
    || ReferenceTransition.bAllowInertializationForSelfTransitions)
{
    return true;
}
return false;
```

翻译：**目标状态 == 当前状态（也就是自转换）时，这个开关不勾，转换直接被拒。**

第二个作用才是名字说的那件事——真的重入了、并且目标状态权重还大于 0、并且目标状态勾了 `Always Reset on Entry` 时，向上游发一个 `RequestInertialization`，用惯性混合盖掉硬重置造成的 pop。

### 所以为什么有的勾有的不勾

答案很干脆：**看这条转换是不是自转换。**

| 转换 | 源 → 目标 | 自转换？ | 开关 | 原因 |
|---|---|---|---|---|
| `Idle - State Changed`（Re-Enter） | `Transition to Idle` → **它自己** | ✅ 是 | **必须 ✔** | 不勾的话这条规则永远不会生效 |
| `Locomotion - State Changed`（Re-Enter） | `Transition to Locomotion` → **它自己** | ✅ 是 | **必须 ✔** | 同上 |
| `IsPivoting` / `ShouldTurnInPlace`（Re-Enter） | 同上 | ✅ 是 | **必须 ✔** | 同上 |
| `General - Animation Almost Complete` | `Transition to X` → `X Loop` | ❌ 不是 | **☐ 无所谓** | 普通 A→B，引擎根本不看这个开关 |
| `NoValidAnim OR Loop` | `Transition to X` → `X Loop` | ❌ 不是 | **☐ 无所谓** | 同上 |

**不是"勾上更好、不勾更省"，而是"自转换必须勾，非自转换勾了也没用"。** 留 `false` 是保持默认值，等于显式声明"这条不是自转换"。

> **一句话记住**：`Allow Inertialization for Self Transitions` 是 UE 里**开启"状态重入"能力的唯一开关**。它的名字只描述了副作用（惯性混合），没描述主作用（放行自转换）——这是个容易踩的命名坑。

### 为什么这里的惯性混合是"顺带的"

回头看 1.1 节的 AnimGraph：状态机的姿态被 Two Way Blend 丢掉了，**所以自转换触发的惯性混合对画面毫无影响**——真正的混合发生在 Blend Stack 上（3.8 节的 `ForceBlendOnNextUpdate`）。

也就是说 **GASP 用这个开关，只用它的"放行"作用，不用它的"混合"作用。**

那 AnimGraph 里那个 `Inertialization` 节点（`State Controller → Inertialization → Two Way Blend[A]`）是干什么的？**推断**：引擎在找不到上游 `IInertializationRequester` 时会打错误日志（`LogInertializationRequestError`）。自转换每帧都可能发请求，挂一个 Inertialization 节点在那里把请求接住，即使姿态被丢弃也不会刷日志。**这是那个"看起来多余的节点"的合理解释**——如果你照搬这套结构却把它删了，可能会看到 Inertialization 相关的报错。

### 顺带解释 `Current State Time > 0` 为什么管用

自转换成立时，引擎走的是 `SetState(..., bAllowReEntry = true)` 这条路，里面会**重置状态的 elapsed time**（并按需重新 `Initialize` 状态、重跑 `OnStateEntry`）。所以：

```text
重入发生的那一帧 → CurrentStateTime 归 0 → 规则里的 ( > 0.0 ) 为假 → 当帧不会再次触发
下一帧          → CurrentStateTime > 0 → 条件重新可用
```

Epic 注释说的 *"prevents this transition from firing multiple times per frame"* 就是这个机制。**它同时也是 6.9 节⑤那个"每帧重试一次"的节拍来源**——一帧最多重入一次，不会同一帧里死循环。

> **等价写法**：Details 面板里的 `Min Time Before Re-entry` 设成 `0` 也能达到"至少等一帧"（引擎注释：*When set to zero, wait at least one frame before re-entry via this transition is allowed*）。GASP 没用它而是手写时间比较，原因是**门槛需要按条件变**（0 / 0.5 / 0.75），一个常量表达不了。

## 6.11 关键配置：Transition Notifications

[![](/img/in-post/gasp-sm/71-notifications-to-idle.png)](/img/in-post/gasp-sm/71-notifications-to-idle.png)
<small class="img-hint">Transition Start = "Transition: To Idle"，End 与 Interrupt 都是 None</small>

[![](/img/in-post/gasp-sm/72-notifications-locomotion-to-idle.png)](/img/in-post/gasp-sm/72-notifications-locomotion-to-idle.png)
<small class="img-hint">另一条：Transition Start = "Transition: Locomotion To Idle"</small>

### 引擎里的三个字段

```cpp
UPROPERTY(EditAnywhere, Category=Events) FAnimNotifyEvent TransitionStart;
UPROPERTY(EditAnywhere, Category=Events) FAnimNotifyEvent TransitionEnd;
UPROPERTY(EditAnywhere, Category=Events) FAnimNotifyEvent TransitionInterrupt;
```

它们编译时会被烤成通知索引，运行时通过 `AddAnimNotifyFromGeneratedClass()` 丢进**和普通动画通知同一个 `NotifyQueue`**。也就是说它们就是标准 AnimNotify——可以用 `AnimNotify_<名字>` 事件或 Event Graph 节点接住，也会出现在 Rewind Debugger 的时间轴上。

三者的触发时机（引擎源码 `AnimNode_StateMachine.cpp`）：

| 通知 | 什么时候发 |
|---|---|
| **Start** | 转换开始时（与状态自身的 Entry/Exit 通知一起发） |
| **Interrupt** | **上一条还没混完的转换**被新转换取代时，发给**被取代的那条** |
| **End** | 该转换混合真正结束、且它是栈里最新的一条时 |

### 为什么只填了 Start

**① 因为这是这个状态机唯一能对外发的事件。** 状态里没有动画（6.7 节），所以拿不到任何动画通知；`FoleyEvent`、`contact_l/r` 这些都挂在 Blend Stack 播的资产上，跟状态机无关。**转换通知是逻辑状态机与外部世界之间唯一的事件出口。**

**② 命名带前缀是刻意的。** `Transition: To Idle` / `Transition: Locomotion To Idle` ——加 `Transition:` 前缀是为了在 Event Graph 的通知列表和 Rewind Debugger 时间轴里一眼区分"这是状态机发的"而不是"动画发的"。名字全局唯一，所以必须把源状态写进去（`Locomotion To Idle` vs `To Idle`）。

**③ End 在这里没有意义。** `End` 的语义是"这条转换的**混合**结束了"。但这个状态机的混合是虚的——姿态被 Two Way Blend 丢掉，画面上真正的混合由 Blend Stack 按自己的 `BlendTime` 走，两者时间线不同步。**订阅一个和画面无关的时间点没有价值**，所以留 None。

**④ Interrupt 语义容易误解，且这里用不上。** 它不是"状态被打断"，而是"这条转换的混合还没走完就被更新的转换顶掉了"。在这套设计里，转换本身是瞬时的逻辑动作，"混合被顶掉"不对应任何需要处理的情况。

**⑤ 留 None 是有实际收益的**：没填的通知不会入队，省掉一次通知分发。虽然单次开销很小，但这个状态机每帧都可能重入（6.9 节），累积起来不算噪音。

> **想用起来的话**，Start 通知是很好的挂钩点：切镜头、播音效（起步的布料声）、给 gameplay 发"角色开始移动了"。**注意它在动画线程队列里排队、在游戏线程分发**，所以适合做"通知型"逻辑，不适合做需要同帧生效的判断。

## 6.12 其余配置项速查

Details 面板里剩下的字段，配合引擎注释一次看完（引号内为引擎原文）：

| 字段 | GASP 的值 | 引擎语义 / 为什么是这个值 |
|---|---|---|
| `Priority Order` | `1` | *"the one with the **smallest** priority order will take precedent"*。数字小 = 先判。编译期按它排序，运行时逐条求值、取第一条成立的 |
| `Bidirectional` | ☐ | *"This transition can go both directions"*，但**引擎尚未实现**——编译时会警告 `Bidirectional transitions aren't supported yet`。**永远不要勾** |
| `Blend Logic` | `Standard Blend` | *"Blend smoothly from source state to destination state. Both states update during the transition. **Falls back to Inertialization on re-entry to an already active state when Fall Back to Inertialization is true**"*。最后一句直接对应 6.10 那个开关 |
| `Transition Rule Sharing` | `Idle - State Changed` / `General - Animation Almost Complete` | 规则被多条转换共享并起名。`General -` 前缀表示跨状态组复用（4 个状态组的"动画快播完"用的是同一条规则），改一处全生效 |
| `Automatic Rule Based on Sequence Player in State` | ☐ | 依赖状态内的 asset player，这里没有 → 失效，手写替代（6.7） |
| `Automatic Rule Trigger Time` | `-1.0 s` | 上一条关掉后无意义 |
| `Min Time Before Re-entry` | `-1.0 s` | *"Has no effect when set to -1.0. When set to zero, wait at least one frame"*。关掉，改用规则里的条件化时间门槛（6.10 末） |
| `Sync Group Name to Require Valid Markers Rule` | `None` | 要求同步组有有效 marker 才允许转换。这里不靠同步组驱动 |
| `Disabled` | ☐ | 勾上则**编译时直接丢弃**这条转换（不是运行时跳过） |
| `Only Evaluate when Active` | ☐ | *"this transition rule will not be evaluated when the state machine's update context is inactive (e.g. when blending out)"*。这个状态机靠 `Always Update Children` 恒定被更新，勾不勾差别很小 |

**另外，图上那个 `Conduit`（6.1 节）在引擎里有两条特殊规则值得知道：**

- Conduit 自带一条 **entry rule**，必须先为真，才会考虑经由它的任何转换（*"Conduit 'states' have an additional entry rule which must be true to consider taking any transitions via the conduit"*）；
- **从 Conduit 出发的转换不会产生混合**——引擎判断源状态是 Conduit 时就不往活动转换栈里压东西。所以 Conduit 是"零成本分流"，用来汇聚多个入口特别合适。


---

# 第七部分：引擎 API 对照

以下签名摘自 UE 5.8 引擎源码，用来把图上的蓝图节点对回 C++。**这些接口都标了 `Experimental`，跨版本会变。**

## 7.1 Blend Stack

`Engine/Plugins/Animation/BlendStack/Source/Runtime/Public/BlendStack/BlendStackAnimNodeLibrary.h`

类头注释：

> Exposes operations that can be run on a Blend Stack node via Anim Node Functions such as "On Become Relevant" and "On Update".

| 蓝图节点 | C++ | 说明 |
|---|---|---|
| Convert to Blend Stack Node | `ConvertToBlendStackNodePure` / `ConvertToBlendStackNode` | 由 `FAnimNodeReference` 拿到 Blend Stack 上下文 |
| Force Blend On Next Update | `ForceBlendNextUpdate` | 注释：*Force a blend on the next update, even if the anim sequence has not changed* |
| Get Current Blend Stack Anim Asset | `GetCurrentBlendStackAnimAsset` | 当前播放的资产 |
| Get Current Blend Stack Anim Asset Time | `GetCurrentBlendStackAnimAssetTime` | 当前时间（秒） |
| Get Current Asset Time Remaining | `GetCurrentAssetTimeRemaining` | 剩余时间 |
| Is Current Asset Looping | `IsCurrentAssetLooping` | 是否循环 |
| —— | `BlendTo(...)` / `BlendToWithSettings(...)` | **另一条路**，见下 |

`FAnimNode_BlendStack` 的引脚（全部 `PinHiddenByDefault`，注释是引擎原文）：

```cpp
AnimationAsset       // requested animation to play
AnimationTime        // requested animation time            = -1.f
ActivationDelayTime  // delay in seconds before activating AnimationAsset
bLoop                // requested AnimationAsset looping     = true
bMirrored            // requested AnimationAsset mirroring    = false
WantedPlayRate       // requested animation play rate         = 1.f
BlendTime            // tunable animation transition blend time = 0.2f
MaxAnimationDeltaTime
BlendProfile
BlendOption
MaxActiveBlends      // Number of max active blending animation in the blend stack.
                     // If MaxActiveBlends is zero then blend stack is disabled   = 4
```

> **`MaxActiveBlends = 0` 会直接禁用 Blend Stack**。排查"完全不混合"时先看这个。

**两种驱动方式，GASP 方案 B 用的是第一种：**

```text
① 引脚绑定（本文）
   把 BlendStackInputs 结构体的字段绑到节点引脚上，改结构体即触发混合。
   优点：声明式，谁在改一目了然；缺点：要自己处理"引用没变但想重播"（ForceBlend）。

② 命令式调用 BlendTo()
   在 Anim Node Function 里直接 BlendTo(Context, Node, Asset, Time, Loop, Mirrored,
                                         BlendTime, BlendParameters, WantedPlayRate,
                                         ActivationDelay)
   优点：一次调用给全参数，天然支持重复播放；缺点：调用点分散。
```

如果你从零搭，**方式 ② 更省事**——`BlendTo` 每次调用都是一次新的混合请求，不需要 `ForceBlendOnNextUpdate` 这套补丁。GASP 用 ① 大概是为了让"当前应该播什么"始终有一个可检视的单一数据源（`BlendStackInputs`），调试更直观。

## 7.2 Motion Matching

`Engine/Plugins/Animation/PoseSearch/Source/Runtime/Public/PoseSearch/PoseSearchLibrary.h`

```cpp
/**
 * Implementation of the core motion matching algorithm
 *
 * @param AnimInstance     Input animation instance
 * @param AssetsToSearch   Input assets to search (UPoseSearchDatabase or any animation
 *                         asset containing UAnimNotifyState_PoseSearchBranchIn)
 * @param PoseHistoryName  Input tag of the associated PoseSearchHistoryCollector node
 * @param Result           Output FPoseSearchBlueprintResult with the search result
 */
static void MotionMatch(UAnimInstance* AnimInstance,
                        TArray<UObject*> AssetsToSearch,
                        const FName PoseHistoryName,
                        const FPoseSearchContinuingProperties ContinuingProperties,
                        const FPoseSearchFutureProperties Future,
                        FPoseSearchBlueprintResult& Result);
```

**`AssetsToSearch` 收 `UPoseSearchDatabase` 或任何带 `Branch In` 通知的动画资产** —— 这正是 3.7 节那个"没打 Branch In 就静默失败"的出处。

`FPoseSearchBlueprintResult` 的字段（`PoseSearchResult.h`，注释为引擎原文）：

| 字段 | 类型 | 引擎注释要点 |
|---|---|---|
| `SelectedAnim` | `UObject*` | 匹配到的动画 |
| `SelectedTime` | `float` | 对应的时间点（**入帧**） |
| `bIsContinuingPoseSearch` | `bool` | 结果来自"继续当前姿态"的搜索 |
| `WantedPlayRate` | `float` | 按轨迹速度建议的播放速率，默认 1.f |
| `bLoop` / `bIsMirrored` | `bool` | 循环 / 镜像状态 |
| `BlendParameters` | `FVector` | 若结果是 BlendSpace |
| `SelectedDatabase` | `const UPoseSearchDatabase*` | 结果所属数据库 |
| `SearchCost` | `float` | *The bigger the number, the more different the two are*，默认 `MAX_flt` |

> **GASP 方案 B 只用了 `SelectedAnim` / `SelectedTime` / `SearchCost` 三个字段**，`WantedPlayRate` 被丢掉了——因为它自己有 `Get_DynamicPlayRate`（第五部分）。这算是一处重复实现：如果你从零搭，可以直接把 `WantedPlayRate` 接到 Blend Stack 的同名引脚上，省掉一整个函数。代价是失去 alpha 曲线那种"动画内部开关"的精细控制。

## 7.3 Chooser

`Engine/Plugins/Chooser/Source/Chooser/Public/ChooserFunctionLibrary.h`

```cpp
/**
 * Evaluate a chooser table and return the selected UObject, or null
 * @param ContextObject (in) An Object from which the parameters are read
 * @param ChooserTable  (in) The ChooserTable asset
 * @param ObjectClass   (in) Expected type of result object
 */
static UObject* EvaluateChooser(const UObject* ContextObject,
                                const UChooserTable* ChooserTable,
                                TSubclassOf<UObject> ObjectClass);

// 返回全部命中项
static TArray<UObject*> EvaluateChooserMulti(...);

// 结构体输入/输出（图上 S_ChooserOutputs 走的就是这条）
static void AddChooserStructInputOutput(FChooserEvaluationContext& Context, int32 Value);
```

图上那个 `Evaluate Chooser` 节点同时给出数组和结构体，对应的是 `EvaluateChooserMulti` + `AddChooserStructInputOutput` 的组合。**`ContextObject` 传的是 AnimBP 实例本身**（`SandboxCharacter_CMC_ABP_C`），所以 Chooser 表里的每一列都能直接读 AnimBP 的变量——`StateMachineState`、`Speed 2D`、`TargetRotationDelta` 全是这么来的。

> 这也解释了 3.2 节为什么必须**先**写 `StateMachineState` 再 Evaluate：Chooser 是同步读 Context 对象的成员变量，写晚了就读到旧值。

---

# 第八部分：自己搭一套的最小步骤

如果要在自己项目里复现这套结构，按下面顺序做，每一步都能单独验证。

## 8.1 前置

```text
启用插件：Pose Search（含 Motion Matching）、Blend Stack、Chooser
准备资产：至少一组 Idle / Loop_F / Start_F_Lfoot / Start_F_Rfoot
```

## 8.2 第一步：先让 Blend Stack 能播

**目标：手改一个变量就能换动画。**

```text
① 定义结构体 S_BlendStackInputs
     Anim(AnimationAsset) / StartTime(float) / Loop(bool)
     BlendTime(float) / BlendProfile(BlendProfile) / Tags(GameplayTag[])
② AnimBP 加变量 BlendStackInputs
③ AnimGraph 放 Blend Stack 节点，五个引脚绑到结构体字段
④ 给节点起个 Node Tag（GASP 叫 "State Machine Blend Stack"），
   并在 AnimBP 里加一个 Anim Node Reference 变量指向它
```

**验证**：运行中手动改 `BlendStackInputs.Anim`，画面应该混合过去。做不到就先查 `MaxActiveBlends` 是不是 0。

## 8.3 第二步：接上逻辑状态机

**目标：状态切换能触发换动画。**

```text
① 加状态机 State Controller，每个状态里什么都不接
② AnimGraph 接成：State Controller → Two Way Blend[A]
                   Blend Stack     → Two Way Blend[B]
                   Alpha = 1.0
③ Two Way Blend 节点勾上 Always Update Children      ← 别漏
④ 每个状态加 OnStateEntry 函数，先直接写死一个资产到 BlendStackInputs
```

**验证**：切状态时动画跟着换。如果晚一帧，就是第 ③ 步没勾。

## 8.4 第三步：换成 Chooser 驱动

```text
① 定义 S_ChooserOutputs：StartTime / UseMM / MMCostLimit / BlendTime /
                          BlendProfile(FName) / Tags
② 建 Chooser Table，Result 类型 = AnimationAsset，勾 Multi 输出
③ 加条件列：State Machine State(Enum Or) / Speed 2D / Future Facing Delta
④ 把 OnStateEntry 里写死的部分换成共用函数 SetBlendStackAnimFromChooser
     顺序严格照第三部分：写 State → 缓存 Previous → 复位 bool → Evaluate
⑤ 加 NoValidAnim 转换条件
```

**验证**：改表能改行为，不用编译蓝图。

## 8.5 第四步：加单帧 Motion Matching

```text
① 建 PoseSearchSchema + PoseSearchDatabase（只为提供 Schema 和索引）
② 在候选动画上打 Pose Search: Motion Matched Branch In 通知状态，
   指定所属 Database                                    ← 最容易漏
③ AnimGraph 加 Pose History 节点，Tag 记为 "PoseHistory"
④ 在 SetBlendStackAnimFromChooser 里加 UseMM 分支，
   调 MotionMatch(ValidAnims) 覆盖 Anim / StartTime / Loop
⑤ 表里给需要精选的行勾上 UseMM
```

**验证**：让 Chooser 同时输出 Lfoot/Rfoot 两条起步动画，来回起步应该自动交替脚。不交替就是 Branch In 没打或 Pose History 名字对不上。

## 8.6 第五步：加自转换（状态重入）

```text
① 在过渡状态上拉一条转换回它自己（自转换）
② 该转换的 Details 面板里勾上
     Transition | Experimental | Allow Inertialization for Self Transitions   ← 不勾则永不生效
③ 规则写成：某个决策变量变了 AND CurrentStateTime > 0
④ 确认 AnimGraph 里状态机上游有 Inertialization（或 Dead Blending）节点，
   否则自转换的惯性混合请求会打错误日志
```

**验证**：连续两次同向 pivot、或走→蹲走切换时，动画应该重新选一次。没反应就是第 ② 步没勾（6.10 节）。

## 8.7 第六步：补齐播放期

```text
① 过渡状态的 OnStateEntry 传 ForceBlend = true，循环状态传 false
② 加 IsAnimationAlmostComplete 作为过渡→循环的转换条件
③ 加 NoValidAnim OR BlendStackInputs.Loop 作为"跳过过渡"的转换条件
④ 需要的话再加 Get_DynamicPlayRate（或直接用 MM 返回的 WantedPlayRate）
⑤ 加 Steering 节点 + TargetRotation，把方向覆盖补上
```

---

# 第九部分：坑与限制

## 9.1 Epic 自己承认的

| 问题 | 出处 | 影响 |
|---|---|---|
| Chooser 输出数组时**只返回第一个有效输出结构体** | 3.5 节注释 | 同组候选的混合参数必须一致 |
| `IsAnimationAlmostComplete` 用固定 0.75s | 6.5 节注释 | 所有过渡动画尾巴长度必须接近 |
| 原地转身重触发也用固定 0.75s | 6.9 节注释 | 所有转身动画时长必须接近 |
| 曲线资产查询**不是线程安全**的 | 2.4 节注释 | 必须走"假动画存曲线"的绕法 |
| `Previous_BlendStackInputs` 存了但没用 | 3.3 节注释 | 转换矩阵是留白，不是成品 |
| `Bidirectional` 转换引擎尚未实现 | 引擎编译警告 | 勾了会收到 warning，行为不变 |
| 状态里没有 asset player | 6.7 节注释 | Automatic Rule / Sync Group 等引擎特性全部失效 |
| 整套工作流 "far from ideal" | 开篇注释 | **别直接产品化** |

## 9.2 我自己想指出的两处成本

**① 自转换重试是每帧跑 Chooser + MM。** 6.9 节那个"IsPivoting 为真就每帧重入一次"的机制很优雅，但它意味着在整个 pivot 意图持续期间，每帧都要求值一次 Chooser 表并做一次单帧 Motion Matching。角色数量一多，这是实打实的开销。产品化要加节流。

**② 状态机的混合参数全是死的。** 因为姿态被丢弃，`Crossfade Duration`、`Blend Logic`、Blend Settings 那一整组在这套设计里都不影响画面——**但它们仍然会被求值**。这也意味着新人接手时会对着一堆"改了没反应"的参数困惑，最好在图上写注释说明。

## 9.3 排查清单

按出现频率排序：

**① 动画完全不换**
```text
→ Blend Stack 的 MaxActiveBlends 是不是 0
→ Two Way Blend 的 Alpha 是不是 1.0、A/B 有没有接反
→ Anim Node Reference 变量有没有真正指向那个 Blend Stack 节点
```

**② 换了但晚一帧**
```text
→ Two Way Blend 的 Always Update Children 没勾
```

**③ Re-Enter（自转换）规则怎么写都不触发**
```text
→ 该转换的 Allow Inertialization for Self Transitions 没勾（6.10 节）
  ★ 这是自转换唯一的放行开关，默认 false
→ 规则里的 CurrentStateTime > 0 写成了 >= 0（会同帧反复触发）
```

**④ 连续同向 pivot 第二次没反应**
```text
→ 该状态的 ForceBlend 没传 true（3.8 节）
```

**⑤ 循环动画偶发抖动 / 从头重播**
```text
→ 循环状态的 ForceBlend 误传了 true
```

**⑥ MM 永远选不到，NoValidAnim 一直为真**
```text
→ 候选动画上没打 Pose Search: Motion Matched Branch In
→ Branch In 通知里没指定 Database
→ MotionMatch 的 PoseHistoryName 和 Pose History 节点的 Tag 不一致
→ MMCostLimit 设得太小
```

**⑦ 方向枚举高频跳变**
```text
→ Get_MovementDirectionThresholds 的迟滞没生效
   （MovementDirectionLastFrame 有没有在 Update 开头就存）
```

**⑧ 播放速率飞掉 / 角色瞬移般加速**
```text
→ movedata_speed 曲线缺失或起步段接近 0，分母保护被绕过
→ Min/Max 曲线值异常
```

**⑨ 状态机一帧内连跳好几个状态**
```text
→ 事件型 bool 没在 OnStateEntry 复位（3.4 节）
→ 转换规则里漏了 CurrentStateTime > 0 这一半
```

**⑩ 输出日志里刷 Inertialization 相关错误**
```text
→ 状态机上游没有 Inertialization / Dead Blending 节点，
   自转换的惯性混合请求找不到接收者（6.10 节）
```

**⑪ 过渡状态被完全跳过，起步动画从来不播**
```text
→ 规则 ② 的 BlendStackInputs.Loop 一直为真：
   Chooser 里循环动画和过渡动画放进了同一组候选，
   而 MM 总判循环动画代价更低（6.8 节）。这可能是对的行为，先确认是不是 bug
```

## 9.4 调试手段

**① 状态机调试可视化。** GASP 的调试 Widget 里有开关，打开后能直接在屏幕上看到 `MovementDirection` 的四个象限边界随条件变化——这是验证 2.2 节那套迟滞逻辑唯一靠谱的方式。注释里两次提到它（"you can see the quadrants change if you enable state machine debugging in the widget"）。

**② Chooser 表的行内 `Disabled` 开关。** 怀疑某一行抢了优先级，直接勾上 `Disabled`，不用删行也不用改条件。

**③ 转换上的 `Disabled` 开关。** 注意它跟 Chooser 的不一样：**编译时就把这条转换丢掉**，不是运行时跳过。用来二分定位"到底是哪条转换在抢"。

**④ 把 `SearchCost` 打到屏幕上。** 它是 `SetBlendStackAnimFromChooser` 里唯一被存下来的 MM 中间量，用来定 `MMCostLimit` 的量级。

**⑤ 用 Transition Start 通知看时序。** 给每条转换填上带前缀的 Start 通知（6.11 节），在 Rewind Debugger 的时间轴上就能直接看到"逻辑状态什么时候切的"和"Blend Stack 什么时候起混合的"，两条时间线对比着看，`ForceBlend` 有没有生效一目了然。

**⑥ Rewind Debugger**（`Window → Rewind Debugger`）。可以逐帧回看状态机的状态、Blend Stack 的活动混合层、Pose Search 的搜索结果。方案 B 这种"决策分散在多个回调里"的结构，靠它比靠 Print String 高效得多。

---

# 第十部分：什么时候该用它

## 10.1 方案 A / 方案 B 的选择

| 需求 | 建议 |
|---|---|
| 通用第三人称移动，想快速出效果 | **方案 A**（纯 MM），本系列第一篇 |
| 需要"某个时刻必须播某个动画"的强控制 | **方案 B** 的思路 |
| 动画量大、要靠表格给美术/策划配 | Chooser 这一层值得单独抄 |
| 需要状态重入（同一动作连续触发） | Blend Stack + ForceBlend 这套值得抄 |
| 团队里没人熟 AnimBP | 都别用，先用普通状态机 |

**更实际的建议**：方案 B 整套照搬风险高（Epic 自己说 experimental、接口会变），但它拆出来的**四个零件都可以单独用**：

```text
✅ 可单独抄：Chooser 分层表 + 输出结构体（4.x）—— 与 MM 无关，纯粹好用
✅ 可单独抄：MovementDirection 的象限迟滞（2.2）—— 手感立竿见影
✅ 可单独抄：Steering Target Rotation 换资产量（2.3）—— 设计思路层面的收益最大
✅ 可单独抄：曲线烤元数据（5.4）+ RInterpTo 检突变（6.4）
✅ 可单独抄：自转换 + NoValidAnim 组成的"每帧重试"机制（6.9）
⚠️ 谨慎：整套"状态机不出姿态 + 外部 Blend Stack"的骨架
```

## 10.2 一句话总结每个部件

```text
State Machine  → 决定"什么时候换"（时机，显式可控）
Chooser        → 决定"换成哪一类"（范围，表格驱动）
Motion Match   → 决定"具体哪条、从第几帧进"（细节，姿态驱动）
Blend Stack    → 决定"怎么混过去"（表现，参数驱动）
```

四层各管一件事、只通过一个结构体（`BlendStackInputs`）通信 —— **这个职责划分本身，就是这套实验设计最大的价值。** 哪怕你一行图都不抄，把自己的 locomotion 按这四层重新切一遍，也会清爽很多。

---

# 参考

**官方文档**

- [Game Animation Sample Project](https://dev.epicgames.com/documentation/unreal-engine/game-animation-sample-project-in-unreal-engine)
- [Motion Matching in Unreal Engine](https://dev.epicgames.com/documentation/unreal-engine/motion-matching-in-unreal-engine)
- [Dynamic Asset Selection（Chooser Tables）](https://dev.epicgames.com/documentation/unreal-engine/dynamic-asset-selection-in-unreal-engine)
- [FAnimNode_BlendStack API](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/BlendStack/FAnimNode_BlendStack)
- [UBlendStackAnimNodeLibrary API](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/BlendStack/UBlendStackAnimNodeLibrary)
- [UChooserFunctionLibrary API](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/Chooser/UChooserFunctionLibrary)

**引擎源码位置**（本文签名出处）

```text
Engine/Plugins/Animation/BlendStack/Source/Runtime/Public/BlendStack/
    BlendStackAnimNodeLibrary.h
    AnimNode_BlendStack.h
Engine/Plugins/Animation/PoseSearch/Source/Runtime/Public/PoseSearch/
    PoseSearchLibrary.h
    PoseSearchResult.h
    PoseSearchAnimNotifies.h
Engine/Plugins/Chooser/Source/Chooser/Public/
    ChooserFunctionLibrary.h

# 第六部分那些转换配置项的出处
Engine/Source/Editor/AnimGraph/Public/AnimStateTransitionNode.h     ← 各字段的 tooltip
Engine/Source/Runtime/Engine/Classes/Animation/AnimStateMachineTypes.h  ← 烘焙后的结构
Engine/Source/Runtime/Engine/Private/Animation/AnimNode_StateMachine.cpp ← 运行时行为
```

**本系列**

- [（一）动画蓝图、Chooser Table 与 Database 切分](/2026/09/07/gasp-motion-matching-animbp-chooser-database/)
- [（二）动画蓝图的变量、函数与节点绑定](/2026/09/07/gasp-animbp-functions-and-variables/)
- （三）本文

**其他**

- [Unreal Fest: Choosing Animation with Choosers](https://www.youtube.com/watch?v=-03Xm2oZK_Y)
- [GASP for UE 5.8 更新说明](https://www.unrealengine.com/tech-blog/download-the-latest-game-animation-sample-project-now-updated-for-ue-5-8)






