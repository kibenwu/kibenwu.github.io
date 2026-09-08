---
layout: post
title: UE5 Effect Type Budgeting Options
subtitle: Niagara 特效预算上限与剔除策略分析
author: KivenWu
header-style: text
tags:
  - UE5
  - Niagara
  - VFX
  - TA
---
![](/img/in-post/ue5-fx-budget/01-effect-type-budget-scaling.png)

## Max Global Budget Usage（最大全局预算使用量）

是指设置预算上限，超过此上限的系统将会被剔除。通常是 0-1 之间的浮点值，代表百分比。

剔除的方法有 3 个选项：

![](/img/in-post/ue5-fx-budget/02-cull-curve-options.png)

### Max Distance Scale by Global Budget Use

是通过距离，当 Budget 到达瓶颈时，只渲染当前距离以内的（曲线）。

### Max Instance Count Scale By Global Budget Use

当前设置是通过曲线剔除 —— 在场景中同一种类（Effect Type）的所有 System 中的 Instance 的数量。

### Max System Instance Count Scale by Global Budget Use

这个 Culling 的不是所有的同类 Instance，而是每个 System 中的 Instance 数量。

## Debug 与分析工具

在测试中开启 Debug 方法可以查询有关 Budget 的追踪和分析工具。

在 Niagara System 中右键可以将当前系统增加到 Debug 中监控。

![](/img/in-post/ue5-fx-budget/03-add-system-to-debugger.png)

![](/img/in-post/ue5-fx-budget/04-niagara-debugger.png)

可以看到默认情况下 9 个 Instance 的数量在 1300 - 2000 之间。

![](/img/in-post/ue5-fx-budget/05-fx-outliner-instance-count.png)

当前的 Budget 设置为 2，平均消耗在 0.2 GT / 0.069 的 RT。

![](/img/in-post/ue5-fx-budget/06-budget-usage-default.png)

当设置全局使用占比为 0.1 时，所有的 Instance 都被 Culled 了 0.1 的百分比。

![](/img/in-post/ue5-fx-budget/07-culled-global-usage-01.png)

## Budget CVar

### 全局 Budget Time

`FX.Budget.GlobalTimeDilation` —— 全局 FX 系统的时间缩放。

### CPU/GPU 的预算分配

- `FX.Budget.CPUBudget` —— 设置 CPU 的全局 FX 预算时间（单位：毫秒）
- `FX.Budget.GPUBudget` —— 设置 GPU 的全局 FX 预算时间（单位：毫秒）
- `FX.Budget.ParticlesMax` —— 全局粒子最大数量

例如：

```ini
FX.Budget.CPUBudget=16
FX.Budget.GPUBudget=12
FX.Budget.ParticlesMax=100000
```

### 动态设置（仅在当前编辑器下有效）

在命令行中输入：

```
FX.Budget.CPUBudget 16
```

这将会把 CPU FX 预算设置为 16 毫秒，但仅在当前编辑器下有效，关闭引擎后会重置。

### 持久化储存（保存到配置文件）

在 `Config/DefaultEngine.ini` 中配置：

```ini
[SystemSettings]
FX.Budget.CPUBudget=16
```

## FX.Budget.AdjustedUsageMax

`FX.Budget.AdjustedUsageMax` 用于管理 FX 系统在性能预算中的行为。具体是为了防止某一帧的性能开销异常，导致整体 FX 系统长期超出预算。

它限制了一个经过平滑处理后的预算使用值，即使某一帧的性能消耗异常高，也不会让 Adjusted Usage 停留在一个极端的高值太长时间。

在运行中某一帧导致 FX 系统大幅超出预算，会使整个 Adjusted Usage 保持高于 1.0（超预算）的状态，影响引擎的判断和剔除策略，影响 FX 系统的平稳运行，可能频繁触发粒子系统的剔除和降级逻辑。

Adjusted Usage Max 就是用来通过设置一个最大值，防止单帧异常消耗对后续多帧表现的持续负面影响。

举例：

- 系统预算上限是 1.0
- 某一帧负载导致 Adjusted Usage 瞬时飙升到了 3.0
- Adjusted Usage 逐帧递减，但需要较长的时间回落到 1.0 以下
- 在此期间，FX 系统会持续被误判断为超预算状态，导致大量粒子被剔除或 FX 系统降级

如果设置了 Adjusted Usage Max 为 1.2，那么系统会锁定在 1.2，这样后续帧回落的速度加快，短时间内即可恢复正常。

**策略**

- 设置为 1.5：允许更多的短期波动
- 如果希望稳定、避免波动对其他系统造成影响，可以设置为 1.1
