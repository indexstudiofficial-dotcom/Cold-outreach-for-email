// ============================================================
// OUTREACH EMAIL WORKER
//
// Flow:
// 1. Supabase Cron sends POST.
// 2. Find oldest lead where message IS NULL.
// 3. Load the application and product information.
// 4. Find the matching connected Gmail account.
// 5. Generate a personalized email using Sarvam AI.
// 6. Send using Composio GMAIL_SEND_EMAIL.
// 7. Save the email body in leads.message.
//
// Required Cloudflare secrets:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// SARVAM_API_KEY
// COMPOSIO_API_KEY
//
// Optional Cloudflare variable:
// COMPOSIO_GMAIL_VERSION = latest
//
// No database columns are added.
// planner_status is never accessed.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const COMPOSIO_BASE_URL =
  "https://backend.composio.dev/api/v3.1";

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const GMAIL_TOOL = "GMAIL_SEND_EMAIL";


// ============================================================
// MAIN REQUEST HANDLER
// ============================================================

export default {
  async fetch(request, env) {
    // --------------------------------------------------------
    // Only accept POST requests from the Cron workflow.
    // --------------------------------------------------------

    if (request.method !== "POST") {
      return jsonResponse(
        {
          ok: false,
          error: "POST requests only"
        },
        405
      );
    }

    try {
      validateEnvironment(env);

      // ------------------------------------------------------
      // Step 1: Find the oldest unprocessed lead.
      // ------------------------------------------------------

      const lead = await findOldestPendingLead(env);

      if (!lead) {
        return jsonResponse({
          ok: true,
          processed: false,
          reason: "No leads with a NULL message were found"
        });
      }

      // ------------------------------------------------------
      // Step 2: Validate required lead information.
      // ------------------------------------------------------

      if (!lead.application_id) {
        return jsonResponse({
          ok: false,
          processed: false,
          lead_id: lead.id,
          error: "Lead has no application_id"
        }, 400);
      }

      if (!lead.user_id) {
        return jsonResponse({
          ok: false,
          processed: false,
          lead_id: lead.id,
          error: "Lead has no user_id"
        }, 400);
      }

      if (!lead.email || !isValidEmail(lead.email)) {
        return jsonResponse({
          ok: false,
          processed: false,
          lead_id: lead.id,
          error: "Lead has no usable email address"
        }, 400);
      }

      // ------------------------------------------------------
      // Step 3: Load the application.
      //
      // applications.name    = sender company name
      // applications.company = company/product description
      // applications.domain  = sender company domain
      //
      // planner_status is not accessed.
      // ------------------------------------------------------

      const application = await getApplication(
        env,
        lead.application_id,
        lead.user_id
      );

      if (!application) {
        return jsonResponse({
          ok: false,
          processed: false,
          lead_id: lead.id,
          error: "Matching application was not found"
        }, 404);
      }

      if (!application.name || !application.company) {
        return jsonResponse({
          ok: false,
          processed: false,
          lead_id: lead.id,
          error:
            "Application is missing its company name or company description"
        }, 400);
      }

      if (!application.domain) {
        return jsonResponse({
          ok: false,
          processed: false,
          lead_id: lead.id,
          error:
            "Application domain is missing; cannot create the required signature"
        }, 400);
      }

      const senderDomain = normalizeDomain(
        application.domain
      );

      if (!senderDomain) {
        return jsonResponse({
          ok: false,
          processed: false,
          lead_id: lead.id,
          error: "Application domain is invalid"
        }, 400);
      }

      // ------------------------------------------------------
      // Step 4: Find this user's Gmail connection.
      //
      // Match all three:
      // - application_id
      // - user_id
      // - integration_id = gmail
      //
      // Never use another application's connection.
      // ------------------------------------------------------

      const gmail = await getGmailIntegration(
        env,
        lead.application_id,
        lead.user_id
      );

      if (!gmail) {
        return jsonResponse({
          ok: false,
          processed: false,
          lead_id: lead.id,
          error:
            "No connected Gmail integration exists for this user and application"
        }, 409);
      }

      // ------------------------------------------------------
      // Step 5: Generate the sender name.
      //
      // A deterministic selection ensures the same application
      // keeps the same sender name without adding a database
      // column.
      //
      // IMPORTANT:
      // Use a fictional sender name only if it is an authorized
      // identity for the account. Do not impersonate a real person.
      // ------------------------------------------------------

      const senderName = chooseSenderName(
        application.id
      );

      // ------------------------------------------------------
      // Step 6: Generate the personalized email using Sarvam.
      // ------------------------------------------------------

      const generatedEmail = await generateOutreachEmail(
        env,
        lead,
        application,
        senderName,
        senderDomain
      );

      // ------------------------------------------------------
      // Step 7: Check the AI result.
      // ------------------------------------------------------

      if (generatedEmail.fit_status === "not_a_fit") {
        // Do not send an irrelevant email.
        //
        // Because no new database columns are allowed and
        // message must remain NULL for unprocessed leads,
        // we return the reason without changing the lead.
        //
        // This means Cron may encounter this lead again.
        // See the limitation explained below.
        return jsonResponse({
          ok: true,
          processed: false,
          lead_id: lead.id,
          reason: "Lead is not a suitable prospect",
          fit_reason: generatedEmail.fit_reason
        });
      }

      if (
        generatedEmail.fit_status !== "qualified" &&
        generatedEmail.fit_status !== "needs_review"
      ) {
        throw new Error(
          "Sarvam returned an invalid fit_status"
        );
      }

      // Do not automatically send leads whose suitability
      // cannot be established.
      if (generatedEmail.fit_status === "needs_review") {
        return jsonResponse({
          ok: true,
          processed: false,
          lead_id: lead.id,
          reason: "Lead requires review before sending",
          fit_reason: generatedEmail.fit_reason
        });
      }

      const subject = cleanText(
        generatedEmail.subject
      );

      const body = cleanEmailBody(
        generatedEmail.message
      );

      if (!subject || !body) {
        throw new Error(
          "Sarvam returned an empty subject or email body"
        );
      }

      // ------------------------------------------------------
      // Step 8: Check for unresolved placeholders.
      // ------------------------------------------------------

      if (containsUnresolvedPlaceholders(subject + "\n" + body)) {
        throw new Error(
          "Generated email contains unresolved placeholders"
        );
      }

      // ------------------------------------------------------
      // Step 9: Verify the required signature.
      //
      // Expected:
      //
      // Best,
      // Alex Morgan
      // example.com
      //
      // Company name must not appear as part of the signature.
      // ------------------------------------------------------

      verifySignature(
        body,
        senderName,
        senderDomain
      );

      // ------------------------------------------------------
      // Step 10: Send email through Composio.
      //
      // Uses the connection_id from user_integrations.
      // ------------------------------------------------------

      const sendResult = await sendGmailEmail(
        env,
        gmail.connection_id,
        lead.email,
        subject,
        body
      );

      // ------------------------------------------------------
      // Step 11: Confirm successful execution.
      // ------------------------------------------------------

      if (!sendResult.success) {
        throw new Error(
          "Composio did not confirm successful email delivery: " +
          safeErrorText(sendResult.data)
        );
      }

      // ------------------------------------------------------
      // Step 12: Save the email body.
      //
      // Save only after Composio reports success.
      // ------------------------------------------------------

      await saveLeadMessage(
        env,
        lead.id,
        body
      );

      // ------------------------------------------------------
      // Step 13: Return success.
      // ------------------------------------------------------

      return jsonResponse({
        ok: true,
        processed: true,
        lead_id: lead.id,
        recipient: lead.email,
        subject: subject,
        sender_name: senderName,
        sender_domain: senderDomain,
        fit_status: generatedEmail.fit_status,
        message_saved: true,
        gmail_connection_id: gmail.connection_id
      });

    } catch (error) {
      console.error(
        "Outreach worker error:",
        error.message
      );

      return jsonResponse({
        ok: false,
        error: error.message || "Unexpected worker error"
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
// SUPABASE REST HELPER
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

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase error (${response.status}): ` +
      safeErrorText(data)
    );
  }

  return data;
}


// ============================================================
// FIND OLDEST PENDING LEAD
//
// No new columns are required.
//
// message IS NULL means the email body has not been saved.
// ============================================================

async function findOldestPendingLead(env) {
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
    {
      method: "GET"
    }
  );

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null;
}


// ============================================================
// GET MATCHING APPLICATION
//
// applications.name    = sender company name
// applications.company = product/company description
// applications.domain  = sender company domain
//
// planner_status is not selected or modified.
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
    {
      method: "GET"
    }
  );

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null;
}


// ============================================================
// GET CONNECTED GMAIL INTEGRATION
//
// Exact application + user + Gmail match.
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
    {
      method: "GET"
    }
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
// GENERATE PERSONALIZED EMAIL WITH SARVAM AI
// ============================================================

async function generateOutreachEmail(
  env,
  lead,
  application,
  senderName,
  senderDomain
) {
  const systemPrompt = `
You are a professional B2B outreach email writer.

Generate a concise, genuinely personalized email based on
the lead and sender company data.

SENDER DATA:
- Company name: ${application.name}
- Company description/product: ${application.company}
- Company domain: ${senderDomain}
- Sender name: ${senderName}

LEAD DATA:
- First name: ${lead.first_name || ""}
- Last name: ${lead.last_name || ""}
- Full name: ${lead.full_name || ""}
- Job title: ${lead.job_title || ""}
- Company name: ${lead.company_name || ""}
- Company domain: ${lead.company_domain || ""}
- Company website: ${lead.company_website || ""}
- Industry: ${lead.company_industry || ""}
- Company size: ${lead.company_size || ""}
- Country: ${lead.company_country || ""}
- City: ${lead.company_city || ""}
- LinkedIn: ${lead.linkedin_url || ""}

RULES:

1. Understand the sender's product and target customers.
2. Consider the lead's job title and company information.
3. Personalize the opening when supported by the available facts.
4. Do not claim that you browsed a website unless you actually did.
5. Do not invent company facts, relationships, business problems,
   product capabilities, results, or personal details.
6. Do not assume the lead's company uses Shopify unless verified.
7. If the company is not a plausible customer, use "not_a_fit".
8. If suitability is uncertain, use "needs_review".
9. Use "qualified" only when the available evidence supports a
   plausible fit.
10. If qualified, write a natural email of about 60-120 words.
11. Avoid generic phrases such as "I came across your company
    while researching" unless the context justifies them.
12. Mention the sender company name in the email body only when
    it sounds natural and relevant.
13. Use one clear, low-pressure call to action.
14. Never leave placeholders.
15. Do not include the sender company name in the signature.
16. Do not include a fake personal achievement or imply an
    existing relationship.
17. Generate a draft for sending only if fit_status is "qualified".
18. Never output Markdown code fences.
19. Return valid JSON only.

SIGNATURE:

Best,
${senderName}
${senderDomain}

The email body must end with exactly this signature.

Return this JSON structure:

{
  "fit_status": "qualified",
  "fit_reason": "Short explanation",
  "subject": "Email subject",
  "message": "Complete email body, including signature",
  "personalization_reason": "Facts used to personalize the email"
}
`;

  const userData = {
    lead: {
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
      company_city: lead.company_city,
      linkedin_url: lead.linkedin_url
    },

    sender: {
      company_name: application.name,
      company_description: application.company,
      domain: senderDomain,
      sender_name: senderName
    }
  };

  const response = await fetchWithTimeout(
    SARVAM_URL,
    {
      method: "POST",
      headers: {
        "api-subscription-key": env.SARVAM_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "sarvam-105b",
        temperature: 0.3,
        max_tokens: 1200,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content:
              "Generate an outreach email using this data:\n" +
              JSON.stringify(userData)
          }
        ]
      })
    },
    45000
  );

  const responseText = await response.text();

  let result;

  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Sarvam returned non-JSON HTTP response: ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Sarvam API error (${response.status}): ` +
      safeErrorText(result)
    );
  }

  const content =
    result?.choices?.[0]?.message?.content;

  if (!content || typeof content !== "string") {
    throw new Error(
      "Sarvam did not return generated message content"
    );
  }

  let generated;

  try {
    generated = parseModelJson(content);
  } catch {
    throw new Error(
      "Sarvam returned invalid email JSON"
    );
  }

  const allowedStatuses = [
    "qualified",
    "needs_review",
    "not_a_fit"
  ];

  if (!allowedStatuses.includes(generated.fit_status)) {
    throw new Error(
      "Sarvam returned an unsupported fit_status"
    );
  }

  if (generated.fit_status === "qualified") {
    if (!generated.subject || !generated.message) {
      throw new Error(
        "Sarvam omitted the email subject or body"
      );
    }
  }

  return generated;
}


// ============================================================
// SEND EMAIL THROUGH COMPOSIO GMAIL
// ============================================================

async function sendGmailEmail(
  env,
  connectionId,
  recipient,
  subject,
  body
) {
  const url =
    `${COMPOSIO_BASE_URL}/tools/execute/` +
    encodeURIComponent(GMAIL_TOOL);

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "x-api-key": env.COMPOSIO_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        connected_account_id: connectionId,
        version: env.COMPOSIO_GMAIL_VERSION || "latest",
        arguments: {
          recipient_email: recipient,
          subject: subject,
          body: body
        }
      })
    },
    45000
  );

  const text = await response.text();

  let result;

  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    result = {
      raw_response: text
    };
  }

  if (!response.ok) {
    return {
      success: false,
      data: {
        http_status: response.status,
        response: result
      }
    };
  }

  // Composio normally returns an execution result containing
  // success information and/or the tool output.
  //
  // A successful HTTP response alone does not necessarily
  // prove that the underlying Gmail action succeeded.

  if (
    result.successful === false ||
    result.success === false ||
    result.error
  ) {
    return {
      success: false,
      data: result
    };
  }

  // Some execution responses wrap tool data under data.
  // Check common explicit failure fields there as well.
  const toolData = result.data;

  if (
    toolData &&
    (
      toolData.successful === false ||
      toolData.success === false ||
      toolData.error
    )
  ) {
    return {
      success: false,
      data: result
    };
  }

  // Fail closed if the execution result has an explicit
  // unsuccessful status.
  const status = String(
    result.status || ""
  ).toLowerCase();

  if (
    status === "failed" ||
    status === "error"
  ) {
    return {
      success: false,
      data: result
    };
  }

  // The actual output structure depends on the Composio
  // version/tool response. Verify this response format with
  // your first test before enabling regular Cron.
  return {
    success: true,
    data: result
  };
}


// ============================================================
// SAVE EMAIL BODY TO leads.message
//
// Only save after the send action returns success.
// ============================================================

async function saveLeadMessage(
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
      "Email was sent, but the lead message was not saved. " +
      "Do not blindly retry this lead because it may cause a duplicate email."
    );
  }
}


// ============================================================
// SENDER NAME SELECTION
//
// Stable per application without a new database column.
// These are examples of fictional names, not verified identities.
// Use only an authorized sender identity.
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
      (hash * 31) +
      applicationId.charCodeAt(i)
    ) >>> 0;
  }

  return names[hash % names.length];
}


// ============================================================
// EMAIL VALIDATION
// ============================================================

function isValidEmail(email) {
  if (typeof email !== "string") {
    return false;
  }

  const value = email.trim();

  return (
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}


// ============================================================
// DOMAIN NORMALIZATION
// ============================================================

function normalizeDomain(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    let domain = value.trim();

    if (!/^https?:\/\//i.test(domain)) {
      domain = "https://" + domain;
    }

    const parsed = new URL(domain);

    return parsed.hostname
      .replace(/^www\./i, "")
      .toLowerCase();

  } catch {
    return null;
  }
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

  const expectedEnding =
    `Best,\n${senderName}\n${senderDomain}`;

  if (!normalized.endsWith(expectedEnding)) {
    throw new Error(
      "Email signature does not match the required format"
    );
  }

  // Company name must not appear in the signature itself.
  const signature = normalized.slice(
    normalized.lastIndexOf("\nBest,") + 1
  );

  if (
    signature
      .split("\n")
      .some((line, index) =>
        index > 0 &&
        line.trim().toLowerCase() ===
        "company"
      )
  ) {
    throw new Error(
      "Invalid company name in email signature"
    );
  }
}


// ============================================================
// PLACEHOLDER DETECTION
// ============================================================

function containsUnresolvedPlaceholders(value) {
  const patterns = [
    /\{\{[^}]+\}\}/,
    /\[(?:sender name|your company|your name|company name)\]/i,
    /<[^>]*(?:sender|company|domain)[^>]*>/i
  ];

  return patterns.some(pattern => pattern.test(value));
}


// ============================================================
// MODEL JSON PARSER
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

    if (start === -1 || end <= start) {
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
        "Request timed out: " + new URL(url).hostname
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}


// ============================================================
// ERROR TEXT HELPER
// ============================================================

function safeErrorText(value) {
  try {
    let text = typeof value === "string"
      ? value
      : JSON.stringify(value);

    if (!text) {
      return "Unknown error";
    }

    // Avoid returning excessively large error responses.
    return text.slice(0, 1500);

  } catch {
    return "Unknown error";
  }
}


// ============================================================
// JSON RESPONSE HELPER
// ============================================================

function jsonResponse(data, status = 200) {
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
