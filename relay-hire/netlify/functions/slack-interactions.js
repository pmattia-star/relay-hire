// netlify/functions/slack-interactions.js
// Handles (1) modal submission → DM to approver
//         (2) approve/reject button clicks → notify requester + log to Supabase

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const APPROVER_SLACK_ID = process.env.APPROVER_SLACK_ID; // e.g. "U012AB3CD"

// ─── helpers ────────────────────────────────────────────────────────────────

async function slackPost(endpoint, body) {
  const res = await fetch(`https://slack.com/api/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

function extractValues(view) {
  const v = view.state.values;
  const get = (block) => {
    const field = v[block];
    if (!field) return null;
    const key = Object.keys(field)[0];
    const el = field[key];
    return el.value ?? el.selected_user ?? el.selected_option?.value ?? el.selected_date ?? null;
  };
  return {
    role_title:     get("role_title"),
    team:           get("team"),
    level:          get("level"),
    hiring_manager: get("hiring_manager"),
    start_date:     get("start_date"),
    salary_range:   get("salary_range"),
    reason:         get("reason"),
    justification:  get("justification")
  };
}

const TEAM_LABELS = {
  data_analytics: "Data & Analytics", engineering: "Engineering",
  operations: "Operations", finance: "Finance", commercial: "Commercial",
  people: "People", product: "Product", other: "Other"
};

const LEVEL_LABELS = {
  junior: "Junior / Associate", mid: "Mid-level", senior: "Senior",
  lead: "Lead / Principal", manager: "Manager", head_of: "Head of", director: "Director+"
};

const REASON_LABELS = {
  backfill: "Backfill (leaver)", new_hc: "New headcount (growth)",
  project: "Project / contract", restructure: "Restructure"
};

// ─── modal submission ────────────────────────────────────────────────────────

async function handleModalSubmission(payload) {
  const vals   = extractValues(payload.view);
  const userId = payload.user.id;
  const userName = payload.user.name;

  // Save to Supabase
  const { data, error } = await supabase
    .from("hire_requests")
    .insert([{
      requester_slack_id:   userId,
      requester_name:       userName,
      role_title:           vals.role_title,
      team:                 vals.team,
      level:                vals.level,
      hiring_manager_slack: vals.hiring_manager,
      target_start_date:    vals.start_date,
      salary_range:         vals.salary_range,
      reason:               vals.reason,
      justification:        vals.justification,
      status:               "pending"
    }])
    .select()
    .single();

  if (error) {
    console.error("Supabase insert error:", error);
    return;
  }

  const requestId = data.id;

  // Open a DM channel to the approver
  const dmRes = await slackPost("conversations.open", { users: APPROVER_SLACK_ID });
  const dmChannel = dmRes.channel?.id;
  if (!dmChannel) { console.error("Could not open DM:", dmRes); return; }

  // Send approval request DM
  await slackPost("chat.postMessage", {
    channel: dmChannel,
    text: `New hire request from <@${userId}>`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🧑‍💼 New Hire Request" }
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `Submitted by <@${userId}>` }
      },
      { type: "divider" },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Role*\n${vals.role_title}` },
          { type: "mrkdwn", text: `*Team*\n${TEAM_LABELS[vals.team] ?? vals.team}` },
          { type: "mrkdwn", text: `*Level*\n${LEVEL_LABELS[vals.level] ?? vals.level}` },
          { type: "mrkdwn", text: `*Hiring Manager*\n<@${vals.hiring_manager}>` },
          { type: "mrkdwn", text: `*Target Start*\n${vals.start_date}` },
          { type: "mrkdwn", text: `*Salary Range*\n£${vals.salary_range}` },
          { type: "mrkdwn", text: `*Reason*\n${REASON_LABELS[vals.reason] ?? vals.reason}` }
        ]
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Justification*\n${vals.justification}` }
      },
      { type: "divider" },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅  Approve" },
            style: "primary",
            action_id: "approve_hire",
            value: JSON.stringify({ requestId, requesterId: userId })
          },
          {
            type: "button",
            text: { type: "plain_text", text: "❌  Reject" },
            style: "danger",
            action_id: "reject_hire",
            value: JSON.stringify({ requestId, requesterId: userId })
          }
        ]
      }
    ]
  });

  // Confirm back to requester
  const requesterDm = await slackPost("conversations.open", { users: userId });
  const requesterChannel = requesterDm.channel?.id;
  if (requesterChannel) {
    await slackPost("chat.postMessage", {
      channel: requesterChannel,
      text: `✅ Your hire request for *${vals.role_title}* has been submitted and is pending approval.`
    });
  }
}

// ─── button click (approve / reject) ────────────────────────────────────────

async function handleAction(payload) {
  const action     = payload.actions[0];
  const actionId   = action.action_id;
  const { requestId, requesterId } = JSON.parse(action.value);
  const approverName = payload.user.name;

  const approved = actionId === "approve_hire";
  const newStatus = approved ? "approved" : "rejected";

  // Update Supabase
  await supabase
    .from("hire_requests")
    .update({ status: newStatus, decided_by: payload.user.id, decided_at: new Date().toISOString() })
    .eq("id", requestId);

  // Update the original approver message (replace buttons with outcome)
  await slackPost("chat.update", {
    channel: payload.channel.id,
    ts: payload.message.ts,
    text: approved ? "Hire request approved ✅" : "Hire request rejected ❌",
    blocks: [
      ...payload.message.blocks.slice(0, -1), // keep all blocks except actions
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: approved
            ? `✅ *Approved* by <@${payload.user.id}>`
            : `❌ *Rejected* by <@${payload.user.id}>`
        }
      }
    ]
  });

  // DM the requester with the outcome
  const dmRes = await slackPost("conversations.open", { users: requesterId });
  const dmChannel = dmRes.channel?.id;
  if (dmChannel) {
    await slackPost("chat.postMessage", {
      channel: dmChannel,
      text: approved
        ? `✅ Your hire request has been *approved* by <@${payload.user.id}>. People team will be in touch.`
        : `❌ Your hire request has been *rejected* by <@${payload.user.id}>. Reach out to them directly if you'd like more detail.`
    });
  }
}

// ─── main handler ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const params  = new URLSearchParams(event.body);
  const payload = JSON.parse(params.get("payload"));

  if (payload.type === "view_submission" && payload.view.callback_id === "hire_request") {
    await handleModalSubmission(payload);
    return { statusCode: 200, body: "" }; // empty = close modal
  }

  if (payload.type === "block_actions") {
    await handleAction(payload);
    return { statusCode: 200, body: "" };
  }

  return { statusCode: 200, body: "" };
};
