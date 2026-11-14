// Sends the sign-in email through Resend's HTTP API. Without an API key
// (local development) the link is printed to the server log instead.
export async function sendLoginEmail({ to, link, apiKey, from, fetchImpl = fetch }) {
  const subject = 'Your Painkiller Labs admin sign-in link';
  const text = `Sign in to the Painkiller Labs admin:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`;
  const html = `<p>Sign in to the Painkiller Labs admin:</p>
<p><a href="${link}" style="display:inline-block;background:#25292E;color:#fff;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:600">Sign in</a></p>
<p style="color:#616972;font-size:13px">The link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.</p>`;

  if (!apiKey) {
    console.log(`[ledger] No RESEND_API_KEY set. Sign-in link for ${to}: ${link}`);
    return;
  }
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
