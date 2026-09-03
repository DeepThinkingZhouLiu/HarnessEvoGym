OmegaUse-OfficeVal 主实验固定划分

- `feedback`：18 道训练/进化题，文档、演示、表格各 6 道；Updater 可读详细反馈。
- `selection`：8 道验证题，只用于 Controller 配对晋升，不向 Updater 暴露逐题结果。
- `final`：18 道密封测试题，Champion 锁定后才允许单次最终评测。
- 三个 Partition 来自同一份固定 Linux 可运行清单，互不重叠。
- 数据与 Evaluator 身份固定为 `8bf749b53988822a90520eba4761c6c311e17dd0e13bd78658b261a921128291`。
