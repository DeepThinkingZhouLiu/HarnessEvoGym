OmegaUse-OfficeVal 训练集内晋升对照划分

- `feedback`：18 道训练题，同时提供 Updater 反馈并决定 Candidate 是否晋升。
- `selection`：显式为空，表示该实验不使用独立验证集。
- `final`：18 道密封测试题，只用于最终泛化验收。
- 该协议适合复现“训练集上选 Champion”的对照实验，不应与独立验证集协议混为同一列。
