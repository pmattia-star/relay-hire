// netlify/functions/hire.js
// Handles the /hire slash command — opens a modal in Slack

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const params = new URLSearchParams(event.body);
  const triggerId = params.get("trigger_id");

  const modal = {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "hire_request",
      title: { type: "plain_text", text: "Request a Hire 🚀" },
      submit: { type: "plain_text", text: "Submit for Approval" },
      close:  { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "role_title",
          label: { type: "plain_text", text: "Role Title" },
          element: {
            type: "plain_text_input",
            action_id: "value",
            placeholder: { type: "plain_text", text: "e.g. Senior Data Scientist" }
          }
        },
        {
          type: "input",
          block_id: "team",
          label: { type: "plain_text", text: "Team" },
          element: {
            type: "static_select",
            action_id: "value",
            placeholder: { type: "plain_text", text: "Select team" },
            options: [
              { text: { type: "plain_text", text: "Data & Analytics" },   value: "data_analytics" },
              { text: { type: "plain_text", text: "Engineering" },         value: "engineering" },
              { text: { type: "plain_text", text: "Operations" },          value: "operations" },
              { text: { type: "plain_text", text: "Finance" },             value: "finance" },
              { text: { type: "plain_text", text: "Commercial" },          value: "commercial" },
              { text: { type: "plain_text", text: "People" },              value: "people" },
              { text: { type: "plain_text", text: "Product" },             value: "product" },
              { text: { type: "plain_text", text: "Other" },               value: "other" }
            ]
          }
        },
        {
          type: "input",
          block_id: "level",
          label: { type: "plain_text", text: "Level / Grade" },
          element: {
            type: "static_select",
            action_id: "value",
            placeholder: { type: "plain_text", text: "Select level" },
            options: [
              { text: { type: "plain_text", text: "IC1" }, value: "IC1" },
              { text: { type: "plain_text", text: "IC2" }, value: "IC2" },
              { text: { type: "plain_text", text: "IC3" }, value: "IC3" },
              { text: { type: "plain_text", text: "IC4" }, value: "IC4" },
              { text: { type: "plain_text", text: "IC5" }, value: "IC5" },
              { text: { type: "plain_text", text: "IC6" }, value: "IC6" },
              { text: { type: "plain_text", text: "PM3" }, value: "PM3" },
              { text: { type: "plain_text", text: "PM4" }, value: "PM4" },
              { text: { type: "plain_text", text: "PM5" }, value: "PM5" },
              { text: { type: "plain_text", text: "PM6" }, value: "PM6" },
              { text: { type: "plain_text", text: "PM7" }, value: "PM7" },
              { text: { type: "plain_text", text: "PM8" }, value: "PM8" }
            ]
          }
        },
        {
          type: "input",
          block_id: "hiring_manager",
          label: { type: "plain_text", text: "Hiring Manager" },
          element: {
            type: "users_select",
            action_id: "value",
            placeholder: { type: "plain_text", text: "Select hiring manager" }
          }
        },
        {
          type: "input",
          block_id: "start_date",
          label: { type: "plain_text", text: "Target Start Date" },
          element: {
            type: "datepicker",
            action_id: "value",
            placeholder: { type: "plain_text", text: "Select date" }
          }
        },
        {
          type: "input",
          block_id: "salary_range",
          label: { type: "plain_text", text: "Salary Range (£)" },
          element: {
            type: "plain_text_input",
            action_id: "value",
            placeholder: { type: "plain_text", text: "e.g. 55,000 – 65,000" }
          }
        },
        {
          type: "input",
          block_id: "reason",
          label: { type: "plain_text", text: "Reason for Hire" },
          element: {
            type: "static_select",
            action_id: "value",
            placeholder: { type: "plain_text", text: "Select reason" },
            options: [
              { text: { type: "plain_text", text: "Backfill (leaver)"        }, value: "backfill" },
              { text: { type: "plain_text", text: "New headcount (growth)"   }, value: "new_hc" },
              { text: { type: "plain_text", text: "Project / contract"       }, value: "project" },
              { text: { type: "plain_text", text: "Restructure"              }, value: "restructure" }
            ]
          }
        },
        {
          type: "input",
          block_id: "pre_approved",
          label: { type: "plain_text", text: "Has this role already been approved?" },
          element: {
            type: "static_select",
            action_id: "value",
            placeholder: { type: "plain_text", text: "Select one" },
            options: [
              { text: { type: "plain_text", text: "Yes — already approved" }, value: "yes" },
              { text: { type: "plain_text", text: "No — needs approval"    }, value: "no" }
            ]
          }
        },
        {
          type: "input",
          block_id: "justification",
          label: { type: "plain_text", text: "Business Justification" },
          hint: { type: "plain_text", text: "Required if role has not already been approved" },
          optional: false,
          element: {
            type: "plain_text_input",
            action_id: "value",
            multiline: true,
            placeholder: { type: "plain_text", text: "Why is this role needed now? What's the impact of not hiring?" }
          }
        }
      ]
    }
  };

  const slackRes = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify(modal)
  });

  const result = await slackRes.json();
  if (!result.ok) {
    console.error("Slack modal error:", result);
    return { statusCode: 500, body: "Failed to open modal" };
  }

  return { statusCode: 200, body: "" };
};
