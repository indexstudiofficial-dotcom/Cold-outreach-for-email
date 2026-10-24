// ============================================================
// OUTREACH EMAIL WORKER
//
// WORKFLOW:
// 1. Supabase Cron sends POST.
// 2. Find oldest leads row where message IS NULL.
// 3. Get the matching application.
// 4. Find the application's connected Gmail integration.
// 5. Generate a personalized email using Sarvam AI.
// 6. Send using Composio GMAIL_SEND_EMAIL.
// 7. Save the email body to leads.message.
//
// REQUIRED CLOUDFLARE SECRETS:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// SARVAM_API_KEY
// COMPOSIO_API_KEY
//
// EXISTING DATABASE TABLES:
// leads
// applications
// user_integrations
//
// No database columns are added.
// planner_status is never accessed.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const COMPOSIO_BASE_URL =
  "https://backend.composio.dev/api/v3.1";

const COMPOSIO_GMAIL_TOOL =
  "GMAIL_SEND_EMAIL";


// ============================================================
// MAIN HANDLER
// ============================================================

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json({
        ok: false,
        error: "POST requests only"
      }, 405);
    }

    try {
      validateEnvironment(env);

      // ------------------------------------------------------
      // STEP 1: FIND OLDEST LEAD WITH NULL MESSAGE
      // ------------------------------------------------------

      const lead = await getOldestPendingLead(env);

      if (!lead) {
        return json({
          ok: true,
          processed: false,
          reason: "No leads with NULL message"
        });
      }

      console.log("Processing lead:", lead.id);

      // ------------------------------------------------------
      // STEP 2: VALIDATE LEAD
      // ------------------------------------------------------

      if (!lead.application_id || !lead.user_id) {
        throw new Error(
          "Lead is missing application_id or user_id"
        );
      }

      if (!isValidEmail(lead.email)) {
        throw new Error(
          `Lead ${lead.id} has no valid recipient email`
        );
      }

      // ------------------------------------------------------
      // STEP 3: GET APPLICATION
      //
      // applications.name = company name
      // applications.company = company/product description
      // applications.domain = company domain
      //
      // planner_status is NOT used.
      // ------------------------------------------------------

      const application = await getApplication(
        env,
        lead.application_id,
        lead.user_id
      );

      if (!application) {
        throw new Error(
          "Application not found for this lead"
        );
      }

      if (
        !application.name ||
        !application.company ||
        !application.domain
      ) {
        throw new Error(
          "Application must contain name, company description, and domain"
        );
      }

      const senderDomain = normalizeDomain(
        application.domain
      );

      if (!senderDomain) {
        throw new Error(
          "Invalid sender domain in applications.domain"
        );
      }

      // ------------------------------------------------------
      // STEP 4: FIND CONNECTED GMAIL ACCOUNT
      //
      // Must match:
      // application_id
      // user_id
      // integration_id = gmail
      // status = connected
      // ------------------------------------------------------

      const gmail = await getGmailIntegration(
        env,
        lead.application_id,
        lead.user_id
      );

      if (!gmail) {
        throw new Error(
          "No connected Gmail integration found for this application and user"
        );
      }

      // ------------------------------------------------------
      // STEP 5: GET CONSISTENT SENDER NAME
      //
      // These are fictional example names.
      // Use a name the account owner is authorized to send as.
      // No additional database column is required.
      // ------------------------------------------------------

      const senderName = chooseSenderName(
        application.id
      );

      // ------------------------------------------------------
      // STEP 6: GENERATE EMAIL USING SARVAM AI
      // ------------------------------------------------------

      const generated = await generateEmail(
        env,
        lead,
        application,
        senderName,
        senderDomain
      );

      const subject = cleanText(
        generated.subject
      );

      const message = cleanText(
        generated.message
      );

      if (!subject || !message) {
        throw new Error(
          "Sarvam returned an empty subject or email body"
        );
      }

      if (containsPlaceholders(subject + "\n" + message)) {
        throw new Error(
          "Generated email contains unresolved placeholders"
        );
      }

      verifySignature(
        message,
        senderName,
        senderDomain
      );

      // ------------------------------------------------------
      // STEP 7: SEND EMAIL THROUGH COMPOSIO
      // ------------------------------------------------------

      const sendResult = await sendEmailWithComposio(
        env,
        gmail.connection_id,
        lead.user_id,
        lead.email,
        subject,
        message
      );

      // Do not save the message if execution failed.
      if (!sendResult.success) {
        throw new Error(
          "Composio email execution failed: " +
          safeError(sendResult.response)
        );
      }

      // ------------------------------------------------------
      // STEP 8: SAVE MESSAGE AFTER SUCCESSFUL SEND
      //
      // Only update if message is still NULL.
      // ------------------------------------------------------

      await saveMessage(
        env,
        lead.id,
        message
      );

      // ------------------------------------------------------
      // STEP 9: RETURN SUCCESS
      // ------------------------------------------------------

      return json({
        ok: true,
        processed: true,
        lead_id: lead.id,
        recipient: lead.email,
        subject: subject,
        sender_name: senderName,
        sender_domain: senderDomain,
        message_saved: true
      });

    } catch (error) {
      console.error(
        "Outreach Worker error:",
        error.message
      );

      return json({
        ok: false,
        error: error.message || "Unknown error"
      }, 500);
    }
  }
};


// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

function validateEnvironment(env) {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SARVAM_API_KEY",
    "COMPOSIO_API_KEY"
  ];

  for (const key of required) {
    if (!env[key]) {
      throw new Error(
        `Missing Cloudflare secret: ${key}`
      );
    }
  }
}


// ============================================================
// SUPABASE REST REQUEST
// ============================================================

async function supabaseRequest(
  env,
  path,
  options = {}
) {
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  const response = await fetch(
    `${baseUrl}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization":
          `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase HTTP ${response.status}: ` +
      safeError(data)
    );
  }

  return data;
}


// ============================================================
// FIND OLDEST LEAD WITH NULL MESSAGE
// ============================================================

async function getOldestPendingLead(env) {
  const query =
    "leads" +
    "?select=id,application_id,user_id,first_name,last_name," +
    "full_name,email,email_status,job_title,linkedin_url," +
    "company_name,company_domain,company_website," +
    "company_industry,company_size,company_country,company_city," +
    "message,created_at" +
    "&message=is.null" +
    "&order=created_at.asc" +
    "&limit=1";

  const rows = await supabaseRequest(
    env,
    query,
    { method: "GET" }
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return rows[0];
}


// ============================================================
// GET APPLICATION
// ============================================================

async function getApplication(
  env,
  applicationId,
  userId
) {
  const query =
    "applications" +
    "?select=id,user_id,name,company,domain" +
    "&id=eq." + encodeURIComponent(applicationId) +
    "&user_id=eq." + encodeURIComponent(userId) +
    "&limit=1";

  const rows = await supabaseRequest(
    env,
    query,
    { method: "GET" }
  );

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null;
}


// ============================================================
// GET USER'S CONNECTED GMAIL INTEGRATION
// ============================================================

async function getGmailIntegration(
  env,
  applicationId,
  userId
) {
  const query =
    "user_integrations" +
    "?select=id,user_id,application_id,integration_id," +
    "connection_id,status" +
    "&application_id=eq." +
      encodeURIComponent(applicationId) +
    "&user_id=eq." +
      encodeURIComponent(userId) +
    "&integration_id=eq.gmail" +
    "&status=eq.connected" +
    "&limit=1";

  const rows = await supabaseRequest(
    env,
    query,
    { method: "GET" }
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const integration = rows[0];

  if (!integration.connection_id) {
    return null;
  }

  return integration;
}


// ============================================================
// SARVAM AI: GENERATE EMAIL
//
// IMPORTANT FIXES:
// - reasoning_effort: null prevents reasoning from consuming
//   the entire visible-output token budget.
// - max_tokens: 2048 gives the email sufficient output space.
// - response_format: json_object requests valid JSON.
// - Better diagnostics report the actual API response if
//   the content is missing.
// ============================================================

async function generateEmail(
  env,
  lead,
  application,
  senderName,
  senderDomain
) {
  const systemPrompt = `
You are a professional B2B outreach email writer.

Generate one personalized outreach email using the data provided.

SENDER:
Company name: ${application.name}
Product description: ${application.company}
Domain: ${senderDomain}
Sender name: ${senderName}

LEAD:
First name: ${lead.first_name || ""}
Last name: ${lead.last_name || ""}
Full name: ${lead.full_name || ""}
Job title: ${lead.job_title || ""}
Company: ${lead.company_name || ""}
Company domain: ${lead.company_domain || ""}
Website: ${lead.company_website || ""}
Industry: ${lead.company_industry || ""}
Company size: ${lead.company_size || ""}
Country: ${lead.company_country || ""}
City: ${lead.company_city || ""}

EMAIL RULES:

1. Use the lead's real first name in the greeting when available.
2. Personalize using the person's job title and company information.
3. Explain the sender's actual product and relevant benefits.
4. Do not invent facts, relationships, research, or business problems.
5. Do not assume the lead's company uses Shopify without evidence.
6. If company fit is uncertain, write a cautious, relevant introduction.
7. Write approximately 60-120 words.
8. Use a natural, professional tone.
9. Include one simple, low-pressure question.
10. The sender company name may appear in the body naturally.
11. Do not include the sender company name in the signature.
12. Never use unresolved placeholders.
13. Do not claim guaranteed results.
14. Generate a draft; the worker will send it.
15. Return a JSON object only.

SIGNATURE:

Best,
${senderName}
${senderDomain}

The signature must match this format exactly.
Do not add anything after the domain.

OUTPUT JSON:

{
  "subject": "Email subject",
  "message": "Complete email body including greeting and signature"
}
`;

  const leadData = {
    first_name: lead.first_name,
    last_name: lead.last_name,
    full_name: lead.full_name,
    job_title: lead.job_title,
    email: lead.email,
    company_name: lead.company_name,
    company_domain: lead.company_domain,
    company_website: lead.company_website,
    company_industry: lead.company_industry,
    company_size: lead.company_size,
    company_country: lead.company_country,
    company_city: lead.company_city
  };

  const requestBody = {
    model: "sarvam-105b",

    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content:
          "Generate the outreach email from this lead data:\n" +
          JSON.stringify(leadData)
      }
    ],

    temperature: 0.3,

    // CRITICAL FIX:
    // Disable reasoning so short email generation has
    // enough tokens for the actual visible response.
    reasoning_effort: null,

    // Give the generated JSON sufficient output space.
    max_tokens: 2048,

    // Ask Sarvam to return valid JSON.
    response_format: {
      type: "json_object"
    },

    stream: false
  };

  const response = await fetchWithTimeout(
    SARVAM_URL,
    {
      method: "POST",
      headers: {
        "api-subscription-key": env.SARVAM_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    },
    60000
  );

  const responseText = await response.text();

  let result;

  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Sarvam returned non-JSON HTTP response ` +
      `${response.status}: ${responseText.slice(0, 1000)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Sarvam API HTTP ${response.status}: ` +
      safeError(result)
    );
  }

  // --------------------------------------------------------
  // EXTRACT THE VISIBLE MODEL RESPONSE
  // --------------------------------------------------------

  const choice = result?.choices?.[0];

  let content =
    choice?.message?.content ??
    choice?.delta?.content ??
    choice?.text ??
    result?.output_text ??
    result?.content ??
    null;

  // Support APIs that return text blocks as an array.
  if (Array.isArray(content)) {
    content = content
      .map(item => {
        if (typeof item === "string") {
          return item;
        }

        return item?.text || "";
      })
      .join("\n");
  }

  if (typeof content !== "string" || !content.trim()) {
    // Return diagnostic information without exposing API keys.
    const finishReason =
      choice?.finish_reason || "unknown";

    const usage = result?.usage || null;

    const reasoningPresent = Boolean(
      choice?.message?.reasoning_content
    );

    console.error(
      "Sarvam empty content diagnostic:",
      JSON.stringify({
        http_status: response.status,
        model: result?.model,
        finish_reason: finishReason,
        usage,
        reasoning_content_present: reasoningPresent,
        choices_count: Array.isArray(result?.choices)
          ? result.choices.length
          : 0,
        response_preview: JSON.stringify(result).slice(0, 2500)
      })
    );

    throw new Error(
      "Sarvam returned no visible message content. " +
      `finish_reason=${finishReason}; ` +
      `reasoning_content_present=${reasoningPresent}; ` +
      `usage=${JSON.stringify(usage)}`
    );
  }

  // --------------------------------------------------------
  // PARSE GENERATED JSON
  // --------------------------------------------------------

  let generated;

  try {
    generated = parseModelJson(content);
  } catch {
    console.error(
      "Sarvam returned content that was not valid JSON:",
      content.slice(0, 2000)
    );

    throw new Error(
      "Sarvam generated content, but it was not valid email JSON"
    );
  }

  if (
    typeof generated.subject !== "string" ||
    typeof generated.message !== "string"
  ) {
    throw new Error(
      "Sarvam JSON is missing the subject or message field"
    );
  }

  return generated;
}


// ============================================================
// COMPOSIO: SEND GMAIL
//
// API endpoint:
// POST /api/v3.1/tools/execute/GMAIL_SEND_EMAIL
//
// The exact arguments must match the input schema of the
// GMAIL_SEND_EMAIL version enabled in your Composio project.
// ============================================================

async function sendEmailWithComposio(
  env,
  connectionId,
  userId,
  recipient,
  subject,
  body
) {
  const url =
    `${COMPOSIO_BASE_URL}/tools/execute/` +
    encodeURIComponent(COMPOSIO_GMAIL_TOOL);

  const requestBody = {
    connected_account_id: connectionId,
    user_id: userId,
    version: env.COMPOSIO_GMAIL_VERSION || "latest",

    arguments: {
      recipient_email: recipient,
      subject: subject,
      body: body
    }
  };

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "x-api-key": env.COMPOSIO_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    },
    60000
  );

  const responseText = await response.text();

  let result;

  try {
    result = responseText
      ? JSON.parse(responseText)
      : {};
  } catch {
    result = {
      raw_response: responseText.slice(0, 2000)
    };
  }

  if (!response.ok) {
    return {
      success: false,
      response: {
        http_status: response.status,
        details: result
      }
    };
  }

  // Fail closed: do not save leads.message unless the
  // Composio response explicitly confirms successful execution.
  //
  // Check common Composio response shapes.
  const successful =
    result.successful === true ||
    result.success === true;

  if (!successful) {
    return {
      success: false,
      response: result
    };
  }

  if (result.error) {
    return {
      success: false,
      response: result
    };
  }

  return {
    success: true,
    response: result
  };
}


// ============================================================
// SAVE EMAIL TO leads.message
// ============================================================

async function saveMessage(
  env,
  leadId,
  message
) {
  const query =
    "leads" +
    "?id=eq." + encodeURIComponent(leadId) +
    "&message=is.null";

  const updated = await supabaseRequest(
    env,
    query,
    {
      method: "PATCH",
      headers: {
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        message: message
      })
    }
  );

  if (!Array.isArray(updated) || updated.length === 0) {
    throw new Error(
      "The email may have been sent, but message could not be saved. " +
      "Do not blindly retry because that could send a duplicate."
    );
  }
}


// ============================================================
// CONSISTENT SENDER NAME
//
// Uses the same selection for the same application.
// Use only a sender identity authorized for the account.
// ============================================================

function chooseSenderName(applicationId) {
  const names = [
    "Alex Morgan",
    "Ryan Parker",
    "Emily Carter",
    "Jordan Bennett",
    "Taylor Brooks",
    "Daniel Foster",
    "Madison Reed",
    "Chris Mitchell"
  ];

  let hash = 0;

  for (let i = 0; i < applicationId.length; i++) {
    hash = (
      hash * 31 +
      applicationId.charCodeAt(i)
    ) >>> 0;
  }

  return names[hash % names.length];
}


// ============================================================
// DOMAIN NORMALIZATION
// ============================================================

function normalizeDomain(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    const input = /^https?:\/\//i.test(value.trim())
      ? value.trim()
      : "https://" + value.trim();

    return new URL(input)
      .hostname
      .replace(/^www\./i, "")
      .toLowerCase();

  } catch {
    return null;
  }
}


// ============================================================
// EMAIL VALIDATION
// ============================================================

function isValidEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  );
}


// ============================================================
// SIGNATURE VALIDATION
// ============================================================

function verifySignature(
  message,
  senderName,
  senderDomain
) {
  const normalized = message
    .replace(/\r\n/g, "\n")
    .trim();

  const expected =
    `Best,\n${senderName}\n${senderDomain}`;

  if (!normalized.endsWith(expected)) {
    throw new Error(
      "Generated signature does not match the required format"
    );
  }
}


// ============================================================
// PLACEHOLDER DETECTION
// ============================================================

function containsPlaceholders(value) {
  return (
    /\{\{[^}]+\}\}/.test(value) ||
    /\[(?:sender name|your company|your name|company name)\]/i.test(value)
  );
}


// ============================================================
// PARSE MODEL JSON
// ============================================================

function parseModelJson(content) {
  let value = content.trim();

  value = value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(value);
  } catch {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");

    if (start < 0 || end <= start) {
      throw new Error("No JSON object found");
    }

    return JSON.parse(
      value.slice(start, end + 1)
    );
  }
}


// ============================================================
// FETCH WITH TIMEOUT
// ============================================================

async function fetchWithTimeout(
  url,
  options,
  timeoutMs
) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `Request timed out: ${new URL(url).hostname}`
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}


// ============================================================
// SAFE ERROR STRING
// ============================================================

function safeError(value) {
  try {
    const result = typeof value === "string"
      ? value
      : JSON.stringify(value);

    return (result || "Unknown error").slice(0, 1800);

  } catch {
    return "Unknown error";
  }
}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
              }
