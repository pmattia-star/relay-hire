// netlify/functions/slack-interactions.js
// Two parallel approvers — both must approve before requester is notified

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const APPROVER_1_SLACK_ID = process.env.APPROVER_SLACK_ID;
const APPROVER_2_SLACK_ID = process.env.APPROVER_2_SLACK_ID;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

async function getGoogleToken() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const pemContents = credentials.private_key.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\n/g, "");
  const binaryKey = Buffer.from(pemContents, "base64");
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, Buffer.from(signingInput));
  const jwt = `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt })
  });
  return (await tokenRes.json()).access_token;
}

async function appendToSheet(token, values) {
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Sheet1!A:P:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [values] })
    }
  );
}

async function updateSheetRow(token, requestId, status, approverCol, approverName) {
  const readRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Sheet1!A:A`,
    { headers: { "Authorization": `Bearer ${token}` } }
  );
  const rows = (await readRes.json()).values || [];
  const rowIndex = rows.findIndex(row => row[0] === requestId);
  if (rowIndex === -1) return;
  const rowNumber = rowIndex + 1;

  // approverCol is "M" for approver1, "N" for approver2
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Sheet1!${approverCol}${rowNumber}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[approverName]] })
    }
  );

  // Update overall status in column L
  if (status) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Sheet1!L${rowNumber}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[status]] })
      }
    );
  }
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
    pre_approved:   get("pre_approved"),
    justification:  get("justification")
  };
}

const TEAM_LABELS = { data_analytics: "Data & Analytics", engineering: "Engineering", operations: "Operations", finance: "Finance", commercial: "Commercial", people: "People", product: "Product", other: "Other" };
const REASON_LABELS = { backfill: "Backfill (leaver)", new_hc: "New headcount (growth)", project: "Project / contract", restructure: "Restructure" };

function buildApprovalBlocks(vals, userId, requestId, approverNum) {
  return [
    { type: "header", text: { type: "plain_text", text: "🧑‍💼 New Hire Request" } },
    { type: "section", text: { type: "mrkdwn", text: `Submitted by <@${userId}>` } },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Role*\n${vals.role_title}` },
        { type: "mrkdwn", text: `*Team*\n${TEAM_LABELS[vals.team] ?? vals.team}` },
        { type: "mrkdwn", text: `*Level*\n${vals.level}` },
        { type: "mrkdwn", text: `*Hiring Manager*\n<@${vals.hiring_manager}>` },
        { type: "mrkdwn", text: `*Target Start*\n${vals.start_date}` },
        { type: "mrkdwn", text: `*Salary Range*\n£${vals.salary_range}` },
        { type: "mrkdwn", text: `*Reason*\n${REASON_LABELS[vals.reason] ?? vals.reason}` },
        { type: "mrkdwn", text: `*Pre-Approved?*\n${vals.pre_approved === "yes" ? "✅ Yes" : "❌ No"}` }
      ]
    },
    { type: "section", text: { type: "mrkdwn", text: `*Justification*\n${vals.justification || "N/A"}` } },
    { type: "divider" },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "✅  Approve" }, style: "primary", action_id: "approve_hire", value: JSON.stringify({ requestId, requesterId: userId, approverNum }) },
        { type: "button", text: { type: "plain_text", text: "❌  Reject" }, style: "danger", action_id: "reject_hire", value: JSON.stringify({ requestId, requesterId: userId, approverNum }) }
      ]
    }
  ];
}

async function handleModalSubmission(payload) {
  const vals     = extractValues(payload.view);
  const userId   = payload.user.id;
  const userName = payload.user.name;

  if (vals.pre_approved === "no" && (!vals.justification || vals.justification.trim() === "")) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_action: "errors",
        errors: { justification: "Business justification is required when the role has not been pre-approved." }
      })
    };
  }

  const { data, error } = await supabase
    .from("hire_requests")
    .insert([{
      requester_slack_id: userId, requester_name: userName,
      role_title: vals.role_title, team: vals.team, level: vals.level,
      hiring_manager_slack: vals.hiring_manager, target_start_date: vals.start_date,
      salary_range: vals.salary_range, reason: vals.reason,
      pre_approved: vals.pre_approved === "yes",
      justification: vals.justification, status: "pending",
      approver1_status: "pending", approver2_status: "pending"
    }])
    .select().single();

  if (error) { console.error("Supabase error:", error); return { statusCode: 200, body: "" }; }
  const requestId = data.id;

  // Log to Google Sheets
  try {
    const gToken = await getGoogleToken();
    const checkRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Sheet1!A1`,
      { headers: { "Authorization": `Bearer ${gToken}` } }
    );
    const checkData = await checkRes.json();
    if (!checkData.values) {
      await appendToSheet(gToken, ["Request ID","Submitted At","Requester","Role Title","Team","Level","Hiring Manager","Target Start","Salary Range","Reason","Pre-Approved?","Status","Approver 1 (Josh)","Approver 2","Justification"]);
    }
    await appendToSheet(gToken, [
      requestId, new Date().toISOString(), userName,
      vals.role_title, TEAM_LABELS[vals.team] ?? vals.team,
      vals.level, vals.hiring_manager,
      vals.start_date, vals.salary_range,
      REASON_LABELS[vals.reason] ?? vals.reason,
      vals.pre_approved === "yes" ? "Yes" : "No",
      "Pending", "", "", vals.justification || "N/A"
    ]);
  } catch (e) { console.error("Sheets error:", e); }

  // DM both approvers simultaneously
  for (const [approverId, approverNum] of [[APPROVER_1_SLACK_ID, 1], [APPROVER_2_SLACK_ID, 2]]) {
    const dmRes = await slackPost("conversations.open", { users: approverId });
    const dmChannel = dmRes.channel?.id;
    if (dmChannel) {
      await slackPost("chat.postMessage", {
        channel: dmChannel,
        text: `New hire request from <@${userId}>`,
        blocks: buildApprovalBlocks(vals, userId, requestId, approverNum)
      });
    }
  }

  // Confirm to requester
  const requesterDm = await slackPost("conversations.open", { users: userId });
  const rc = requesterDm.channel?.id;
  if (rc) {
    await slackPost("chat.postMessage", {
      channel: rc,
      text: `✅ Your hire request for *${vals.role_title}* has been submitted and is pending approval from 2 approvers.`
    });
  }

  return { statusCode: 200, body: "" };
}

async function handleAction(payload) {
  const action      = payload.actions[0];
  const approved    = action.action_id === "approve_hire";
  const { requestId, requesterId, approverNum } = JSON.parse(action.value);
  const approverName = payload.user.name;

  const statusField = approverNum === 1 ? "approver1_status" : "approver2_status";
  const newStatus   = approved ? "approved" : "rejected";

  // Update this approver's status in Supabase
  await supabase.from("hire_requests")
    .update({ [statusField]: newStatus })
    .eq("id", requestId);

  // Fetch current state of both approvals
  const { data } = await supabase.from("hire_requests").select("*").eq("id", requestId).single();
  const approver1Done = data.approver1_status;
  const approver2Done = data.approver2_status;

  let overallStatus = null;
  let requesterMessage = null;

  if (!approved) {
    // Immediate rejection
    overallStatus = "rejected";
    requesterMessage = `❌ Your hire request for *${data.role_title}* has been *rejected* by <@${payload.user.id}>. Reach out to them directly for more detail.`;
    await supabase.from("hire_requests").update({ status: "rejected", decided_by: payload.user.id, decided_at: new Date().toISOString() }).eq("id", requestId);
  } else if (approver1Done === "approved" && approver2Done === "approved") {
    // Both approved
    overallStatus = "approved";
    requesterMessage = `✅ Your hire request for *${data.role_title}* has been *approved* by both approvers. People team will be in touch.`;
    await supabase.from("hire_requests").update({ status: "approved", decided_by: payload.user.id, decided_at: new Date().toISOString() }).eq("id", requestId);
  }

  // Update Google Sheet
  try {
    const gToken = await getGoogleToken();
    const approverCol = approverNum === 1 ? "M" : "N";
    const approverLabel = approved ? `✅ ${approverName}` : `❌ ${approverName}`;
    const sheetStatus = overallStatus === "approved" ? "Approved ✅" : overallStatus === "rejected" ? "Rejected ❌" : null;
    await updateSheetRow(gToken, requestId, sheetStatus, approverCol, approverLabel);
  } catch (e) { console.error("Sheets update error:", e); }

  // Update the approver's message (replace buttons with their decision)
  await slackPost("chat.update", {
    channel: payload.channel.id,
    ts: payload.message.ts,
    text: approved ? "You approved this hire request ✅" : "You rejected this hire request ❌",
    blocks: [
      ...payload.message.blocks.slice(0, -1),
      { type: "section", text: { type: "mrkdwn", text: approved ? `✅ *You approved this request*` : `❌ *You rejected this request*` } }
    ]
  });

  // Notify requester only on rejection or full approval
  if (requesterMessage) {
    const dmRes = await slackPost("conversations.open", { users: requesterId });
    const dc = dmRes.channel?.id;
    if (dc) {
      await slackPost("chat.postMessage", { channel: dc, text: requesterMessage });
    }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  const params  = new URLSearchParams(event.body);
  const payload = JSON.parse(params.get("payload"));
  if (payload.type === "view_submission" && payload.view.callback_id === "hire_request") {
    return await handleModalSubmission(payload);
  }
  if (payload.type === "block_actions") {
    await handleAction(payload);
    return { statusCode: 200, body: "" };
  }
  return { statusCode: 200, body: "" };
};
