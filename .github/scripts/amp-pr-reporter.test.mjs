import assert from "node:assert/strict";
import test from "node:test";
import { reportMention } from "./amp-pr-reporter.mjs";

function fixture(kind = "review") {
  const prUrl =
    "https://api.github.com/repos/vincentbility/amp-qa-lab/pulls/1520";
  const bot = { type: "Bot", login: "github-actions[bot]" };
  const source = {
    id: 69,
    body: "  @amp 請處理這個 comment",
    user: { type: "User", id: 101, login: "author" },
    created_at: "2026-10-13T05:19:55Z",
    updated_at: "2026-10-13T05:19:55Z",
    html_url: `https://github.com/vincentbility/amp-qa-lab/pull/1520#${kind}-69`,
    ...(kind === "review"
      ? { pull_request_url: prUrl, in_reply_to_id: 14 }
      : { issue_url: prUrl.replace("pulls", "issues") }),
  };
  const root = {
    id: 14,
    pull_request_url: prUrl,
    user: bot,
    body: "Review finding",
  };
  const state = {
    pr: {
      state: "open",
      head: { repo: { full_name: "vincentbility/amp-qa-lab" } },
      labels: [{ name: "amp-qa-pilot" }],
    },
    permission: "write",
    source,
    root,
    relay: {
      id: 8001,
      path: ".github/workflows/amp-review-relay.yml",
      event: "pull_request_review_comment",
      status: "completed",
      conclusion: "success",
      repository: { full_name: "vincentbility/amp-qa-lab" },
      pull_requests: [{ number: 1520 }],
      display_title: "Amp review receipt PR 1520 comment 69",
      actor: { id: 101, login: "author" },
      created_at: "2026-10-13T05:19:58Z",
    },
    comments: [],
    reactions: [],
  };
  const create = (destination) => async (args) => {
    const data = {
      id: 100 + state.comments.length,
      body: args.body,
      user: bot,
      html_url: `https://github.com/vincentbility/amp-qa-lab/pull/1520#${destination}-${100 + state.comments.length}`,
      destination,
      ...(destination === "review" ? { in_reply_to_id: args.comment_id } : {}),
    };
    state.comments.push(data);
    return { data };
  };
  const update =
    (destination) =>
    async ({ comment_id, body }) => {
      const data = state.comments.find(
        (c) => c.id === comment_id && c.destination === destination,
      );
      if (!data) throw new Error("Comment not found in this destination");
      data.body = body;
      return { data };
    };
  const react =
    (apiKind) =>
    async ({ comment_id, content }) => {
      let data = state.reactions.find(
        (r) =>
          r.kind === apiKind &&
          r.comment_id === comment_id &&
          r.content === content,
      );
      if (!data) {
        data = { kind: apiKind, comment_id, content, user: bot };
        state.reactions.push(data);
      }
      return { data };
    };
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: state.relay }),
      },
      pulls: {
        get: async () => ({ data: state.pr }),
        getReviewComment: async ({ comment_id }) => ({
          data: comment_id === 69 ? source : root,
        }),
        listReviewComments: () =>
          state.comments.filter((c) => c.destination === "review"),
        createReplyForReviewComment: create("review"),
        updateReviewComment: update("review"),
      },
      issues: {
        getComment: async () => ({ data: source }),
        listComments: () =>
          state.comments.filter((c) => c.destination === "issue"),
        createComment: create("issue"),
        updateComment: update("issue"),
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { permission: state.permission },
        }),
      },
      reactions: {
        createForIssueComment: react("issue"),
        createForPullRequestReviewComment: react("review"),
      },
    },
    paginate: async (method) => method(),
  };
  const context = {
    repo: { owner: "vincentbility", repo: "amp-qa-lab" },
    runId: 9001,
    ref: "refs/heads/main",
    eventName: kind === "review" ? "workflow_run" : "issue_comment",
    payload: {
      action: kind === "review" ? "completed" : "created",
      comment: { id: 69 },
      sender: { type: "User", id: 101, login: "author" },
      repository: { default_branch: "main" },
      ...(kind === "review"
        ? { workflow_run: { id: 8001 } }
        : { issue: { number: 1520, pull_request: {} } }),
    },
  };
  return { github, context, state };
}

for (const kind of ["issue", "review"]) {
  test(`${kind}: receipt is on source; reply destination and replay are correct`, async () => {
    const f = fixture(kind);
    const result = await reportMention(f);
    assert.equal(result.source_key, kind === "issue" ? "69" : "review-69");
    assert.equal(result.operation, "receipt");
    assert.equal(result.pr_number, 1520);
    assert.equal(result.source_url, f.state.source.html_url);
    assert.deepEqual(result.source_author, {
      github_id: 101,
      github_login: "author",
    });
    assert.equal(result.relay_run_id, kind === "review" ? 8001 : undefined);
    assert.deepEqual(
      f.state.reactions.map(({ kind, comment_id, content }) => ({
        kind,
        comment_id,
        content,
      })),
      [{ kind, comment_id: 69, content: "eyes" }],
    );
    assert.equal(
      f.state.comments[0].in_reply_to_id,
      kind === "review" ? 14 : undefined,
    );
    assert.match(f.state.comments[0].body, /這不代表已啟動 QA/);
    assert.match(f.state.comments[0].body, /actions\/runs\/9001/);
    assert.equal(f.state.comments[0].user.type, "Bot");
    assert.equal(f.state.comments[0].destination, kind);
    await reportMention(f);
    assert.equal(f.state.comments.length, 1);
    assert.equal(f.state.reactions.length, 1);
  });

  test(`${kind}: answer is once-only; QA transitions update only the bot's report`, async () => {
    const f = fixture(kind);
    f.context.eventName = "repository_dispatch";
    f.context.payload.action = "amp-pr-report";
    f.context.payload.client_payload = {
      operation: "answer",
      source_kind: kind,
      pr_number: "1520",
      comment_id: "69",
      body: "Puck's reply",
    };
    await reportMention(f);
    await reportMention(f);
    assert.equal(f.state.comments.length, 1);
    assert.match(f.state.comments[0].body, /Puck's reply/);
    assert.equal(
      f.state.comments[0].in_reply_to_id,
      kind === "review" ? 14 : undefined,
    );
    assert.equal(f.state.reactions.length, 0);
    const run = `pr-1520-${kind === "issue" ? "comment" : "review-comment"}-69`;
    const human = {
      id: 55,
      user: { type: "User", login: "author" },
      body: `<!-- amp-qa:${run} -->\nHuman text`,
      in_reply_to_id: 14,
      destination: kind,
    };
    f.state.comments.push(human);
    f.context.payload.client_payload.operation = "qa-report";
    for (const body of ["QUEUED", "RUNNING", "PASS — STALE"]) {
      f.context.payload.client_payload.body = body;
      await reportMention(f);
    }
    assert.equal(f.state.comments.length, 3);
    assert.equal(human.body, `<!-- amp-qa:${run} -->\nHuman text`);
    assert.match(f.state.comments[2].body, /PASS — STALE/);
    assert.equal(f.state.comments[2].user.login, "github-actions[bot]");
  });

  test(`${kind}: personal answers bind to authenticated source-author ID, not payload or login`, async () => {
    for (const sender of [
      { type: "User", id: 202, login: "author" },
      { type: "Bot", id: 101, login: "author" },
      { type: "User", login: "author" },
      undefined,
    ]) {
      const f = fixture(kind);
      f.context.eventName = "repository_dispatch";
      f.context.payload.action = "amp-pr-report";
      f.context.payload.sender = sender;
      f.context.payload.client_payload = {
        operation: "answer",
        source_kind: kind,
        pr_number: 1520,
        comment_id: 69,
        body: "Wrong owner's Puck answer",
        sender: f.state.source.user,
        source_author: { github_id: 101, github_login: "author" },
      };
      assert.ok((await reportMention(f)).blocked);
      assert.equal(f.state.comments.length, 0);
      assert.equal(f.state.reactions.length, 0);
      // Shared QA reporting does not require the source author's personal Puck.
      f.context.payload.client_payload.operation = "qa-report";
      f.context.payload.client_payload.body = "BLOCKED";
      await reportMention(f);
      assert.equal(f.state.comments.length, 1);
      assert.match(f.state.comments[0].body, /amp-qa:/);
    }
    const renamed = fixture(kind);
    renamed.context.eventName = "repository_dispatch";
    renamed.context.payload.action = "amp-pr-report";
    renamed.context.payload.sender.login = "renamed-author";
    renamed.context.payload.client_payload = {
      operation: "answer",
      source_kind: kind,
      pr_number: 1520,
      comment_id: 69,
      body: "Same author's Puck answer",
    };
    await reportMention(renamed);
    assert.match(renamed.state.comments[0].body, /Same author's Puck answer/);
  });

  test(`${kind}: unavailable personal routing is disclosed once without a Puck or QA claim`, async () => {
    const f = fixture(kind);
    f.context.eventName = "repository_dispatch";
    f.context.payload.action = "amp-pr-report";
    f.context.payload.sender.id = 202;
    f.context.payload.client_payload = {
      operation: "routing-blocked",
      source_kind: kind,
      pr_number: 1520,
      comment_id: 69,
      body: "Private Puck history must not be published",
    };
    await reportMention(f);
    await reportMention(f);
    assert.equal(f.state.comments.length, 1);
    assert.equal(f.state.reactions.length, 0);
    assert.match(f.state.comments[0].body, /amp-routing:/);
    assert.match(f.state.comments[0].body, /ROUTING_BLOCKED/);
    assert.match(f.state.comments[0].body, /未轉送到他人的 Puck，也未啟動 QA/);
    assert.doesNotMatch(f.state.comments[0].body, /Private Puck history/);
    assert.equal(
      f.state.comments[0].in_reply_to_id,
      kind === "review" ? 14 : undefined,
    );
  });
}

test("a root review mention stays in its own review thread", async () => {
  const f = fixture();
  delete f.state.source.in_reply_to_id;
  await reportMention(f);
  assert.equal(f.state.comments[0].in_reply_to_id, 69);
  assert.equal(f.state.reactions[0].comment_id, 69);
});

test("an ambiguous receipt write can retry without duplicating or losing verification metadata", async () => {
  const f = fixture();
  const create = f.github.rest.pulls.createReplyForReviewComment;
  f.github.rest.pulls.createReplyForReviewComment = async (args) => {
    await create(args);
    throw new Error("Connection lost after GitHub accepted the comment");
  };
  await assert.rejects(reportMention(f));
  f.github.rest.pulls.createReplyForReviewComment = create;
  const result = await reportMention(f);
  assert.equal(f.state.comments.length, 1);
  assert.equal(f.state.reactions.length, 1);
  assert.equal(result.operation, "receipt");
  assert.equal(result.source_key, "review-69");
  assert.equal(result.source_url, f.state.source.html_url);
  assert.equal(result.comment_url, f.state.comments[0].html_url);
});

test("ineligible mentions cause neither reactions nor public replies", async () => {
  for (const change of [
    (f) => {
      f.state.source.body = "> @amp qa";
    },
    (f) => {
      f.state.source.body = "@amp-qa";
    },
    (f) => {
      f.state.source.user.type = "Bot";
    },
    (f) => {
      f.state.source.updated_at = "2026-10-13T05:20:00Z";
    },
    (f) => {
      f.state.permission = "read";
    },
    (f) => {
      f.state.pr.state = "closed";
    },
    (f) => {
      f.state.pr.head.repo.full_name = "fork/amp-qa-lab";
    },
    (f) => {
      f.state.pr.labels = [];
    },
    (f) => {
      f.context.payload.action = "edited";
    },
    (f) => {
      f.context.eventName = "pull_request_review";
    },
    (f) => {
      f.context.eventName = "pull_request_review_comment";
      f.context.payload.action = "created";
    },
  ]) {
    const f = fixture();
    change(f);
    assert.ok((await reportMention(f)).ignored);
    assert.equal(f.state.reactions.length, 0);
    assert.equal(f.state.comments.length, 0);
  }
});

test("wrong PR source/parent and untrusted reporter branch fail before writing", async () => {
  for (const change of [
    (f) => {
      f.state.source.pull_request_url =
        "https://api.github.com/repos/vincentbility/amp-qa-lab/pulls/999";
    },
    (f) => {
      f.state.root.pull_request_url =
        "https://api.github.com/repos/vincentbility/amp-qa-lab/pulls/999";
    },
    (f) => {
      f.state.root.in_reply_to_id = 7;
    },
    (f) => {
      f.context.eventName = "repository_dispatch";
      f.context.payload.action = "amp-pr-report";
      f.context.ref = "refs/heads/untrusted";
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(reportMention(f));
    assert.equal(f.state.reactions.length, 0);
    assert.equal(f.state.comments.length, 0);
  }
});

test("untrusted relay metadata cannot authorize a wrong PR, author or old source", async () => {
  for (const change of [
    (f) => {
      f.state.relay.path = ".github/workflows/other.yml";
    },
    (f) => {
      f.state.relay.event = "workflow_dispatch";
    },
    (f) => {
      f.state.relay.conclusion = "failure";
    },
    (f) => {
      f.state.relay.repository.full_name = "other/repo";
    },
    (f) => {
      f.state.relay.display_title = "Amp review receipt PR 999 comment 69";
    },
    (f) => {
      f.state.relay.display_title = "Amp review receipt PR 1520 comment $(id)";
    },
    (f) => {
      f.state.relay.actor.id = 202;
    },
    (f) => {
      f.state.relay.created_at = "2026-10-13T05:24:56Z";
    },
    (f) => {
      f.state.relay.created_at = "2026-10-13T05:19:54Z";
    },
  ]) {
    const f = fixture();
    change(f);
    assert.ok((await reportMention(f)).ignored);
    assert.equal(f.state.reactions.length, 0);
    assert.equal(f.state.comments.length, 0);
  }
  const boundary = fixture();
  boundary.state.relay.created_at = "2026-10-13T05:24:55Z";
  boundary.state.relay.actor.login = "renamed-author";
  await reportMention(boundary);
  assert.equal(boundary.state.reactions.length, 1);
  assert.equal(boundary.state.comments.length, 1);
});

test("PR-opening QA reports update one bot comment without a fabricated mention", async () => {
  const f = fixture("issue");
  Object.assign(f.state.pr, {
    user: { type: "User", login: "author" },
    html_url: "https://github.com/vincentbility/amp-qa-lab/pull/1520",
    updated_at: "2026-10-13T05:19:55Z",
  });
  f.context.eventName = "repository_dispatch";
  f.context.payload.action = "amp-pr-report";
  f.context.payload.client_payload = {
    operation: "qa-report",
    source_kind: "opened",
    pr_number: 1520,
  };
  for (const body of ["QUEUED", "BLOCKED"]) {
    f.context.payload.client_payload.body = body;
    await reportMention(f);
  }
  assert.equal(f.state.comments.length, 1);
  assert.equal(f.state.reactions.length, 0);
  assert.match(f.state.comments[0].body, /^<!-- amp-qa:pr-1520-opened -->/);
  assert.match(f.state.comments[0].body, /BLOCKED/);
  f.context.payload.client_payload.operation = "answer";
  await assert.rejects(reportMention(f));
  assert.equal(f.state.comments.length, 1);
});
