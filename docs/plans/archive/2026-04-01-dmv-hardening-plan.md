# DMV Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the DMV web app, CLI, and edge functions for 20K+ visitors and beyond -- cut loading times, fix security gaps, add proper rate limiting, clean up dead code.

**Architecture:** No structural changes. All fixes are surgical -- cache headers, input validation, lazy loading, rate limiting. The existing module graph and data flow stay the same.

**Tech Stack:** Vanilla JS (Three.js, GSAP, Canvas2D), Supabase Edge Functions (Deno), Vercel serverless, TypeScript CLI/MCP package.

---

## Session 1: Frontend Loading Quick Wins

All changes in `index.html`. Zero risk, immediate UX improvement.

### Task 1: Remove unused Google Inter font and add jsdelivr preconnect

**Files:**
- Modify: `index.html:23-25` (remove Google Fonts), `index.html:27` (add preconnect)

- [ ] **Step 1: Remove Google Fonts preconnect and stylesheet**

Replace lines 23-25 in `index.html`:

```html
  <!-- OLD: remove these three lines -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@600;700&display=swap" rel="stylesheet">
```

With:

```html
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
```

- [ ] **Step 2: Add GLB model preload**

Add after the new preconnect line (before the favicon link):

```html
  <link rel="preload" href="/models/tv1.glb" as="fetch" crossorigin>
```

- [ ] **Step 3: Add `defer` to GSAP script tags**

Change lines 207-208 from:

```html
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.2/dist/gsap.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.2/dist/ScrollTrigger.min.js"></script>
```

To:

```html
  <script defer src="https://cdn.jsdelivr.net/npm/gsap@3.12.2/dist/gsap.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/gsap@3.12.2/dist/ScrollTrigger.min.js"></script>
```

- [ ] **Step 4: Verify the page still loads correctly**

Run: `uv run python -m http.server 8080`

Open http://localhost:8080. Verify:
- Page loads without errors in console
- 3D scene renders
- Scroll animation works (GSAP still loads before module scripts)
- No Google Fonts network request in DevTools Network tab
- jsdelivr preconnect visible in DevTools (early connection)

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "perf: remove unused Google Inter font, add jsdelivr preconnect + GLB preload + defer GSAP"
```

---

### Task 2: Pause render loop when tab is hidden

**Files:**
- Modify: `js/TV.js:597-604`

- [ ] **Step 1: Add visibility pause to the render loop**

In `js/TV.js`, replace the `_render()` method body (around line 585-604). Find this block:

```javascript
    if (this.camera) {
      this.renderer.render(this.scene, this.camera);
      this._setLabelPosition();
      this.rotateCamera();
    }
    requestAnimationFrame(() => this._render());
```

Replace with:

```javascript
    if (this.camera) {
      this.renderer.render(this.scene, this.camera);
      this._setLabelPosition();
      this.rotateCamera();
    }
    requestAnimationFrame(() => {
      if (document.hidden) {
        // Tab is not visible — wait for visibility change instead of spinning
        const resume = () => {
          document.removeEventListener('visibilitychange', resume);
          this._clock.getDelta(); // discard accumulated delta
          this._render();
        };
        document.addEventListener('visibilitychange', resume);
        return;
      }
      this._render();
    });
```

- [ ] **Step 2: Test visibility pause**

Open the page, verify 3D scene renders. Switch to another tab for 5 seconds. Switch back -- scene should resume smoothly with no jump or stutter. Check DevTools Performance tab: CPU usage should drop to ~0% when tab is hidden.

- [ ] **Step 3: Commit**

```bash
git add js/TV.js
git commit -m "perf: pause Three.js render loop when tab is hidden"
```

---

### Task 3: Throttle CRT scanline redraws in idle phases

**Files:**
- Modify: `js/CRTTerminal.js:1278-1281`

- [ ] **Step 1: Throttle scanline dirty flag**

In `js/CRTTerminal.js`, find lines 1278-1281:

```javascript
    // Scanline animation: mark dirty every 3rd frame when CRT is on
    if (this.isOn && this.time % 3 === 0) {
      this.dirty = true;
    }
```

Replace with:

```javascript
    // Scanline animation: frequent during active phases, throttled when idle
    if (this.isOn) {
      const isActivePhase = this.phase <= 2.5 || this.phase === 6;
      const scanlineInterval = isActivePhase ? 3 : 30; // ~20fps active, ~2fps idle
      if (this.time % scanlineInterval === 0) {
        this.dirty = true;
      }
    }
```

- [ ] **Step 2: Test scanline behavior**

Open the page, scroll to activate the CRT. Verify:
- Boot sequence still has smooth scanline animation
- Form input phase: scanlines still visible but GPU usage drops
- After form submission (done phase): minimal canvas redraws

- [ ] **Step 3: Commit**

```bash
git add js/CRTTerminal.js
git commit -m "perf: throttle CRT scanline redraws to ~2fps in idle phases"
```

---

## Session 2: Cache Headers & Security Hardening

All changes in `vercel.json` and edge function files.

### Task 4: Add security headers and HTML caching to vercel.json

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add security headers and HTML cache rules**

Replace the entire `vercel.json` content with:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Strict-Transport-Security", "value": "max-age=31536000; includeSubDomains" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    },
    {
      "source": "/(index\\.html)?$",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" }
      ]
    },
    {
      "source": "/models/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    },
    {
      "source": "/fonts/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    },
    {
      "source": "/js/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    },
    {
      "source": "/css/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    },
    {
      "source": "/audio/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=604800" }
      ]
    },
    {
      "source": "/images/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=604800" }
      ]
    }
  ],
  "rewrites": [
    {
      "source": "/badge/:path*",
      "destination": "https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/badge/:path*"
    },
    {
      "source": "/c/:certId/:agentName",
      "destination": "/index.html"
    },
    {
      "source": "/c/:certId",
      "destination": "/index.html"
    }
  ]
}
```

- [ ] **Step 2: Verify JSON is valid**

Run: `python3 -c "import json; json.load(open('vercel.json'))"`

Expected: no output (valid JSON).

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "security: add HSTS, X-Frame-Options, nosniff headers; add HTML edge caching with stale-while-revalidate"
```

---

### Task 5: Add stale-while-revalidate to API routes and maxDuration to card.js

**Files:**
- Modify: `api/card.js:39`
- Modify: `api/og.js:84`

- [ ] **Step 1: Update card.js cache headers and add function config**

In `api/card.js`, change line 39 from:

```javascript
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
```

To:

```javascript
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400');
```

And add after the imports (after line 18):

```javascript
export const config = {
  maxDuration: 15,
};
```

- [ ] **Step 2: Add input validation to card.js**

In `api/card.js`, add validation after the destructuring on line 21. Change:

```javascript
export default async function handler(req, res) {
  const { id, name, type } = req.query;

  // No name → can't render a card (need name for visual DNA)
  if (!name) {
```

To:

```javascript
export default async function handler(req, res) {
  const { id, name, type } = req.query;

  // Validate inputs to prevent resource exhaustion
  if (name && name.length > 32) {
    res.status(400).json({ error: 'name must be 32 characters or fewer' });
    return;
  }
  if (id && id.length > 16) {
    res.status(400).json({ error: 'id must be 16 characters or fewer' });
    return;
  }
  if (type && !['individual', 'organization', 'agent'].includes(type.toLowerCase())) {
    res.status(400).json({ error: 'type must be individual, organization, or agent' });
    return;
  }

  // No name → can't render a card (need name for visual DNA)
  if (!name) {
```

- [ ] **Step 3: Update og.js cache headers and add input validation**

In `api/og.js`, change line 84 from:

```javascript
    'Cache-Control': 'public, max-age=86400, s-maxage=604800',
```

To:

```javascript
    'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
```

And add input validation after the searchParams extraction (after line 81). Change:

```javascript
  const agentName = searchParams.get('name') || '';
  // Support legacy ?id= param, but name is primary
  const certIdParam = searchParams.get('id') || '';
```

To:

```javascript
  let agentName = searchParams.get('name') || '';
  // Support legacy ?id= param, but name is primary
  let certIdParam = searchParams.get('id') || '';

  // Truncate to prevent resource exhaustion
  if (agentName.length > 32) agentName = agentName.slice(0, 32);
  if (certIdParam.length > 16) certIdParam = certIdParam.slice(0, 16);
```

- [ ] **Step 4: Commit**

```bash
git add api/card.js api/og.js
git commit -m "security: add input validation to card/og APIs; add stale-while-revalidate and maxDuration config"
```

---

### Task 6: Harden register-agent edge function

**Files:**
- Modify: `supabase/functions/register-agent/index.ts:52-89` (validation)
- Modify: `supabase/functions/register-agent/index.ts:91-97` (CORS)
- Modify: `supabase/functions/register-agent/index.ts:185-189` (429 response)

- [ ] **Step 1: Add length validation to free-text fields**

In `supabase/functions/register-agent/index.ts`, add these checks to the `validateRequest()` function. After line 66 (`if (!EMAIL_REGEX.test(email)) return 'Invalid email format'`), add:

```typescript
  if (email.length > 254) return 'email must be 254 characters or fewer'

  const operatorName = body.operator_name as string
  if (operatorName && operatorName.length > 100) {
    return 'operator_name must be 100 characters or fewer'
  }

  const orgName = body.organization_name as string
  if (orgName && orgName.length > 100) {
    return 'organization_name must be 100 characters or fewer'
  }

  const description = body.description as string
  if (description && description.length > 500) {
    return 'description must be 500 characters or fewer'
  }
```

- [ ] **Step 2: Restrict CORS origins**

Replace the CORS headers block (lines 91-97):

```typescript
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}
```

With:

```typescript
const ALLOWED_ORIGINS = [
  'https://dmv.agentcommunity.org',
  'https://agentcommunity.org',
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}
```

Then update all references from `corsHeaders` to `getCorsHeaders(req)` in the handler. The OPTIONS handler (line 135) becomes:

```typescript
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: getCorsHeaders(req) })
  }
```

And all other `{ ...corsHeaders, ... }` become `{ ...getCorsHeaders(req), ... }`.

- [ ] **Step 3: Add Retry-After header to 429 response**

Change the rate limit response (lines 186-189) from:

```typescript
    return new Response(
      JSON.stringify({ error: rateLimitError }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
```

To:

```typescript
    return new Response(
      JSON.stringify({ error: rateLimitError }),
      { status: 429, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Retry-After': '600' } },
    )
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/register-agent/index.ts
git commit -m "security: add field length validation, restrict CORS origins, add Retry-After header"
```

---

### Task 7: Increase badge cache duration

**Files:**
- Modify: `supabase/functions/badge/index.ts:186`

- [ ] **Step 1: Update cache headers**

In `supabase/functions/badge/index.ts`, find the response for valid badges (around line 184-186):

```typescript
        'Cache-Control': 'public, max-age=300',
```

Replace with:

```typescript
        'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
```

Do the same for the other Response constructor that also has `max-age=300` (the one for looked-up badges further down, around line 218-220). Same replacement.

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/badge/index.ts
git commit -m "perf: increase badge SVG cache to 1h browser / 24h CDN with stale-while-revalidate"
```

---

## Session 3: CLI/MCP Hardening

### Task 8: Add fetch timeout and retry logic to register.ts

**Files:**
- Modify: `packages/dmv-agent/src/register.ts`

- [ ] **Step 1: Add timeout and retry**

Replace the fetch block in `packages/dmv-agent/src/register.ts` (lines 43-54). Change:

```typescript
  let res: Response;
  try {
    res = await fetch(REGISTER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Network error: could not reach DMV registration service. ${(err as Error).message}`,
    );
  }

  const json = await res.json();
```

To:

```typescript
  const MAX_RETRIES = 2;
  const TIMEOUT_MS = 30_000;
  let res: Response | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      res = await fetch(REGISTER_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // Only retry on 5xx server errors
      if (res.status < 500) break;
      lastError = new Error(`Server error (HTTP ${res.status})`);
    } catch (err) {
      clearTimeout(timeout);
      const msg = (err as Error).name === 'AbortError'
        ? 'Request timed out after 30 seconds'
        : `Network error: ${(err as Error).message}`;
      lastError = new Error(msg);
    }
    // Exponential backoff before retry
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }

  if (!res || res.status >= 500) {
    throw lastError || new Error('Registration failed after retries');
  }

  let json: Record<string, unknown>;
  try {
    json = await res.json();
  } catch {
    const text = await res.text().catch(() => '');
    throw new Error(`Server returned invalid response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
```

- [ ] **Step 2: Build and verify**

Run: `cd packages/dmv-agent && pnpm build`

Expected: clean build, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/dmv-agent/src/register.ts
git commit -m "fix: add 30s fetch timeout, retry on 5xx, safe JSON parsing in register.ts"
```

---

### Task 9: Add rate limiting to MCP server and make operator_name required

**Files:**
- Modify: `packages/dmv-agent/src/mcp-server.ts:78,100-114`

- [ ] **Step 1: Add rate limiting import and operator_name to required**

In `packages/dmv-agent/src/mcp-server.ts`, add the rate limiting import at the top (after the existing imports):

```typescript
import { checkRateLimit, recordAttempt, getMachineFingerprint } from './rate-limit.js';
```

Then change the `required` array in the tool schema (line 78) from:

```typescript
        required: ['agent_name', 'email'],
```

To:

```typescript
        required: ['agent_name', 'email', 'operator_name'],
```

- [ ] **Step 2: Add rate limiting check to the register_agent handler**

In the `register_agent` handler (around line 104-114), add rate limiting before the `registerAgent` call. Change:

```typescript
    try {
      const result = await registerAgent(
        { agentName, email, operatorName, description },
        'mcp',
      );
```

To:

```typescript
    try {
      // Client-side rate limiting (same as CLI)
      const rateStatus = checkRateLimit();
      if (!rateStatus.allowed) {
        return {
          content: [{ type: 'text' as const, text: `Rate limited: ${rateStatus.used}/${rateStatus.max} registrations used in the last 24h. Try again in ${rateStatus.retryIn}.` }],
          isError: true,
        };
      }

      const fingerprint = getMachineFingerprint();
      const result = await registerAgent(
        { agentName, email, operatorName, description },
        'mcp',
        fingerprint,
      );

      // Record successful attempt
      recordAttempt(agentName);
```

And ensure `recordAttempt` is called only on success (it should be inside the try block, after the `registerAgent` call succeeds, before the return).

- [ ] **Step 3: Build and verify**

Run: `cd packages/dmv-agent && pnpm build`

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/dmv-agent/src/mcp-server.ts
git commit -m "security: add rate limiting to MCP server, make operator_name required"
```

---

### Task 10: Wrap writeLockfile in try/catch

**Files:**
- Modify: `packages/dmv-agent/src/rate-limit.ts:59-63`

- [ ] **Step 1: Add error handling to writeLockfile**

In `packages/dmv-agent/src/rate-limit.ts`, replace the `writeLockfile` function (lines 59-63):

```typescript
function writeLockfile(data: LockfileData): void {
  const path = getLockfilePath();
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}
```

With:

```typescript
function writeLockfile(data: LockfileData): void {
  try {
    const path = getLockfilePath();
    ensureDir(path);
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Non-fatal: lockfile write may fail on read-only filesystems (containers).
    // Registration already succeeded server-side. Rate limiting degrades gracefully.
  }
}
```

- [ ] **Step 2: Build and verify**

Run: `cd packages/dmv-agent && pnpm build`

- [ ] **Step 3: Commit**

```bash
git add packages/dmv-agent/src/rate-limit.ts
git commit -m "fix: wrap writeLockfile in try/catch to prevent crash on read-only filesystems"
```

---

### Task 11: Fix SKILL.md operator documentation

**Files:**
- Modify: `packages/dmv-agent/skills/dmv/SKILL.md`

- [ ] **Step 1: Check current SKILL.md content around operator**

Read the file and find where it says operator is optional. Change it to required. Update the example command to include `--operator`. This is a text edit -- find the relevant sections and make operator name clearly required.

- [ ] **Step 2: Commit**

```bash
git add packages/dmv-agent/skills/dmv/SKILL.md
git commit -m "docs: fix SKILL.md to show operator_name as required (matches CLI behavior)"
```

---

## Session 4: Web Client Hardening

### Task 12: Add fetch timeout to web registration client

**Files:**
- Modify: `js/supabase.js:37-44`

- [ ] **Step 1: Add AbortController timeout**

In `js/supabase.js`, replace the fetch call (lines 37-42):

```javascript
  try {
    const res = await fetch(REGISTER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await res.json();
```

With:

```javascript
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(REGISTER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    let json;
    try {
      json = await res.json();
    } catch {
      return { data: null, error: { message: `Server returned an unexpected response (HTTP ${res.status})` } };
    }
```

- [ ] **Step 2: Handle AbortError in the catch block**

Update the catch block (after the try) to handle timeout specifically. Change:

```javascript
  } catch (err) {
    console.error('[dmv] Network error:', err);
    return { data: null, error: { message: err.message } };
  }
```

To:

```javascript
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'Registration timed out. Please check your connection and try again.'
      : err.message;
    console.error('[dmv] Network error:', err);
    return { data: null, error: { message: msg } };
  }
```

- [ ] **Step 3: Commit**

```bash
git add js/supabase.js
git commit -m "fix: add 15s fetch timeout to web registration client"
```

---

## Session 5: Dead Code & Hygiene Cleanup

### Task 13: Delete CardPoster.js and remove dead isDomainTaken stub

**Files:**
- Delete: `js/CardPoster.js`
- Modify: `js/supabase.js:58-69` (remove stub)

- [ ] **Step 1: Delete CardPoster.js**

Run: `rm js/CardPoster.js`

Verify it is not imported anywhere:

Run: `grep -r "CardPoster" js/ index.html --include="*.js" --include="*.html"`

Expected: no results (only documentation files reference it).

- [ ] **Step 2: Remove isDomainTaken stub from supabase.js**

In `js/supabase.js`, delete lines 58-69 (the `isDomainTaken` function and its JSDoc comment).

- [ ] **Step 3: Commit**

```bash
git rm js/CardPoster.js
git add js/supabase.js
git commit -m "cleanup: remove dead CardPoster.js and isDomainTaken stub"
```

---

### Task 14: Create .vercelignore to exclude dev artifacts

**Files:**
- Create: `.vercelignore`

- [ ] **Step 1: Create .vercelignore**

Create `.vercelignore` in the project root:

```
card-lab.html
card-lab-v2.html
dev-server.mjs
scripts/
docs/
tests/
packages/
AGENTS.md
ARCHITECTURE.md
CARD.md
FUTURE.md
CODE_OF_CONDUCT.md
CONTRIBUTING.md
SECURITY.md
pnpm-workspace.yaml
.env.example
```

- [ ] **Step 2: Verify critical files are NOT excluded**

Confirm these are NOT in `.vercelignore`: `index.html`, `js/`, `css/`, `fonts/`, `models/`, `images/`, `api/`, `middleware.js`, `vercel.json`, `llms.txt`, `robots.txt`, `sitemap.xml`, `CLAUDE.md`, `README.md`, `supabase/`.

Note: `supabase/` is deployed separately via `supabase functions deploy`, not via Vercel. But keeping it in the Vercel deploy is harmless (static files only).

- [ ] **Step 3: Commit**

```bash
git add .vercelignore
git commit -m "cleanup: add .vercelignore to exclude dev artifacts from production deployment"
```

---

### Task 15: Fix Fog object leak on night mode toggle

**Files:**
- Modify: `js/TV.js:483-496`

- [ ] **Step 1: Reuse Fog instead of creating new instances**

In `js/TV.js`, replace the night mode fog swap (lines 486-496):

```javascript
    if (this.renderer.toneMappingExposure < 1) {
      target = this.toneMappingExposureMax;
      triggerPos = 0;
      this.scene.fog = new THREE.Fog(this.fogColor, 27, 29);
      this.renderer.setClearColor(this.fogColor, 1);
      this.isNightMode = false;
    } else {
      target = this.toneMappingExposureMin;
      triggerPos = 0.45;
      this.scene.fog = new THREE.Fog(this.fogColorDark, 27, 29);
      this.renderer.setClearColor(this.fogColorDark, 1);
      this.isNightMode = true;
    }
```

With:

```javascript
    if (this.renderer.toneMappingExposure < 1) {
      target = this.toneMappingExposureMax;
      triggerPos = 0;
      this.scene.fog.color.setHex(this.fogColor);
      this.renderer.setClearColor(this.fogColor, 1);
      this.isNightMode = false;
    } else {
      target = this.toneMappingExposureMin;
      triggerPos = 0.45;
      this.scene.fog.color.setHex(this.fogColorDark);
      this.renderer.setClearColor(this.fogColorDark, 1);
      this.isNightMode = true;
    }
```

- [ ] **Step 2: Test night mode toggle**

Toggle night mode multiple times. Verify fog color transitions correctly both ways and the scene looks the same as before.

- [ ] **Step 3: Commit**

```bash
git add js/TV.js
git commit -m "fix: reuse Fog object on night mode toggle instead of leaking new instances"
```

---

## Session 6: Redis Rate Limiting (Design Doc Implementation)

This is the biggest task. It implements the rate limiting architecture from `docs/plans/archive/2026-03-26-dmv-rate-limiting-design.md`.

### Task 16: Implement Redis-based rate limiting in register-agent

**Files:**
- Modify: `supabase/functions/register-agent/index.ts:99-129` (replace DB rate limiting)

- [ ] **Step 1: Add Upstash imports and Redis rate limiter**

In `supabase/functions/register-agent/index.ts`, add after the Supabase import (line 5):

```typescript
import { Redis } from 'https://esm.sh/@upstash/redis@1.35.1'
import { Ratelimit } from 'https://esm.sh/@upstash/ratelimit@2.0.6'
```

- [ ] **Step 2: Replace the checkRateLimit function**

Replace the entire `checkRateLimit` function (lines 99-129) with:

```typescript
// --- Rate limiting (Redis-backed via Upstash) ---

function createRateLimiters() {
  const redis = new Redis({
    url: Deno.env.get('UPSTASH_REDIS_REST_URL')!,
    token: Deno.env.get('UPSTASH_REDIS_REST_TOKEN')!,
  })

  return {
    perEmail: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, '10 m'),
      prefix: 'dmv:email',
    }),
    perIp: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, '10 m'),
      prefix: 'dmv:ip',
    }),
    perIpEmail: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(3, '10 m'),
      prefix: 'dmv:ip-email',
    }),
  }
}

async function checkRateLimit(
  email: string,
  ip: string,
): Promise<{ error: string | null; retryAfter?: number }> {
  const limiters = createRateLimiters()

  const emailHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))
    .then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''))
  const ipHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
    .then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''))

  // Check tightest limit first (IP+email), then per-email, then per-IP
  const ipEmailResult = await limiters.perIpEmail.limit(`${ipHash}:${emailHash}`)
  if (!ipEmailResult.success) {
    const retryAfter = Math.ceil((ipEmailResult.reset - Date.now()) / 1000)
    return { error: 'Rate limited: too many registrations from this session', retryAfter }
  }

  const emailResult = await limiters.perEmail.limit(emailHash)
  if (!emailResult.success) {
    const retryAfter = Math.ceil((emailResult.reset - Date.now()) / 1000)
    return { error: 'Rate limited: too many registrations for this email', retryAfter }
  }

  const ipResult = await limiters.perIp.limit(ipHash)
  if (!ipResult.success) {
    const retryAfter = Math.ceil((ipResult.reset - Date.now()) / 1000)
    return { error: 'Rate limited: too many registrations from this address', retryAfter }
  }

  return { error: null }
}
```

- [ ] **Step 3: Update the handler to use the new signature**

In the handler, change the rate limit call (around line 184) from:

```typescript
  const rateLimitError = await checkRateLimit(supabase, email, ip)
  if (rateLimitError) {
    return new Response(
      JSON.stringify({ error: rateLimitError }),
      { status: 429, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Retry-After': '600' } },
    )
  }
```

To:

```typescript
  const rateLimit = await checkRateLimit(email, ip)
  if (rateLimit.error) {
    return new Response(
      JSON.stringify({ error: rateLimit.error }),
      { status: 429, headers: {
        ...getCorsHeaders(req),
        'Content-Type': 'application/json',
        'Retry-After': String(rateLimit.retryAfter || 600),
      } },
    )
  }
```

Note: Move the rate limit check BEFORE the Supabase client creation so that rejected requests never create a DB connection.

- [ ] **Step 4: Add lifetime cap check after rate limits pass**

After the rate limit check passes and before the INSERT, add the lifetime cap:

```typescript
  // Lifetime cap: 3 unendorsed / 10 endorsed per email
  const { count: totalCerts } = await supabase
    .from('registrations')
    .select('*', { count: 'exact', head: true })
    .eq('email', email)
    .not('certificate_id', 'is', null)

  const CAP_UNENDORSED = 3
  const CAP_ENDORSED = 10
  const currentCount = totalCerts ?? 0

  if (currentCount >= CAP_UNENDORSED) {
    // Check if user is endorsed (any registration with endorsement_status = 'signed')
    const { data: endorsed } = await supabase
      .from('registrations')
      .select('endorsement_status')
      .eq('email', email)
      .eq('endorsement_status', 'signed')
      .limit(1)

    const cap = endorsed?.length ? CAP_ENDORSED : CAP_UNENDORSED
    if (currentCount >= cap) {
      return new Response(
        JSON.stringify({
          error: `Certificate limit reached (${cap} max). ${!endorsed?.length ? 'Endorsed members can register up to 10.' : ''}`,
          current: currentCount,
          limit: cap,
          endorsed: !!endorsed?.length,
        }),
        { status: 403, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      )
    }
  }
```

- [ ] **Step 5: Set Upstash secrets on Supabase**

This requires the actual Upstash credentials. Run (with real values):

```bash
supabase secrets set UPSTASH_REDIS_REST_URL="<url>" UPSTASH_REDIS_REST_TOKEN="<token>"
```

- [ ] **Step 6: Deploy and test**

```bash
supabase functions deploy register-agent
```

Test with curl:
```bash
curl -X POST https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"test-rate-limit","email":"test@example.com","registration_type":"AGENT"}'
```

Repeat 4 times rapidly -- 4th should return 429 with `Retry-After` header.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/register-agent/index.ts
git commit -m "feat: implement Redis-based triple rate limiting + lifetime cap per design doc"
```

---

## Not In This Plan (Tier 2 / L-effort, tracked for later)

These require larger architectural decisions or build tooling:

| Item | What | Trigger |
|------|------|---------|
| Three.js tree-shake | Custom esbuild to cut ~70% of Three.js bundle | When bandwidth costs matter (~500K visitors) |
| Self-host Three.js + GSAP | Eliminate jsdelivr SPOF | When reliability > bandwidth cost tradeoff |
| OTF → WOFF2 font conversion | ~80KB savings per visitor | Next hygiene session |
| Lazy-load HoloCard/AboutPoster | Dynamic import() for ~50KB deferred off critical path | Next perf session |
| Async tv.init() restructure | Don't block UI wiring on 2.2MB model download | Next perf session |
| Mobile CRT canvas 512x512 | Reduce GPU texture uploads on mobile | When mobile perf data shows need |
| FNV-1a 64-bit upgrade | Prevent cert ID collisions past ~23K registrations | Before 10K registrations |
| Container-stable fingerprint | Fix rate limiting in Docker/K8s environments | When agent adoption in containers grows |
