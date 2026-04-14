# AutoShip Showcase — Speaker Notes

---

## S0: Title — AutoShip

Hi everyone, I'm Waheed from the engineering team. Today I'll be introducing you to AutoShip, a tool I've been working on. AutoShip takes your tasks and automatically converts them into pull requests. These four things you see floating around — Multi-Model Debate, Multi-Repo Orchestration, Continuous Learning, and Codebase Intelligence — these are the four main pillars of AutoShip. I'll walk you through each of them today.

---

## S1: The Problem

This is what every developer does every single time. The developer manually picks up the task, reads requirements, clones the repo, creates a branch, writes code, pushes, creates a PR, aligns it with our GitHub commit rules. Even a simple 30-min coding task has all these other steps on top — setup, branching, PR alignment, review cycles. And it's not just the code part — the problem is there are a lot of other steps involved. All of this is repeated for every single task.

**ClickUp Data:** I actually fetched data from ClickUp — the average life cycle of a task is around 11 days. And that's not even counting outliers like tasks stuck in testing for months. Just the ideal, normal tasks over the last 3 sprints. AutoShip will drastically change that. Once it's properly used across teams, we'll have a before-and-after report to compare.

---

## S2: The Solution

**Task In:** AutoShip comes into picture here — you just hand over the task from ClickUp. If you already have the task in ClickUp, you can hand it over directly. If not, we also have an AI Task Creator that can generate one from a simple English prompt.

**AutoShip Reasons:** AutoShip automatically validates the task requirements. If things don't look fine — like details are missing or the description is vague — it rejects the task with specific comments explaining what's missing. But if things look good, it directly starts working on the implementation.

**PR Out:** Once completed, it gives you the PR. The PR link gets attached to the ClickUp task and is also visible in the AutoShip dashboard. Slack notifications are also sent to our dedicated channel so you can track everything there too.

**Stats:**
- What used to take days now takes minutes — and it doesn't stop at the PR. Even after the PR is created, AutoShip handles the full review cycle automatically.
- The API cost per task is only 50 cents to 3 dollars. Compare that to what a developer's time costs per hour — the ROI is massive.
- We have already reduced developer effort by 70-80% with AutoShip. The ROI compared to developer time is 50 to 200 times.
- Even after the PR is merged, if tests fail or CI/CD fails for any reason, AutoShip automatically picks those issues up, fixes them, and pushes the fix — no developer intervention needed.

---

## S3: Triggering

**Login & Connect:** Use your Saras email to login, then integrate ClickUp and GitHub accounts via OAuth. Commits show YOUR name in Git history — if you haven't integrated your accounts, I'll take all the credit, so make sure you connect your accounts first.

**Webhook Events:** Webhook events is the default mode. Whenever you set those fields and assign the task, ClickUp automatically fires a webhook event and AutoShip picks it up in real-time. Same with GitHub — PR reviews, comments, CI/CD results — all come through webhooks. Events drive the entire pipeline.

**AI Task Creator:** I've just added this recently — it's not fully tested yet, but you can start using it. This is not a simple task creator. Even if you give a very incomplete command, it understands what you need. You can select the repo, and it already has the context of that repo — recent changes, structure, everything. So based on your command, it creates a proper ClickUp task that's already aligned with the repo. Then it can be triggered automatically or even after your approval — that's all configurable.

**Poller Mode:** This is a fallback for now. If the webhook or anything fails, the poller mode comes into picture — AutoShip keeps polling from ClickUp every few seconds to check whether there are any active tasks for the configured users. It acts as a safety net so nothing gets missed.

---

## S4: Execution Pipeline (11 Steps)

1. **Resolve Repo** — First thing it does is resolve the repo — maps the ClickUp repo field to the actual GitHub repository, pulls the latest code, and sets up the working environment.
2. **Complexity Scoring** — Complexity scoring determines how much time and debate the task gets — also decides how the implementation should be done.
3. **Quality Check** — Threshold is set to 23 right now — because I know how we write tasks. Rejects below that with specific comments on what's missing.
4. **Debate** — The debate comes into the picture only for complex tasks at the moment — there's a configurable complexity threshold. For simpler tasks, it skips the debate and goes straight to the coding plan.
5. **Coding Plan + Diff Preview** — After the debate, it sends the plan to the task with details — what files will change, git diff preview. Takes approval from assignee before implementing.
6. **Codebase Intelligence** — This is where codebase intelligence kicks in — it loads recent PR history, commit history, recent failure history, the style of coding, everything about the repo. And then based on all this context, it implements your functionality.
7. **Historical Learning** — It pulls lessons from all the past PRs — what got approved, what got rejected, what comments reviewers left. It gets smarter with every single PR.
8. **Implementation** — Now comes the actual implementation — it has full repo access, reads files, understands the existing patterns, writes the code, and creates test cases. All done with Claude Code with full repo context.
9. **Test Runner** — After writing the code, it runs the test cases. If any test fails, it auto-fixes the failures and retries. It auto-detects the test command — whether it's Maven, Gradle, npm, pytest — all handled automatically.
10. **Commit, Push & PR** — It stages the changes, commits with proper messages, pushes to a feature branch, and opens a PR with full details — everything aligned with our Git conventions.
11. **Notify & Link** — Updates the task status, posts the PR link back to ClickUp, and notifies the team via Slack. And it doesn't stop here — even after the PR is merged, AutoShip keeps an eye on those PRs. If CI/CD fails or builds break, it picks up the issues and fixes them automatically.

---

## S5: Codebase Intelligence & Learning

**Auto-Detection:** This works across 200+ repos. For every project, it automatically detects what kind of project it is — Spring Boot, Kotlin, Node.js, Python, Go — the build tools, frameworks, Docker configs, everything. It knows your project before writing a single line of code.

**Smart Indexing:** It indexes your controllers, services, models, routes — it already knows your API patterns, naming conventions, and folder structure. All of this is cached so it doesn't have to relearn every time. If there are new changes pushed, it picks those up too and updates its context.

**Live Guidance:** Reads task description, subtasks as acceptance criteria. Even while AutoShip is implementing the task, you can send guidance to steer it in a different direction without having to cancel and restart the whole thing.

**Continuous Learning:** For every project, it kind of learns every time. Whenever a new task is done, it adds its learnings into the codebase context — what worked, what didn't, what reviewers asked for. And then it uses all of these learnings for the next tasks. So it's continuously getting better.

**8 Categories:** It categorizes all review comments into these 8 categories. If reviewers ask for any changes or improvements in a PR, it keeps them in mind and makes sure they are followed in future tasks. So over time, the PRs get cleaner and reviewers have fewer and fewer things to flag.

---

## S6: Multi-Repo Orchestration

**Multi-Select Repos:** This is the most powerful feature of AutoShip. If you have front-end changes, back-end changes, maybe pipeline or subscription service changes, or even notification service changes — currently we assign different people. Maybe Uday or Birhane for pipeline, Maninder for notification or subscription. That's completely not required now. In fact, Maninder recently used a single task for changes in rate-limit-manager and notification-service — both PRs ready. And importantly, it aligns your code across repos — when it makes changes in the backend, it makes the corresponding changes in the frontend too, so both are aligned.

**Parallel or Sequential:** With multiple repos, the leader assigns multiple sub-agents — each sub-agent works on a specific repo, and the leader orchestrates and aligns the overall work across all of them.

---

## S7: The Debate System

**Overview:** AutoShip uses all models from Claude and OpenAI. The Leader decides which models to use as participants based on the specific task. It selects the right participants, assigns them roles, runs multi-round discussions, and synthesizes all perspectives into a final execution plan. The full transcript is visible in the dashboard so you can see exactly what was discussed.

**Leader Orchestrates:** The leader assigns multiple LLM models as participants. Each one gives their initial thoughts on the approach — security perspective, performance perspective, code quality perspective. Then they debate each other's ideas.

**Multi-Round Debate:** They'll agree on some things and disagree on some of the stuff — and that's actually where the real value is. Configurable 1 to 5 rounds depending on task complexity.

**Leader Synthesizes:** After the debate, the leader comes into picture — it consolidates the overall discussion, takes the best ideas from each participant, and creates the final implementation plan. This plan is posted for human approval before any code is written.

**Edge Cases:** I can say this is the second best functionality of AutoShip — it catches a lot of edge cases and leads to much better design overall.

**Agreement vs Disagreement:** Different models give their agreements and disagreements on each other's thoughts. Finally, the leader consolidates everything and prepares the final plan.

---

## S8: PR Review Auto-Fix

1. **GitHub Webhook Monitoring** — AutoShip keeps an eye on all the PRs it creates. Once the PR is created, it continuously monitors via GitHub webhooks — even after merge. If a reviewer leaves comments or if CI/CD fails, it picks that up instantly.
2. **Reads Review Comments** — It parses all the reviewer feedback — knows exactly which file, which line, what the reviewer said, and who said it. If CI/CD fails or tests fail for any code issues, AutoShip picks all of that up.
3. **Generates Fix Instructions** — It structures the fixes needed based on the review comments, then applies them in the repo — same Claude Code session, so it has the full repo context and understands exactly what needs to change.
4. **Commits & Pushes** — Pushes the fixes back to the same branch and posts a summary comment on the PR explaining what was fixed and why — so the reviewer can see exactly what changed.

---

## S9: Quality Controls & Dashboard

**Quality Gate:** I have set the threshold to 23 out of 100 for now — because I know how we write our tasks. If a task scores below that, it gets rejected with specific comments on what exactly is missing. This forces better task writing over time.

**Coding Plan Approval:** If things go well with the quality check, it sends the implementation plan to the task with a lot of details — what files will be changed, a diff preview showing what the changes will look like. It takes approval from the assignee, and only then implements. You can approve via task comment or even through Slack buttons.

**Test Runner:** Before creating the PR, it runs all tests. Auto-detects the test command — Maven, Gradle, npm, pytest — whatever your project uses. If tests fail, it auto-fixes and retries. Test results are included in the PR body.

**Post-PR Guidance:** Live guidance is there — even if you want to make changes after the PR, or even if things change and you need modifications, you can edit in the task itself, in the PR comments, or even in the AutoShip dashboard. It will pick up your guidance from anywhere and push additional commits.

**Dashboard Cards:**
- Task Queue — Approve, dismiss, retry, cancel. Each task has its own separate logs.
- Session Logs — Watch it code in real-time — see exactly what AutoShip is doing at every moment.
- Debate Transcript — See what each model said, where they agreed, disagreed, and how the leader consolidated.
- Steps & Costs — Time taken for each step, cost for each step, total cost — very detailed breakdown.
- Analytics & ROI — Success rates, trends, ROI. All sent to Slack too. You can approve things from Slack.
- System Health — Prometheus metrics, uptime, performance monitoring.

---

## S10: What's Next

**Auto Release:** This is my future plan — I'll do brainstorming with the team and try to execute this. The auto-release plan is where AutoShip should automatically release our code after the PR is merged. And if in case things do not go well after the deployment, it should automatically revert back to the previous tag. No human intervention needed.

**Auto-Healing:** Auto-healing is another plan I have in the pipeline — it will monitor application logs, Prometheus alerts, and try to identify issues, regressions, anomalies automatically. And then try to auto-fix things by creating a patch PR — all without any developer intervention.

**Anyone Can Ship:** The goal is that it's not just developers who use AutoShip. Product owners should be able to describe a feature and get it built. QA teams should be able to create bug fix tasks and get PRs without writing code. Support teams should be able to submit issues from customers and get patches generated. Anyone should be able to ship.

**Auto Testing:** At the moment with AutoShip, we've reduced developer effort by 70-80%, but QA has now got a bit more load because things are shipping so fast. So I'm trying to automate that as well — AutoShip should automatically write test cases, run them, create proper integration tests, generate reports with response times and coverage. This was actually an idea given by Sparsh — it should automatically create QA sign-off reports on behalf of QA.

---

## S11: Team Adoption

You might have seen Maninder sent a message in the engineering group saying he completed 7 tasks in about 2 hours — which is normally around 2 sprints of work. That's one of the biggest benefits we've already got out of AutoShip. Maninder is actively using it for his day-to-day tasks now, and Pratistha has also started using it.

I've been continuously discussing AutoShip with Kedar, and some of the things with Ajay, Venky and Abhishek. Their feedback has improved this a lot. I will encourage everyone else to also provide feedback and any further ideas that can be helpful for AutoShip and for the product.

---

## S12: Demo

*(No speaking notes — live demo)*

---

## S13: Q&A

Happy to answer any questions!

---

**Quick stats to remember:**
- Cost per task: $0.50–3
- ROI: 50–200×
- Developer effort reduced: 70-80%
- Average task cycle: ~11 days (from ClickUp data, last 3 sprints)
- Maninder's stat: 7 tasks in ~2 hours vs ~2 sprints
- 200+ repos supported
- 11 pipeline steps
- 8 quality criteria / 8 learning categories
- Quality threshold: 23/100
