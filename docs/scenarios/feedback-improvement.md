# Example scenario: improve online user feedback

Date: 2026-09-16
Parent: [Goal-centered product proposal](../goal-driven-product-proposal.md). This numeric scenario tests the general mechanism. It does not define product positioning or prescribe pages and workflows for other goals.

## User intent

“Improve online user feedback and reduce the feedback rate to 1%.”

After choosing this scenario, the user progressively clarifies the product, population, and scope, and the actual feedback-rate definition, such as users submitting feedback / active users, or feedback tickets / requests. The denominator cannot be inferred on the user's behalf.

Success criteria record thresholds, statistical windows, and timezones. Users set deadlines and sustained-success windows as needed; requirements such as two consecutive weeks must not be added by default.

## Application within the general product

| General capability | Contents in this scenario |
| --- | --- |
| Goal and success criteria | Feedback rate ≤ 1% within the user-defined scope |
| Current state | Current feedback rate, major issues, confirmed causes, completed results, and blockers |
| Information sources | Manual entry, report imports, or reproducible queries |
| Plans and tasks | Establish definitions, analyze/classify, select improvements, fix/validate, deliver/observe |
| Agent orchestration | Select roles and models for analysis, implementation, validation, and other task needs |
| Result updates | Add established issues, completed fixes, and new observations |
| Reviews | Compare stage expectations with actual changes and select the next actions |

## Metric extensions

Each observation saves the value, applicable original numerator/denominator, statistical period, retrieval time, source, and definition version. The latest valid observation forms the current metric view while history is retained.

Query failure retains the latest valid value and marks it stale or failed. Missing data is not zero. Late-arriving old data cannot replace a newer statistical period. Changed definitions cannot be joined directly into a comparable trend.

Task completion rates and goal outcomes are displayed separately. The actual gap from the target can be shown. Counts of different tasks are not automatically converted into feedback-rate improvement, and a contemporaneous decrease does not establish a task's causal contribution.

## A complete progression

1. The user creates a goal and supplies current observations or a query method.
2. Analysis classifies and deduplicates feedback, producing evidence-supported priorities.
3. The user selects improvement items; the relevant Agents or participants analyze, implement, and validate them.
4. After acceptance, current state records delivered results. Unreleased work is explicitly pending release.
5. After release and coverage confirmation, observe subsequent data over an appropriate window.
6. New observations update context. Reviews inspect the remaining goal gap, existing contribution evidence, and impacts awaiting verification.
7. Continue, adjust, or end actions based on results, then create the next task batch.

Analysis results, delivered fixes, release, and impact observation are different results and are recorded separately. Other scenarios do not need this sequence of stages.

## Periodic reviews

Users can configure weekly reviews, for example creating a record each Monday for the preceding complete calendar week. Records retain timezone, statistical period, goal version, and referenced observations.

Reviews cover changes in the period, actually delivered work, impacts still awaiting observation, deviations from expectations, and next steps. Without deadlines or stage expectations, they report current changes and missing conditions without declaring on-time achievement or delay.

Scheduling follows the general product's actual background capabilities. Enabling weekly summaries does not automatically authorize new improvement tasks.
