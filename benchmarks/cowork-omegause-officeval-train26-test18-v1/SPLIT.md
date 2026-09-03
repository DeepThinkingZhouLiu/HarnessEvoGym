OmegaUse-OfficeVal 主表训练集内晋升固定划分

- `feedback`：26 道训练题，由原 18 道 Feedback 与 8 道 Selection 合并；同一批结果既提供 Bad Case，也决定 Candidate 是否晋升。
- `selection`：显式为空，本协议不使用独立验证集。
- `final`：18 道密封测试题，只用于进化完成后的泛化验收。
- 两个 Partition 来自同一份固定 Linux 可运行清单，互不重叠。
- 数据与 Evaluator 身份固定为 `8bf749b53988822a90520eba4761c6c311e17dd0e13bd78658b261a921128291`。
