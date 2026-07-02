run_id: run_decomp_facade_commit

Decomposed the Event Trigger Webhook Inbox project into an agent-ready issue set.

## What I did with each part of your project
- Objective + scope became the inbox build and the durable queue.
- Operator-visible status became its own issue, blocked on the inbox build.