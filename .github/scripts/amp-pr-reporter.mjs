const botLogin = "github-actions[bot]";

// Runs only from the trusted default-branch workflow, with its short-lived token.
// PR text is data: no checkout, shell execution, model calls or QA here.
export async function reportMention({ github, context }) {
  const { owner, repo } = context.repo;
  if (`${owner}/${repo}` !== "vincentbility/amp-qa-lab") {
    throw new Error("Reporter is restricted to vincentbility/amp-qa-lab");
  }
  const dispatched = context.eventName === "repository_dispatch";
  const relayed = context.eventName === "workflow_run";
  if (
    !(
      (dispatched && context.payload.action === "amp-pr-report") ||
      (relayed && context.payload.action === "completed") ||
      (context.eventName === "issue_comment" &&
        context.payload.action === "created")
    )
  ) {
    return { ignored: "unsupported event" };
  }
  if (
    context.ref !== `refs/heads/${context.payload.repository.default_branch}`
  ) {
    throw new Error("Reporter must use the trusted default branch");
  }
  let input = context.payload.client_payload ?? {};
  let relay;
  if (relayed) {
    ({ data: relay } = await github.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: context.payload.workflow_run.id,
    }));
    // The relay can use PR-controlled YAML. Its title is data, not authority.
    const match = /^Amp review receipt PR (\d+) comment (\d+)$/u.exec(
      relay.display_title,
    );
    if (
      !match ||
      relay.path !== ".github/workflows/amp-review-relay.yml" ||
      relay.event !== "pull_request_review_comment" ||
      relay.status !== "completed" ||
      relay.conclusion !== "success" ||
      relay.repository.full_name !== `${owner}/${repo}` ||
      !relay.pull_requests.some((pr) => pr.number === Number(match[1]))
    ) {
      return { ignored: "unverified review relay" };
    }
    input = {
      source_kind: "review",
      pr_number: match[1],
      comment_id: match[2],
    };
  }
  const kind = dispatched || relayed ? input.source_kind : "issue";
  if (!["issue", "review", "opened"].includes(kind))
    throw new Error("Invalid source kind");
  const operation = dispatched ? input.operation : "receipt";
  if (
    (dispatched &&
      !["answer", "qa-report", "routing-blocked"].includes(operation)) ||
    (kind === "opened" && operation !== "qa-report")
  ) {
    throw new Error("Invalid operation");
  }
  const number = Number(
    dispatched || relayed
      ? input.pr_number
      : context.payload.issue?.pull_request && context.payload.issue.number,
  );
  const id = Number(
    kind === "opened"
      ? number
      : dispatched || relayed
        ? input.comment_id
        : context.payload.comment?.id,
  );
  if (![number, id].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error("Expected a PR number and source comment ID");
  }
  const { data: pr } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: number,
  });
  if (pr.state !== "open" || pr.head.repo?.full_name !== `${owner}/${repo}`) {
    return { ignored: "closed or fork PR" };
  }
  // Only the labeled pilot is enabled. Removing the label disables reporting.
  if (!pr.labels.some((label) => label.name === "amp-qa-pilot")) {
    return { ignored: "not enrolled in pilot" };
  }
  const source =
    kind === "opened"
      ? pr
      : (
          await (
            kind === "review"
              ? github.rest.pulls.getReviewComment
              : github.rest.issues.getComment
          )({ owner, repo, comment_id: id })
        ).data;
  const expectedUrl = `https://api.github.com/repos/${owner}/${repo}/${kind === "issue" ? "issues" : "pulls"}/${number}`;
  if (
    kind !== "opened" &&
    (kind === "issue" ? source.issue_url : source.pull_request_url) !==
      expectedUrl
  ) {
    throw new Error("Source comment belongs to a different PR");
  }
  if (
    source.user?.type !== "User" ||
    (kind !== "opened" &&
      (!/^\s*@amp(?:\s|$)/u.test(source.body) ||
        source.created_at !== source.updated_at))
  ) {
    return { ignored: "bot, edited or indirect mention" };
  }
  if (relayed) {
    const age = Date.parse(relay.created_at) - Date.parse(source.created_at);
    if (
      relay.actor.login !== source.user.login ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 5 * 60 * 1000
    ) {
      return { ignored: "relay author or source creation time mismatch" };
    }
  }
  const { data: access } =
    await github.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: source.user.login,
    });
  if (!["write", "maintain", "admin"].includes(access.permission)) {
    return { ignored: "author lacks write permission" };
  }
  let root = source;
  if (kind === "review" && source.in_reply_to_id) {
    ({ data: root } = await github.rest.pulls.getReviewComment({
      owner,
      repo,
      comment_id: source.in_reply_to_id,
    }));
    if (root.pull_request_url !== expectedUrl || root.in_reply_to_id) {
      throw new Error("Review parent is not this PR's root comment");
    }
  }
  const key = kind === "issue" ? String(id) : `${kind}-${id}`;
  const sourceRecord = {
    operation,
    source_key: key,
    pr_number: number,
    source_url: source.html_url,
    source_updated_at: source.updated_at,
    source_author: {
      github_id: source.user.id,
      github_login: source.user.login,
    },
    ...(relayed ? { relay_run_id: relay.id } : {}),
  };
  // A shared subscriber must not publish its owner's Puck answer for another user.
  // GitHub authenticates sender; client_payload cannot nominate an identity.
  if (
    operation === "answer" &&
    (context.payload.sender?.type !== "User" ||
      !Number.isSafeInteger(context.payload.sender.id) ||
      context.payload.sender.id !== source.user.id)
  ) {
    return {
      ...sourceRecord,
      blocked: "answer requires source-author authentication",
    };
  }
  const runId =
    kind === "opened"
      ? `pr-${number}-opened`
      : `pr-${number}-${kind === "issue" ? "comment" : "review-comment"}-${id}`;
  const marker = `<!-- ${{ receipt: "amp-receipt", answer: "amp-puck", "qa-report": "amp-qa", "routing-blocked": "amp-routing" }[operation]}:${operation === "qa-report" ? runId : key} -->`;
  const comments = await github.paginate(
    kind !== "review"
      ? github.rest.issues.listComments
      : github.rest.pulls.listReviewComments,
    {
      owner,
      repo,
      ...(kind !== "review"
        ? { issue_number: number }
        : { pull_number: number }),
      per_page: 100,
    },
  );
  const existing = comments.find(
    (comment) =>
      comment.user?.type === "Bot" &&
      comment.user.login === botLogin &&
      comment.body.startsWith(marker) &&
      (kind !== "review" || comment.in_reply_to_id === root.id),
  );
  if (operation === "receipt") {
    const { data: reaction } = await (
      kind === "issue"
        ? github.rest.reactions.createForIssueComment
        : github.rest.reactions.createForPullRequestReviewComment
    )({ owner, repo, comment_id: id, content: "eyes" });
    if (reaction.user?.type !== "Bot" || reaction.user.login !== botLogin) {
      throw new Error("Receipt was not authored by the expected bot");
    }
  }
  if (existing && operation !== "qa-report") {
    return { ...sourceRecord, duplicate: true, comment_url: existing.html_url };
  }
  const message =
    operation === "routing-blocked"
      ? "ROUTING_BLOCKED：目前無法驗證或取得留言者本人的 Puck 路由。未轉送到他人的 Puck，也未啟動 QA。需要由留言者本人授權的 Amp 執行身分與個人 Puck 設定才能處理此問題。"
      : input.body;
  const body =
    operation === "receipt"
      ? `${marker}\n👀 已收到[這則留言](${source.html_url})，等待 Amp 分流；這不代表已啟動 QA。\n\n[可信 reporter run](https://github.com/${owner}/${repo}/actions/runs/${context.runId})`
      : `${marker}\n回覆[${kind === "opened" ? "此 PR" : "這則留言"}](${source.html_url})：\n\n${message}`;
  if (dispatched && (typeof message !== "string" || !message.trim())) {
    throw new Error("Answer/report body is required");
  }
  let result;
  if (existing) {
    result = await (
      kind === "review"
        ? github.rest.pulls.updateReviewComment
        : github.rest.issues.updateComment
    )({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  } else if (kind !== "review") {
    result = await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body,
    });
  } else {
    result = await github.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: number,
      comment_id: root.id,
      body,
    });
  }
  if (result.data.user?.type !== "Bot" || result.data.user.login !== botLogin) {
    throw new Error("Comment was not authored by the expected bot");
  }
  // The receiver checks this machine-readable run-log record against the source,
  // not just a bot comment containing a link to an arbitrary successful run.
  return {
    ...sourceRecord,
    comment_url: result.data.html_url,
  };
}
