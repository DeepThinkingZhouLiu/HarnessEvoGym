OmegaUse-OfficeVal Linux v1 固定划分

- `feedback` = 训练/进化集：55 道，Updater 可读详细失败反馈。
- `selection` = 验证集：18 道，只向 Controller 返回聚合分数，用于 Candidate 晋升。
- `final` = 测试集：18 道，Champion 锁定后只解封一次。
- 固定随机种子语义：`harnessevogym-officeval-linux-v1-20260827`。
- 按题号对应的 Office 类型分层抽样：001-040 文档、041-080 演示、081-100 表格。
- Linux 正式集合排除了需要 Windows Office COM 的 9 道题：001、008、019、022、023、030、039、074、081。
- `cowork-omegause-officeval-smoke` 的 060/090/003 三题均来自本正式划分的 feedback 集；Smoke 中临时扮演三种 Partition 只用于验证链路，不构成正式评测，也不会提前消费正式 selection/final。
