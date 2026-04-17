const axios = require("axios");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WP_URL = process.env.WP_URL;
const WP_USER = process.env.WP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const POST_ID = 1616; // The cut-off post ID

async function askClaude(prompt) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );
  return response.data.content.filter(b => b.type === "text").map(b => b.text).join("");
}

async function run() {
  console.log("Regenerating full post...");

  const prompt = `Write a complete, SEO-optimized WordPress blog post about:

TOPIC: Supreme Court Likely to Reject Trump's Birthright Citizenship Executive Order
CONTEXT: During April 1, 2026 oral arguments in Trump v. Barbara, a majority of Supreme Court justices signaled they would reject Trump's executive order attempting to end birthright citizenship for children of undocumented immigrants and temporary visa holders.
PRACTICE AREA: Immigration Law
AUDIENCE: Immigrants and families across the United States

Write in a conversational, direct tone — like a knowledgeable friend who is also a lawyer. Short punchy sentences. Use "we" for the firm.

STRUCTURE (1,000-1,200 words):
- Opening paragraph: what happened and why it matters
- H2: Background: The 14th Amendment and Birthright Citizenship
- H2: What the Supreme Court Justices Said
- H2: What This Means for Your Family Right Now
- H2: What You Should Do While Waiting for the Ruling
- H2: Frequently Asked Questions
  * 3 FAQ items as: <div class="faq-item"><h3>Q?</h3><p>Answer</p></div>
- Closing CTA paragraph with "Protect your rights — we handle the rest."

INCLUDE these internal links naturally:
- <a href="https://tezlawfirm.com/immigration/">immigration services</a>
- <a href="https://tezlawfirm.com/immigration/removal-proceedings-immigration-court/">removal proceedings</a>
- <a href="https://tezlawfirm.com/contact/">free consultation</a>

END with this author box exactly:
<div class="author-box" style="background:#f5f5f5;padding:20px;margin-top:30px;border-left:4px solid #c8a96e;">
<strong>About the Author: JJ Zhang, Esq.</strong><br>
JJ Zhang is the managing attorney at Tez Law P.C. Licensed to practice in California (Bar #326666), JJ represents clients in immigration courts, federal courts, and California state courts.<br><br>
📞 <strong>626-678-8677</strong><br>
💬 Chat with Zara: <a href="https://wa.me/16266788677" target="_blank">WhatsApp</a> · <a href="https://m.me/tezlawfirm" target="_blank">Messenger</a> · <a href="https://t.me/TEZJJBot" target="_blank">Telegram</a> · <a href="https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=gh_03f700f08037" target="_blank">WeChat</a> (24/7)<br>
📋 Intake: <a href="https://link.v1ce.co/tezintake">https://link.v1ce.co/tezintake</a><br>
🌐 <a href="https://tezlawfirm.com">www.tezlawfirm.com</a><br><br>
<em>我們也會說中文 · Puede hablar español</em><br><br>
<strong>Protect your rights — we handle the rest.</strong>
</div>

END with this disclaimer:
<p style="font-size:12px;color:#666;margin-top:20px;"><em>Disclaimer: This article is for informational purposes only and does not constitute legal advice. Reading this article does not create an attorney-client relationship. Contact Tez Law P.C. at 626-678-8677 or <a href="mailto:jj@tezlawfirm.com">jj@tezlawfirm.com</a> for advice specific to your situation. Results may vary.</em></p>

END with this JSON-LD schema:
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Article","headline":"Supreme Court Likely to Reject Trump Birthright Citizenship Ban 2026","author":{"@type":"Person","name":"JJ Zhang","jobTitle":"Managing Attorney","worksFor":{"@type":"LegalService","name":"Tez Law P.C.","url":"https://tezlawfirm.com"}},"publisher":{"@type":"Organization","name":"Tez Law P.C.","url":"https://tezlawfirm.com"},"datePublished":"2026-04-15","dateModified":"2026-04-15"}
</script>

Return ONLY the HTML content, no JSON wrapper, no backticks.`;

  const fullContent = await askClaude(prompt);
  console.log("Content length:", fullContent.length);
  console.log("Has author box:", fullContent.includes("author-box"));
  console.log("Has FAQ:", fullContent.includes("faq-item"));
  console.log("Has disclaimer:", fullContent.includes("Disclaimer"));

  // Update the existing post
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64");
  const res = await axios.put(
    `${WP_URL}/wp-json/wp/v2/posts/${POST_ID}`,
    { content: fullContent },
    { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" } }
  );
  console.log("✅ Post updated! ID:", res.data.id, "Link:", res.data.link);
}

run().catch(e => console.error("Error:", e.response?.data || e.message));
