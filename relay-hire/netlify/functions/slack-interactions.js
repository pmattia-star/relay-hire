// netlify/functions/slack-interactions.js
// Handles (1) modal submission → DM to approver + logs to Supabase + Google Sheets
//         (2) approve/reject button clicks → notify requester + update sheet

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const APPROVER_SLACK_ID = process.env.APPROVER_SLACK_ID;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

async function getGoogleToken() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  })).toString("base64url");

  const signingInput = `${header}.${payload}`;

  const pemContents = credentials.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\n/g, "");

  const binaryKey = Buffer.from(pemContents, "base64");
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, Buffer.from(signingInput));
  const jwt = `${signingInput}.${Buffer.from(signature).toString("base64url")}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt })
  });

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

async function appendToSheet(token, values) {
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Sheet1!A:M:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [values] })
    }
  );
}

async function updateSheetStatus(token, requestId, status, decidedBy) {
  const readRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Sheet1!A:A`,
    { headers: { "Authorization": `Bearer ${token}` } }
  );
  const readData = await readRes.json();
  const rows = readData.values || [];
  const rowIndex = rows.findIndex(row => row[0] === requestId);
  if (rowIndex === -1) return;
  const rowNumber = rowIndex + 1;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Sheet1!L${rowNumber}:M${rowNumber}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[status, decidedBy]] })
    }
  );
}

async function slackPost(endpoint, body) {
  const res = await fetch(`https://slack.com/api/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}` },
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

const TEAM_LABELS = { data_analytics: "Data & Analytics", engineering: "Engineering", operations: "Operations", finance: "Finance", commercial: "Commercial", people: "People", product: "Product", other: "Other" };
const LEVEL_LABELS = { junior: "Junior / Associate", mid: "Mid-level", senior: "Senior", lead: "Lead / Principal", manager: "Manager", head_of: "Head of", director: "Director+" };
const REASON_LABELS = { backfill: "Backfill (leaver)", new_hc: "New headcount (growth)", project: "Project / contract", restructure: "Restructure" };

async function handleModalSubmission(payload) {
  const vals     = extractValues(payload.view);
  const userId   = payload.user.id;
  const userName = payload.user.name;

  const { data, error } = await supabase
    .from("hire_requests")
    .insert([{
      requester_slack_id: userId, requester_name: userName,
      role_title: vals.role_title, team: vals.team, level: vals.level,
      hiring_manager_slack: vals.hiring_manager, target_start_date: vals.start_date,
      salary_range: vals.salary_range, reason: vals.reason,
      justification: vals.justification, status: "pending"
    }])
    .select().single();

  if (error) { console.error("Supabase error:", error); return; }
  const requestId = data.id;

  try {
    const gToken = await getGoogleToken();
    const checkRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Sheet1!A1`,
      { headers: { "Authorization": `Bearer ${gToken}` } }
    );
    const checkData = await checkRes.json();
    if (!checkData.values) {
      await appendToSheet(gToken, ["Request ID","Submitted At","Requester","Role Title","Team","Level","Hiring Manager","Target Start","Salary Range","Reason","Justification","Status","Decided By"]);
    }
    await appendToSheet(gToken, [
      requestId, new Date().toISOString(), userName,
      vals.role_title, TEAM_LABELS[vals.team] ?? vals.team,
      LEVEL_LABELS[vals.level] ?? vals.level, vals.hiring_manager,
      vals.start_date, vals.salary_range,
      REASON_LABELS[vals.reason] ?? vals.reason, vals.justification,
      "Pending", ""
    ]);
  } catch (e) { console.error("Sheets error:", e); }

  const dmRes = await slackPost("conversations.open", { users: APPROVER_SLACK_ID });
  const dmChannel = dmRes.channel?.id;
  if (!dmChannel) return;

  await slackPost("chat.postMessage", {
    channel: dmChannel,
    text: `New hire request from <@${userId}>`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "🧑‍💼 New Hire Request" } },
      { type: "section", text: { type: "mrkdwn", text: `Submitted by <@${userId}>` } },
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
      { type: "section", text: { type: "mrkdwn", text: `*Justification*\n${vals.justification}` } },
      { type: "divider" },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "✅  Approve" }, style: "primary", action_id: "approve_hire", value: JSON.stringify({ requestId, requesterId: userId }) },
          { type: "button", text: { type: "plain_text", text: "❌  Reject" }, style: "danger", action_id: "reject_hire", value: JSON.stringify({ requestId, requesterId: userId }) }
        ]
      }
    ]
  });

  const requesterDm = await slackPost("conversations.open", { users: userId });
  const rc = requesterDm.channel?.id;
  if (rc) {
    await slackPost("chat.postMessage", {
      channel: rc,
      text: `✅ Your hire request for *${vals.role_title}* has been submitted and is pending approval.`
    });
  }
}

async function handleAction(payload) {
  const action   = payload.actions[0];
  const approved = action.action_id === "approve_hire";
  const { requestId, requesterId } = JSON.parse(action.value);
  const newStatus = approved ? "approved" : "rejected";

  await supabase.from("hire_requests")
    .update({ status: newStatus, decided_by: payload.user.id, decided_at: new Date().toISOString() })
    .eq("id", requestId);

  try {
    const gToken = await getGoogleToken();
    await updateSheetStatus(gToken, requestId, approved ? "Approved ✅" : "Rejected ❌", payload.user.name);
  } catch (e) { console.error("Sheets update error:", e); }

  await slackPost("chat.update", {
    channel: payload.channel.id,
    ts: payload.message.ts,
    text: approved ? "Hire request approved ✅" : "Hire request rejected ❌",
    blocks: [
      ...payload.message.blocks.slice(0, -1),
      { type: "section", text: { type: "mrkdwn", text: approved ? `✅ *Approved* by <@${payload.user.id}>` : `❌ *Rejected* by <@${payload.user.id}>` } }
    ]
  });

  const dmRes = await slackPost("conversations.open", { users: requesterId });
  const dc = dmRes.channel?.id;
  if (dc) {
    await slackPost("chat.postMessage", {
      channel: dc,
      text: approved
        ? `✅ Your hire request has been *approved* by <@${payload.user.id}>. People team will be in touch.`
        : `❌ Your hire request has been *rejected* by <@${payload.user.id}>. Reach out to them directly if you'd like more detail.`
    });
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  const params  = new URLSearchParams(event.body);
  const payload = JSON.parse(params.get("payload"));
  if (payload.type === "view_submission" && payload.view.callback_id === "hire_request") {
    await handleModalSubmission(payload);
    return { statusCode: 200, body: "" };
  }
  if (payload.type === "block_actions") {
    await handleAction(payload);
    return { statusCode: 200, body: "" };
  }
  return { statusCode: 200, body: "" };
};
