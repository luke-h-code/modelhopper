# @chat-router/desktop

The Tauri 2 shell. It contains **no frontend code** — it wraps
`apps/client/dist` exactly as built for the web.

```bash
npm run desktop:dev      # from the repo root: starts Vite, opens the window
npm run desktop:build    # builds the frontend, then a .app / .dmg
```

Requires the Rust toolchain alongside Node.

## One build serves every platform

Nothing here imports `@tauri-apps/api`, and the web build must keep working
with no Tauri present. Three choices in `apps/client` are what make that hold:
`base: "./"` so assets resolve under Tauri's custom protocol as well as from a
web host, OTP sign-in rather than magic links so there is no redirect to
deep-link, and `detectSessionInUrl: false` for the same reason. If you add a
native feature, keep it behind a runtime check.

## The CSP is real here, and ships as a placeholder

Unlike a browser tab, this window enforces the policy in `tauri.conf.json`, and
`connect-src` is pinned to one Supabase project so a tampered bundle cannot
exfiltrate elsewhere.

The committed config ships `https://YOUR-PROJECT-REF.supabase.co` in both `csp`
and `devCsp`, so **a fresh clone cannot reach any backend until you put your own
ref there**. It fails as a blocked request in the webview console rather than a
build error, which reads like a broken app if you are not expecting it.
