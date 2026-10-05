# 真实记录的独立评测流程

真实记录不随公开仓库分发。当前真实数据标注尚未完成独立复核，不能宣称检测准确率已验证。随仓库的合成数据不能替代真实留出集。

1. 从取得使用授权的日志中预先选择任务轮次，排除用来调试规则的任务；不要根据模型预测挑选样本。
2. 本地冻结源快照并生成空模板：

```sh
npx tsx scripts/prepare-real-review.ts --log <your-rollout.jsonl> --turn 1 --id review-001
```

3. 人工整理最小化轨迹到 `local-traces/reviewed/traces/review-001.json`。删除私人路径、会话标识、密钥、提示词、源代码和工具输出中的私密内容；摘要必须保持事实和时间顺序。原始快照仍属私人数据，不能直接发布。
4. 标注者先记录任务验收条件及证据、重复验证的具体理由，再为每一步的四个检测项填写 `true`、`false` 或证据不足的 `null`。禁止读取检测器预测后反向修改标签。`labels.json` 使用 `src/schema.ts` 中的 labelsSchema，包含 provenance、dataset_kind 和 traces；结构可参考 `benchmark/labels.json`。一名标注者的真实样本使用 `real_single_reviewer`。
5. 由第二名独立标注者盲审真实记录，记录分歧及裁决、证据来源；达成独立复核后才能使用 `real_independently_reviewed`。脚本本身不会认证独立性。数据集应包含真实问题正例及合理重复反例，按任务划分开发集和留出集。
6. 冻结并运行本地评测：

```sh
npx tsx scripts/annotate-real-review.ts --dataset local-traces/reviewed
npx tsx scripts/evaluate-real.ts --dataset local-traces/reviewed
```

冻结器验证每一步均有标签，不生成判定。评测器验证标签与轨迹哈希在评测前后不变，只运行规则。复核改动后应在新数据集目录重新冻结；`review-lock.json` 不自动覆盖。

无正例时不能验证召回率；无预测正例时精确率无定义，应保留 null，不写成 100%。按检测项报告 TP、FP、FN、不确定率和任务覆盖范围。

如另行获得数据共享及费用授权，可通过 CLI `benchmark <dataset> --judge jev --max-calls <budget>` 对经过隐私检查的最小化数据评测。此步骤会向 TypeSafe 发送轨迹内容；本说明及脚本不会自动执行它。
