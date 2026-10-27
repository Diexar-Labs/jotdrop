// The person check for a new account made in Obsidian or the Android app (Eric, 27 Oct): Cloudflare Turnstile runs
// here, in the browser, and its token goes straight back to the app that asked. The token proves only that a person was here.
const back = { obsidian: 'obsidian://jotdrop-cloud?human=', android: 'jotdrop-cloud://human?token=' }[new URLSearchParams(location.search).get('client')];
const message = (text) => { document.getElementById('human-message').textContent = text; };

if (!back) message('Open this page from JotDrop in Obsidian or in the Android app.');
else {
  const { turnstileSiteKey } = await (await fetch('/api/v1/auth/providers')).json();
  if (!turnstileSiteKey) message('No check is needed. Go back to JotDrop and create your account there.');
  else {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onerror = () => message('The person check could not load. Check your connection and reload this page.');
    script.onload = () => turnstile.render('#human-check', {
      sitekey: turnstileSiteKey, theme: 'auto',
      callback: (token) => { message('Done. Back to JotDrop...'); location.href = back + encodeURIComponent(token); },
    });
    document.head.append(script);
  }
}
